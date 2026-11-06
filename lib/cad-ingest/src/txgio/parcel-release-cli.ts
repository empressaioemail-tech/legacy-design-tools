#!/usr/bin/env node
/**
 * Load ONE TxGIO Land Parcels release (one county, one StratMap year) as
 * parcel history: `source_feature` provider `txgio.parcels.<year>`.
 *
 * Usage:
 *   pnpm --filter @workspace/cad-ingest txgio-parcel-release -- \
 *     --county=48021 --file=<local stratmap22-landparcels_48021_lp.zip | dir> \
 *     [--vintage=<label>] [--reproject=3857] [--limit=N] [--apply]
 *   # cluster Job, a staged release instead of a local file (2026-11-06):
 *   tsx lib/cad-ingest/src/txgio/parcel-release-cli.ts --county=48021 \
 *     --url=<https://.../stratmap22-landparcels_48021_lp.zip> --sha256=<64 hex> [--reproject=3857] --apply
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

import { newCounters } from "../types";
import { isClusterJobExecution, LAPTOP_WRITE_FROZEN_MESSAGE } from "../jobPlane";
import { extractZipEntries } from "../zip";
import { fetchVerifiedRelease, releaseInputFrom, type ReleaseInput } from "./release-fetch";
import { assertDeclineCeiling, assertFinalDeclineCeiling, assertWgs84Prj, classifyPrj, propIdOf, TXGIO_ENTRY_FILTER, type TxgioFeature } from "./parse";
import { selectShapefileLayers } from "./shapefile-discover";
import {
  parcelReleaseProvider,
  releaseRowFromFeature,
  releaseYearFromLabel,
  stageReleaseRows,
  describeDbError,
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
    // `pnpm --filter ... txgio-parcel-release -- --county=...` (pnpm 10) hands the script a literal
    // "--", which parseArgs refuses as a positional; drop it (same fix as engine #561).
    args: process.argv.slice(2).filter((a) => a !== "--"),
    options: {
      county: { type: "string" },
      file: { type: "string" },
      url: { type: "string" },
      sha256: { type: "string" },
      vintage: { type: "string" },
      reproject: { type: "string" },
      limit: { type: "string" },
      apply: { type: "boolean", default: false },
    },
  });
  const county = values.county ?? fail("--county=<5-digit fips> is required");
  if (!/^\d{5}$/.test(county)) fail(`--county must be 5 digits, got ${county}`);
  let input: ReleaseInput;
  try {
    input = releaseInputFrom(values);
  } catch (e) {
    fail((e as Error).message);
  }
  if (values.reproject !== undefined && values.reproject !== "3857") fail("--reproject accepts only 3857");
  const limit = values.limit !== undefined ? Number(values.limit) : undefined;
  if (values.apply && limit !== undefined) fail("--apply with --limit would swap a partial release over the full one; refused");
  if (values.apply && !isClusterJobExecution(process.env)) fail(LAPTOP_WRITE_FROZEN_MESSAGE);

  const workDir = await mkdtemp(join(tmpdir(), "txgio-release-"));
  let file: string;
  if (input.kind === "url") {
    // A staged release (cluster Job): fetch into the Job's scratch dir and prove its sha256 first.
    const got = await fetchVerifiedRelease({ url: input.url, sha256: input.sha256, dir: workDir }).catch((e: Error) => fail(e.message));
    log(`fetched ${basename(got.path)}: ${got.bytes} bytes, sha256 ${got.sha256} (matches --sha256)`);
    file = got.path;
  } else {
    file = input.file;
  }
  const st = await stat(file).catch(() => null);
  if (!st) fail(`input not found: ${file}`);
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
  let withoutPropId = 0;
  const stage = async (rows: ReleaseStageRow[]): Promise<number> => {
    try {
      return await stageReleaseRows(db!, rows);
    } catch (e) {
      fail(`staging insert failed: ${describeDbError(e)}`);
    }
  };
  let batch: ReleaseStageRow[] = [];
  for (const layer of layers) {
    const source = await shapefile.open(layer.shpFile, layer.dbfFile, { encoding: "utf8" });
    for (;;) {
      if (limit !== undefined && accepted >= limit) break;
      const r = await source.read();
      if (r.done) break;
      counters.rowsRead += 1;
      // The release must carry an account id field this loader reads (Prop_ID or PROP_ID, parse.ts
      // propIdOf). A release whose field is named some other way would load with prop_id null on every
      // row, as 2019 and 2021 did before 2026-11-06; refuse on the first feature, before anything is
      // staged, dry run or not.
      if (featureIndex === 0 && propIdOf((r.value as TxgioFeature).properties ?? {}) === undefined) {
        fail(`PROP_ID_FIELD_MISSING: the release has neither Prop_ID nor PROP_ID; fields are ${Object.keys((r.value as TxgioFeature).properties ?? {}).join(",")}`);
      }
      const before = counters.declined.length;
      const row = releaseRowFromFeature(county, featureIndex++, r.value as TxgioFeature, counters, ctx);
      if (counters.declined.length !== before) assertDeclineCeiling(counters, county);
      if (!row) continue;
      // A feature with a blank id is real data the release publishes (StratMap 2026 Bastrop has 8, with
      // no GEO_ID either and a valid polygon); it loads with prop_id null and is counted, never invented.
      if (row.payload.prop_id == null) withoutPropId++;
      accepted++;
      counters.rowsParsed += 1;
      keys.add(row.providerObjectId);
      if (row.payload.mkt_value !== null) withValues.mkt++;
      if (row.payload.tax_year !== null) withValues.taxYear++;
      if (row.payload.year_built !== null) withValues.yearBuilt++;
      batch.push(row);
      if (batch.length >= BATCH) {
        if (db) staged += await stage(batch);
        batch = [];
      }
    }
  }
  if (db && batch.length > 0) staged += await stage(batch);
  assertFinalDeclineCeiling(counters, county);

  let swap: unknown = null;
  if (db) {
    // Loaded only on --apply: @workspace/db refuses to load without DATABASE_URL, which a dry run never needs.
    const { swapStagedCounty } = await import("@workspace/db");
    swap = await swapStagedCounty(db as never, { provider, countyFips: county, loadRunId, expectedCount: keys.size });
  }
  console.log(JSON.stringify({
    event: "txgio-parcel-release.summary",
    county, vintage, year, provider, apply: values.apply,
    featuresRead: counters.rowsRead, accepted, distinctKeys: keys.size, duplicateFeatures: accepted - keys.size,
    declined: counters.declined.length,
    withMarketValue: withValues.mkt, withTaxYear: withValues.taxYear, withYearBuilt: withValues.yearBuilt, withoutPropId,
    staged: values.apply ? staged : 0, swap,
  }));
  await pool?.end();
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
