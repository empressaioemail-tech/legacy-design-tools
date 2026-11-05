#!/usr/bin/env node
/**
 * Load ONE TxGIO Land Parcels release (one county, one StratMap year) as
 * parcel history: `source_feature` provider `txgio.parcels.<year>`.
 *
 * Usage:
 *   pnpm --filter @workspace/cad-ingest txgio-parcel-release -- \
 *     --county=48021 --file=<local stratmap22-landparcels_48021_lp.zip | dir> \
 *     [--vintage=<label>] [--reproject=3857] [--limit=N] [--apply]
 *
 * DRY RUN BY DEFAULT: parses, keys and counts; writes nothing. `--apply`
 * runs only inside a cluster Job (same rule as txgio-ingest) and writes
 * through stage-check-swap: every row to `source_feature_stage` under one
 * load_run_id, then `swapStagedCounty` with the distinct-key count, which
 * replaces only this release's rows for this county in one transaction.
 *
 * `--file` is required and local. The TxGIO data host refuses non-browser
 * clients (CloudFront 403, measured 2026-11-05) and this loader does not
 * pretend to be a browser; the operator downloads the release zip.
 * Collection ids per release: lib/source-registry TXGIO_PARCEL_RELEASES.
 */
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import shapefile from "shapefile";
import { swapStagedCounty } from "@workspace/db";

import { newCounters } from "../types";
import { isClusterJobExecution, LAPTOP_WRITE_FROZEN_MESSAGE } from "../jobPlane";
import { extractZipEntries } from "../zip";
import { assertDeclineCeiling, assertFinalDeclineCeiling, assertWgs84Prj, classifyPrj, TXGIO_ENTRY_FILTER, type TxgioFeature } from "./parse";
import { selectShapefileLayers } from "./shapefile-discover";
import {
  parcelReleaseProvider,
  releaseRowFromFeature,
  releaseYearFromLabel,
  stageReleaseRows,
  type ReleaseStageRow,
} from "./parcel-release";

const BATCH = 250;
const log = (m: string) => console.log(`[txgio-parcel-release] ${m}`);
function fail(m: string): never {
  console.error(`[txgio-parcel-release] FAILED: ${m}`);
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
  if (values.apply && limit !== undefined) fail("--apply with --limit would swap a partial release over the full one; refused");
  if (values.apply && !isClusterJobExecution(process.env)) fail(LAPTOP_WRITE_FROZEN_MESSAGE);

  const st = await stat(file).catch(() => null);
  if (!st) fail(`input not found: ${file}`);
  const workDir = await mkdtemp(join(tmpdir(), "txgio-release-"));
  const files = st.isDirectory()
    ? (await readdir(file)).map((n) => join(file, n))
    : await extractZipEntries(file, workDir, TXGIO_ENTRY_FILTER, log);
  const { layers } = selectShapefileLayers(files, undefined);
  const shp = layers[0]!;
  const vintage = values.vintage ?? basename(shp.shpFile).replace(/\.shp$/i, "");
  const year = releaseYearFromLabel(vintage) ?? fail(`cannot read a StratMap year from "${vintage}"; pass --vintage=stratmapNN-...`);
  if (!vintage.includes(county)) fail(`release "${vintage}" does not name county ${county}`);

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
  const provider = parcelReleaseProvider(year);
  const loadRunId = `txgio-parcel-release:${county}:${year}:${randomUUID()}`;
  log(`county ${county}, release ${vintage} -> ${provider}, ${values.apply ? `APPLY run ${loadRunId}` : "dry run"}`);

  const pool = values.apply ? new pg.Pool({ connectionString: process.env.DATABASE_URL }) : null;
  const db = pool ? drizzle(pool) : null;
  const counters = newCounters();
  const ctx = { year, vintage, sourceUrl: `file:${basename(file)}`, loadRunId, fetchedAt: new Date(), normalize: { reprojectFrom } };
  const keys = new Set<string>();
  let featureIndex = 0;
  let accepted = 0;
  let staged = 0;
  const withValues = { mkt: 0, taxYear: 0, yearBuilt: 0 };
  let batch: ReleaseStageRow[] = [];
  for (const layer of layers) {
    const source = await shapefile.open(layer.shpFile, layer.dbfFile, { encoding: "utf8" });
    for (;;) {
      if (limit !== undefined && accepted >= limit) break;
      const r = await source.read();
      if (r.done) break;
      counters.rowsRead += 1;
      const before = counters.declined.length;
      const row = releaseRowFromFeature(county, featureIndex++, r.value as TxgioFeature, counters, ctx);
      if (counters.declined.length !== before) assertDeclineCeiling(counters, county);
      if (!row) continue;
      accepted++;
      counters.rowsParsed += 1;
      keys.add(row.providerObjectId);
      if (row.payload.mkt_value !== null) withValues.mkt++;
      if (row.payload.tax_year !== null) withValues.taxYear++;
      if (row.payload.year_built !== null) withValues.yearBuilt++;
      batch.push(row);
      if (batch.length >= BATCH) {
        if (db) staged += await stageReleaseRows(db, batch);
        batch = [];
      }
    }
  }
  if (db && batch.length > 0) staged += await stageReleaseRows(db, batch);
  assertFinalDeclineCeiling(counters, county);

  let swap: unknown = null;
  if (db) {
    swap = await swapStagedCounty(db as never, { provider, countyFips: county, loadRunId, expectedCount: keys.size });
  }
  console.log(JSON.stringify({
    event: "txgio-parcel-release.summary",
    county, vintage, year, provider, apply: values.apply,
    featuresRead: counters.rowsRead, accepted, distinctKeys: keys.size, duplicateFeatures: accepted - keys.size,
    declined: counters.declined.length,
    withMarketValue: withValues.mkt, withTaxYear: withValues.taxYear, withYearBuilt: withValues.yearBuilt,
    staged: values.apply ? staged : 0, swap,
  }));
  await pool?.end();
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
