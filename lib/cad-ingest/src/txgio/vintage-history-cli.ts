#!/usr/bin/env node
/**
 * Load ONE TxGIO Land Parcels release (one county, one StratMap year) into
 * the append-only parcel history table `txgio_parcel_vintage`.
 *
 * Usage:
 *   pnpm --filter @workspace/cad-ingest txgio-vintage-history -- \
 *     --county=48021 --file=<local stratmap22-landparcels_48021_lp.zip | dir> \
 *     [--vintage=<label>] [--reproject=3857] [--limit=N] [--apply]
 *
 * DRY RUN BY DEFAULT: parses and counts, writes nothing. `--apply` inserts,
 * and only inside a cluster Job on the job plane (same rule as txgio-ingest);
 * a laptop apply is refused before any file is read.
 *
 * `--file` is required and local. The TxGIO data host refuses non-browser
 * clients (CloudFront 403, measured 2026-11-05) and this loader does not
 * pretend to be a browser; the operator downloads the release zip.
 * Release URLs, Bastrop 48021 (api.tnris.org/api/v1/resources, 2026-11-05):
 *   2019 .../2679b514-bb7b-409f-97f3-ee3879f34448/resources/stratmap19-landparcels_48021_lp.zip
 *   2021 .../a3c04828-1036-481b-b1e0-bb456c3cbcf4/resources/stratmap21-landparcels_48021_lp.zip
 *   2022 .../a6a703ba-df8b-4d1b-8d4c-ece8ae786505/resources/stratmap22-landparcels_48021_lp.zip
 *   2023 .../55eb0be8-6d05-4536-bf75-45f1dd31dd94/resources/stratmap23-landparcels_48021_lp.zip
 *   2024 .../d0f7da13-ab09-4994-a16f-d52589e2476e/resources/stratmap24-landparcels_48021_lp.zip
 *   2025 .../0fa04328-872e-481c-b453-126a74777593/resources/stratmap25-landparcels_48021_lp.zip
 *   2026 .../1d33dafb-6e9c-40ac-887d-f4577909ed9b/resources/stratmap26-landparcels_48021_lp.zip
 *   (host https://data.geographic.texas.gov)
 *
 * Append-only: a vintage already loaded inserts nothing on re-run.
 * `txgio_parcel` (the current vintage) is never touched.
 */
import { parseArgs } from "node:util";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import shapefile from "shapefile";
import type { TxgioParcelVintageInsert } from "@workspace/db/schema";

import { newCounters } from "../types";
import { isClusterJobExecution, LAPTOP_WRITE_FROZEN_MESSAGE } from "../jobPlane";
import { extractZipEntries } from "../zip";
import { assertDeclineCeiling, assertFinalDeclineCeiling, assertWgs84Prj, classifyPrj, TXGIO_ENTRY_FILTER, type TxgioFeature } from "./parse";
import { selectShapefileLayers } from "./shapefile-discover";
import { historyRowFromFeature, insertVintageRows, vintageYearFromLabel } from "./vintage-history";

const BATCH = 250;
const log = (m: string) => console.log(`[txgio-vintage-history] ${m}`);
function fail(m: string): never {
  console.error(`[txgio-vintage-history] FAILED: ${m}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      county: { type: "string" },
      file: { type: "string" },
      vintage: { type: "string" },
      reproject: { type: "string" },
      limit: { type: "string" },
      apply: { type: "boolean", default: false },
    },
  });
  const county = values.county ?? fail("--county=<5-digit fips> is required");
  if (!/^\d{5}$/.test(county)) fail(`--county must be 5 digits, got ${county}`);
  const file = values.file ?? fail("--file=<local release zip or dir> is required (the TxGIO host refuses non-browser downloads)");
  if (values.reproject !== undefined && values.reproject !== "3857") fail("--reproject accepts only 3857");
  const limit = values.limit !== undefined ? Number(values.limit) : undefined;
  if (values.apply && !isClusterJobExecution(process.env)) fail(LAPTOP_WRITE_FROZEN_MESSAGE);

  const st = await stat(file).catch(() => null);
  if (!st) fail(`input not found: ${file}`);
  const workDir = await mkdtemp(join(tmpdir(), "txgio-vintage-"));
  const files = st.isDirectory()
    ? (await readdir(file)).map((n) => join(file, n))
    : await extractZipEntries(file, workDir, TXGIO_ENTRY_FILTER, log);
  const { layers } = selectShapefileLayers(files, undefined);
  const shp = layers[0]!;
  const label = values.vintage ?? basename(shp.shpFile).replace(/\.shp$/i, "");
  const year = vintageYearFromLabel(label) ?? fail(`cannot read a StratMap year from "${label}"; pass --vintage=stratmapNN-...`);
  if (!label.includes(county)) fail(`release "${label}" does not name county ${county}`);

  let reprojectFrom: "EPSG:3857" | undefined;
  if (shp.prjFile) {
    const prj = await readFile(shp.prjFile, "utf8");
    if (classifyPrj(prj) === "web-mercator") {
      if (values.reproject !== "3857") fail(`${basename(shp.prjFile)} is EPSG:3857; re-run with --reproject=3857`);
      reprojectFrom = "EPSG:3857";
    } else {
      assertWgs84Prj(prj, shp.prjFile);
    }
  }
  log(`county ${county}, release ${label} (year ${year}), ${values.apply ? "APPLY" : "dry run"}`);

  const pool = values.apply ? new pg.Pool({ connectionString: process.env.DATABASE_URL }) : null;
  const db = pool ? drizzle(pool) : null;
  const counters = newCounters();
  const ctx = { sourceVintage: label, vintageYear: year, sourceFile: basename(file), normalize: { reprojectFrom } };
  let featureIndex = 0;
  let parsed = 0;
  let inserted = 0;
  const withValues = { mkt: 0, taxYear: 0, yearBuilt: 0 };
  let batch: TxgioParcelVintageInsert[] = [];
  for (const layer of layers) {
    const source = await shapefile.open(layer.shpFile, layer.dbfFile, { encoding: "utf8" });
    for (;;) {
      if (limit !== undefined && parsed >= limit) break;
      const r = await source.read();
      if (r.done) break;
      counters.rowsRead += 1;
      const before = counters.declined.length;
      const row = historyRowFromFeature(county, featureIndex++, r.value as TxgioFeature, counters, ctx);
      if (counters.declined.length !== before) assertDeclineCeiling(counters, county);
      if (!row) continue;
      parsed++;
      counters.rowsParsed += 1;
      if (row.mktValue !== null) withValues.mkt++;
      if (row.taxYear !== null) withValues.taxYear++;
      if (row.yearBuilt !== null) withValues.yearBuilt++;
      batch.push(row);
      if (batch.length >= BATCH) {
        if (db) inserted += await insertVintageRows(db, batch);
        batch = [];
      }
    }
  }
  if (db && batch.length > 0) inserted += await insertVintageRows(db, batch);
  assertFinalDeclineCeiling(counters, county);
  console.log(JSON.stringify({
    event: "txgio-vintage-history.summary",
    county, label, year, apply: values.apply,
    featuresRead: counters.rowsRead, rowsParsed: parsed, declined: counters.declined.length,
    withMarketValue: withValues.mkt, withTaxYear: withValues.taxYear, withYearBuilt: withValues.yearBuilt,
    rowsInserted: values.apply ? inserted : 0,
  }));
  await pool?.end();
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
