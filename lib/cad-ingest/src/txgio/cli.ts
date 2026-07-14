#!/usr/bin/env node
/**
 * TxGIO/StratMap land-parcel ingest CLI — self-hosted parcel geometry
 * for counties without a live queryable county GIS (v1: Hays 48209,
 * Comal 48091).
 *
 * Usage:
 *   pnpm --filter @workspace/cad-ingest txgio-ingest -- \
 *     --county=48209 \
 *     [--file=<local zip | dir | .shp | https URL>]  # default: TxGIO per-county zip
 *     [--vintage=<label>]      # default: shapefile basename, e.g.
 *                              #   stratmap25-landparcels_48209_hays_202503
 *     [--batch-size=250] [--limit=N] [--dry-run]
 *
 * DATABASE_URL must point at the target Postgres unless --dry-run.
 *
 * Replace semantics: the county's existing rows are deleted before
 * the insert pass, so re-runs and fresher vintages are idempotent and
 * never strand stale rows. The run is exit-bounded: download + parse
 * + load + summary, then exit. Exit code 0 on success (even with
 * skipped malformed features), 1 on fatal errors or zero features.
 *
 * The stratmap25 shapefiles ship in GCS_WGS_1984 (verified against
 * the real Hays/Comal .prj files); the CLI hard-fails on any other
 * .prj rather than silently storing non-WGS84 coordinates.
 */

import { parseArgs } from "node:util";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import shapefile from "shapefile";
import { resolveTxgioCounty } from "./counties";
import type { TxgioParcelRecord } from "./parse";
import {
  assertWgs84Prj,
  normalizeTxgioFeature,
  TXGIO_ENTRY_FILTER,
  type TxgioFeature,
} from "./parse";
import {
  deleteCountyParcels,
  upsertTxgioParcels,
  TXGIO_DEFAULT_BATCH_SIZE,
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
    },
  });

  if (!values.county) {
    fail(
      "usage: txgio-ingest --county=<fips|name> [--file=<path-or-url>] " +
        "[--vintage=label] [--limit=N] [--dry-run]",
    );
  }
  const county = resolveTxgioCounty(values.county);
  if (!county) {
    fail(
      `unknown county "${values.county}" — supported: 48209 Hays, 48091 Comal ` +
        "(counties WITH a live county GIS are served live, not bulk-loaded)",
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

  // 2. SR guard — WGS84 geographic or refuse.
  if (prjFile && (await pathKind(prjFile)) === "file") {
    assertWgs84Prj(await readFile(prjFile, "utf8"), prjFile);
    log(`projection: GCS_WGS_1984 (${basename(prjFile)})`);
  } else {
    log("WARNING: no .prj found — assuming WGS84 per the TxGIO program spec");
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

  let featuresLoaded = 0;
  let rowsInserted = 0;
  if (dryRun) {
    for await (const _rec of records) {
      featuresLoaded += 1;
    }
  } else {
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const db = drizzle(pool);
      log(`replacing existing ${county.fips} rows`);
      await deleteCountyParcels(db, county.fips);
      const summary = await upsertTxgioParcels(db, records, {
        sourceFile,
        sourceVintage: vintage,
        batchSize:
          values["batch-size"] !== undefined
            ? Number(values["batch-size"])
            : TXGIO_DEFAULT_BATCH_SIZE,
        onBatch: (total) => {
          if (total % 25_000 < TXGIO_DEFAULT_BATCH_SIZE) {
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

  // 4. Summary.
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  log("---- ingest summary ----");
  log(`county:           ${county.fips} (${county.name})`);
  log(`source file:      ${sourceFile}`);
  log(`source vintage:   ${vintage}`);
  log(`features read:    ${counters.rowsRead}`);
  log(`features parsed:  ${counters.rowsParsed}`);
  log(`features loaded:  ${dryRun ? "0 (dry-run)" : featuresLoaded}`);
  log(`rows inserted:    ${dryRun ? "0 (dry-run)" : rowsInserted} (one per intersecting grid cell)`);
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
