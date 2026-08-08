#!/usr/bin/env node
/**
 * TxGIO/StratMap land-parcel ingest CLI — self-hosted parcel geometry
 * for the Texas map store. Any of the 254 Texas counties may be
 * ingested; `--list` shows which are already loaded and which are not.
 * (Before 2026-08-08 the CLI resolved only against the 19 loaded
 * counties and failed closed on everything else before any network
 * call, so an unloaded county could not even be dry-run. That gate
 * encoded no real constraint — the URL template and DBF schema are
 * statewide-uniform — and it blocked the statewide acquisition.)
 *
 * Usage:
 *   pnpm --filter @workspace/cad-ingest txgio-ingest -- \
 *     --county=48209 \
 *     [--file=<local zip | dir | .shp | https URL>]  # default: TxGIO per-county zip
 *     [--vintage=<label>]      # default: shapefile basename, e.g.
 *                              #   stratmap25-landparcels_48209_hays_202503
 *     [--batch-size=250] [--limit=N] [--dry-run]
 *   pnpm --filter @workspace/cad-ingest txgio-ingest -- --list
 *
 * DATABASE_URL must point at the target Postgres unless --dry-run.
 *
 * Replace semantics: the county's existing rows are deleted and the
 * new ones streamed IN ONE TRANSACTION, so re-runs and fresher
 * vintages are idempotent, never strand stale rows, and — since
 * 2026-08-08 — can never leave a county deleted-but-not-loaded when a
 * run dies partway. The run is exit-bounded: download + parse + load +
 * summary, then exit. Exit code 0 on success (even with skipped
 * malformed features), 1 on fatal errors or zero features.
 *
 * PROJECTION. Most stratmap25 shapefiles ship GCS_WGS_1984, but the
 * 202505 vintage ships Web Mercator METERS under a
 * `PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere", GEOGCS["GCS_WGS_1984",...]]`
 * whose nested GEOGCS satisfied the old substring guard. The CLI now
 * rejects a PROJCS `.prj` outright, AND every feature's coordinates are
 * range-asserted against the Texas WGS84 envelope in `parse.ts` — which
 * is the guard that actually holds, because it also covers the
 * no-`.prj` case, axis swaps, and any future source change. A county
 * that is not in degrees fails the run instead of loading garbage.
 *
 * DRY RUN PREDICTS THE APPLY. `--dry-run` parses the real archive and
 * reports the rows an apply WOULD delete and insert, so a dry/apply
 * pair is comparable. It opens a read-only DB connection when
 * DATABASE_URL is present (to count existing rows) and reports the
 * delete count as unknown when it is not. It never writes.
 */

import { parseArgs } from "node:util";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import shapefile from "shapefile";
import {
  isTxgioCountyLoaded,
  resolveTxgioCounty,
  TXGIO_ABSENT_FROM_STRATMAP,
  TXGIO_COUNTIES,
  TXGIO_STATEWIDE_COUNTIES,
} from "./counties";
import type { TxgioParcelRecord } from "./parse";
import {
  assertWgs84Prj,
  normalizeTxgioFeature,
  TXGIO_ENTRY_FILTER,
  type TxgioFeature,
} from "./parse";
import {
  countCountyParcels,
  replaceCountyParcels,
  TXGIO_DEFAULT_BATCH_SIZE,
  type TxgioTransactionalDb,
} from "./ingest";
import { newCounters, type ParseCounters } from "../types";
import { downloadToFile, isUrl } from "../download";
import { extractZipEntries } from "../zip";

const { Pool } = pg;

function log(msg: string): void {
  console.log(`[txgio-ingest] ${msg}`);
}

function fail(msg: string): never {
  console.error(`[txgio-ingest] ERROR: ${msg}`);
  process.exit(1);
}

async function pathKind(p: string): Promise<"file" | "dir" | "missing"> {
  try {
    const s = await stat(p);
    return s.isDirectory() ? "dir" : "file";
  } catch {
    return "missing";
  }
}

interface ResolvedShapefile {
  shpFile: string;
  dbfFile: string;
  prjFile?: string;
}

async function discoverShapefile(files: string[]): Promise<ResolvedShapefile> {
  const shpFile = files.find((f) => /\.shp$/i.test(f));
  if (!shpFile) {
    fail(
      "no .shp found in the input — expected the TxGIO per-county " +
        "land-parcels zip (shp/ entries) or an extracted shapefile",
    );
  }
  const stem = shpFile.replace(/\.shp$/i, "");
  const dbfFile = files.find((f) => f.toLowerCase() === `${stem.toLowerCase()}.dbf`);
  if (!dbfFile) fail(`no .dbf next to ${basename(shpFile)}`);
  const prjFile = files.find((f) => f.toLowerCase() === `${stem.toLowerCase()}.prj`);
  return { shpFile, dbfFile, prjFile };
}

async function* readTxgioFeatures(
  countyFips: string,
  shpFile: string,
  dbfFile: string,
  counters: ParseCounters,
  limit?: number,
): AsyncGenerator<TxgioParcelRecord> {
  // The TxGIO shapefiles ship a UTF-8 .cpg; pass the encoding through.
  const source = await shapefile.open(shpFile, dbfFile, { encoding: "utf8" });
  let featureIndex = 0;
  for (;;) {
    if (limit !== undefined && counters.rowsParsed >= limit) return;
    const result = await source.read();
    if (result.done) return;
    counters.rowsRead += 1;
    const record = normalizeTxgioFeature(
      countyFips,
      featureIndex,
      result.value as TxgioFeature,
      counters,
    );
    featureIndex += 1;
    if (record) {
      counters.rowsParsed += 1;
      yield record;
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const { values } = parseArgs({
    args,
    options: {
      county: { type: "string" },
      file: { type: "string" },
      vintage: { type: "string" },
      "batch-size": { type: "string" },
      limit: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      list: { type: "boolean", default: false },
    },
  });

  // --list: print every Texas county with its load state and exit
  // (no network, no DB).
  if (values.list) {
    log("Texas counties (all ingestible; LOADED = already in txgio_parcel):");
    for (const [fips, name] of Object.entries(TXGIO_STATEWIDE_COUNTIES)) {
      const state = TXGIO_ABSENT_FROM_STRATMAP[fips]
        ? "ABSENT"
        : isTxgioCountyLoaded(fips)
          ? "LOADED"
          : "-     ";
      log(`  ${fips}  ${state}  ${name}`);
    }
    log(
      `total: ${Object.keys(TXGIO_STATEWIDE_COUNTIES).length} counties, ` +
        `${Object.keys(TXGIO_COUNTIES).length} loaded, ` +
        `${Object.keys(TXGIO_ABSENT_FROM_STRATMAP).length} absent from StratMap`,
    );
    return;
  }

  if (!values.county) {
    fail(
      "usage: txgio-ingest --county=<fips|name> [--file=<path-or-url>] " +
        "[--vintage=label] [--limit=N] [--dry-run] | txgio-ingest --list",
    );
  }
  const county = resolveTxgioCounty(values.county);
  if (!county) {
    fail(
      `"${values.county}" is not a Texas county — expected a 5-digit FIPS ` +
        `(48001..48507, odd county codes) or a county name. Run --list for ` +
        "all 254.",
    );
  }
  // Named absence: a county whose StratMap archive is a confirmed 404
  // fails with an explanation rather than a transport stack trace.
  // Overridable with --file, which is exactly how such a county gets
  // loaded from a county CAD/ArcGIS export instead.
  const absentReason = TXGIO_ABSENT_FROM_STRATMAP[county.fips];
  if (absentReason && !values.file) {
    fail(
      `${county.fips} (${county.name}) is not available from StratMap: ` +
        `${absentReason}. Acquire it from the county CAD or ArcGIS and pass ` +
        "--file=<path-or-url>; there is nothing to fetch from the bulk program.",
    );
  }
  const dryRun = values["dry-run"] ?? false;
  const databaseUrl = process.env.DATABASE_URL;
  if (!dryRun && !databaseUrl) {
    fail("DATABASE_URL must be set (or pass --dry-run to parse only)");
  }

  const startedAt = Date.now();

  // 1. Resolve input: default TxGIO URL -> download; zip -> extract.
  let input = values.file ?? county.downloadUrl;
  const sourceLabel = input;
  const workDir = await mkdtemp(join(tmpdir(), "txgio-ingest-"));
  if (isUrl(input)) {
    input = await downloadToFile(input, workDir, log);
  }
  const sourceFile = basename(input);

  let files: string[];
  const kind = await pathKind(input);
  if (kind === "missing") fail(`input not found: ${input}`);
  if (kind === "file" && /\.zip$/i.test(input)) {
    files = await extractZipEntries(input, workDir, TXGIO_ENTRY_FILTER, log);
  } else if (kind === "dir") {
    const names = await readdir(input);
    files = names.map((n) => join(input, n));
  } else {
    const stem = input.replace(/\.[^.]+$/, "");
    files = [input, `${stem}.dbf`, `${stem}.prj`];
  }
  const { shpFile, dbfFile, prjFile } = await discoverShapefile(files);

  // 2. SR guard — WGS84 GEOGRAPHIC or refuse. This is the declaration
  //    check; the binding guard is the per-feature coordinate-range
  //    assertion in parse.ts, which also covers the no-.prj branch.
  if (prjFile && (await pathKind(prjFile)) === "file") {
    assertWgs84Prj(await readFile(prjFile, "utf8"), prjFile);
    log(`projection: GCS_WGS_1984 geographic (${basename(prjFile)})`);
  } else {
    log(
      "WARNING: no .prj found — the per-feature Texas WGS84 coordinate-range " +
        "assertion is the only projection guard for this run",
    );
  }

  const vintage =
    values.vintage ?? basename(shpFile, extname(shpFile)).toLowerCase();
  const limit = values.limit !== undefined ? Number(values.limit) : undefined;

  log(`county=${county.fips} (${county.name}) source=${sourceLabel}`);
  log(`shapefile: ${shpFile}`);
  log(`vintage=${vintage}`);

  // 3. Parse + load (or drain, when --dry-run).
  const counters = newCounters();
  const records = readTxgioFeatures(
    county.fips,
    shpFile,
    dbfFile,
    counters,
    limit,
  );

  const batchSize =
    values["batch-size"] !== undefined
      ? Number(values["batch-size"])
      : TXGIO_DEFAULT_BATCH_SIZE;

  let featuresLoaded = 0;
  let rowsInserted = 0;
  // Rows the county holds now; every one of them an apply would delete.
  // `null` means the dry run had no DATABASE_URL and could not count.
  let rowsExisting: number | null = null;

  if (dryRun) {
    // Parse the real archive and PREDICT the apply: features that would
    // load, rows that would be inserted (one per intersecting grid
    // cell, exactly as the loader counts them), and rows the replace
    // would delete. Read-only — no transaction, no write, and the
    // connection is opened only to run one count(*).
    let pool: pg.Pool | undefined;
    try {
      if (databaseUrl) {
        pool = new Pool({ connectionString: databaseUrl });
        rowsExisting = await countCountyParcels(
          drizzle(pool) as unknown as TxgioTransactionalDb,
          county.fips,
        );
      }
      for await (const rec of records) {
        featuresLoaded += 1;
        rowsInserted += rec.tileKeys.length;
      }
    } finally {
      await pool?.end();
    }
  } else {
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const db = drizzle(pool) as unknown as TxgioTransactionalDb;
      rowsExisting = await countCountyParcels(db, county.fips);
      log(
        `replacing existing ${county.fips} rows (${rowsExisting} present) ` +
          "— delete + load run in ONE transaction",
      );
      const summary = await replaceCountyParcels(db, county.fips, records, {
        sourceFile,
        sourceVintage: vintage,
        batchSize,
        onBatch: (total) => {
          if (total % 25_000 < batchSize) {
            log(`inserted ${total} rows...`);
          }
        },
      });
      featuresLoaded = summary.featuresLoaded;
      rowsInserted = summary.rowsInserted;
    } finally {
      await pool.end();
    }
  }

  // 4. Summary. The dry-run and apply lines are the SAME quantities so
  //    a dry/apply pair can be diffed directly.
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const wouldOrDid = dryRun ? "would " : "";
  const deleteCount = rowsExisting === null ? "unknown (no DATABASE_URL)" : rowsExisting;
  log(`---- ingest summary${dryRun ? " (DRY RUN — nothing written)" : ""} ----`);
  log(`county:           ${county.fips} (${county.name})`);
  log(`loaded before:    ${isTxgioCountyLoaded(county.fips) ? "yes" : "no"}`);
  log(`source file:      ${sourceFile}`);
  log(`source vintage:   ${vintage}`);
  log(`features read:    ${counters.rowsRead}`);
  log(`features parsed:  ${counters.rowsParsed}`);
  log(`features ${wouldOrDid}load: ${featuresLoaded}`);
  log(`rows ${wouldOrDid}delete:  ${deleteCount}`);
  log(
    `rows ${wouldOrDid}insert:  ${rowsInserted} (one per intersecting grid cell)`,
  );
  log(`features skipped: ${counters.rowsSkipped} (no polygon geometry)`);
  log(`duration:         ${seconds}s`);
  if (counters.skipSamples.length > 0) {
    log(`skip samples:     ${counters.skipSamples.join(" | ")}`);
  }
  if (counters.rowsParsed === 0) {
    fail("zero features parsed — wrong file or schema drift; nothing ingested");
  }
}

main().catch((err) => {
  console.error("[txgio-ingest] FATAL:", err);
  process.exit(1);
});
