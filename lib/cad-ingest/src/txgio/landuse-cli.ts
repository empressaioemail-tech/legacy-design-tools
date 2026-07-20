#!/usr/bin/env node
/**
 * StratMap land-parcel DBF -> `cad_property` land-use ingest CLI.
 *
 * The "preferred, free public rail" for parcel land-use: the SAME free
 * public TxGIO/StratMap land-parcels file the `txgio-ingest` geometry
 * loader uses ALREADY carries the PTAD state category in `STAT_LAND_`.
 * This CLI reads that field out of the DBF and emits `cad_property`
 * rows so a county whose licensed CAD appraisal roll is not loaded (e.g.
 * Bexar 48029) still gets the ONE column the map choropleth and the
 * buildable-envelope district-mapping read: `property_use_code`. No
 * Open Records Request and no licensed CAD roll required - it stands on
 * the uniform public-record process every county already goes through.
 *
 * Usage:
 *   pnpm --filter @workspace/cad-ingest stratmap-landuse -- \
 *    --county=48029 \
 *     [--file=<local zip | dir | .dbf | .shp | https URL>]  # default:
 *                              #   TxGIO per-county zip (network needed)
 *     [--tax-year=2025]        # fallback when a DBF row's TAX_YEAR is blank
 *     [--vintage=<label>]      # default: DBF basename
 *     [--batch-size=1000] [--limit=N] [--dry-run]
 *   pnpm --filter @workspace/cad-ingest stratmap-landuse -- --list
 *
 * DATABASE_URL must point at the target Postgres unless --dry-run.
 *
 * Only the DBF is read (attributes only) - the .shp geometry is NOT
 * loaded here; `txgio-ingest` owns geometry. When --file is a zip/dir,
 * the .dbf is discovered next to the .shp. When --file is omitted the
 * per-county StratMap zip is downloaded (network required).
 *
 * Idempotent: rows upsert on `cad_property`'s (county_fips, prop_id,
 * tax_year) primary key (ON CONFLICT DO UPDATE), so a re-run or a
 * fresher vintage overwrites in place and never strands rows. Additive:
 * it only writes `cad_property`; the county's existing geometry rows in
 * `txgio_parcel` are untouched. The run is exit-bounded: resolve DBF +
 * parse + upsert + summary, then exit. Exit 0 on success, 1 on fatal
 * errors or zero rows parsed.
 */

import { parseArgs } from "node:util";
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import shapefile from "shapefile";
import { resolveTxgioCounty, TXGIO_COUNTIES } from "./counties";
import { normalizeStratMapLandUse, type StratMapProperties } from "./landuse";
import { TXGIO_ENTRY_FILTER } from "./parse";
import { upsertCadProperties, DEFAULT_BATCH_SIZE } from "../ingest";
import { newCounters, type CadPropertyRecord, type ParseCounters } from "../types";
import { downloadToFile, isUrl } from "../download";
import { extractZipEntries } from "../zip";

const { Pool } = pg;

function log(msg: string): void {
  console.log(`[stratmap-landuse] ${msg}`);
}

function fail(msg: string): never {
  console.error(`[stratmap-landuse] ERROR: ${msg}`);
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

/** Find the .dbf to read out of a set of files (zip entries or dir listing). */
function discoverDbf(files: string[]): string {
  const dbf = files.find((f) => /\.dbf$/i.test(f));
  if (dbf) return dbf;
  // Given a .shp, its sibling .dbf shares the stem.
  const shp = files.find((f) => /\.shp$/i.test(f));
  if (shp) return shp.replace(/\.shp$/i, ".dbf");
  fail(
    "no .dbf found in the input - expected the TxGIO per-county " +
      "land-parcels zip (shp/ entries) or an extracted shapefile's .dbf",
  );
}

async function* readLandUseRecords(
  countyFips: string,
  dbfFile: string,
  counters: ParseCounters,
  fallbackTaxYear: number | undefined,
  limit: number | undefined,
): AsyncGenerator<CadPropertyRecord> {
  // The StratMap DBFs ship a UTF-8 .cpg; read attributes only (no .shp).
  const source = await shapefile.openDbf(dbfFile, { encoding: "utf8" });
  const seen = new Set<string>();
  let featureIndex = 0;
  for (;;) {
    if (limit !== undefined && counters.rowsParsed >= limit) return;
    const result = await source.read();
    if (result.done) return;
    counters.rowsRead += 1;
    const rec = normalizeStratMapLandUse(
      countyFips,
      featureIndex,
      (result.value ?? {}) as StratMapProperties,
      counters,
      fallbackTaxYear,
    );
    featureIndex += 1;
    if (!rec) continue;
    // cad_property PK is (county_fips, prop_id, tax_year); a single
    // INSERT batch cannot update the same key twice, so drop in-file
    // duplicates (StratMap can list a prop_id across split segments).
    const key = `${rec.propId} ${rec.taxYear}`;
    if (seen.has(key)) {
      counters.duplicateRows += 1;
      continue;
    }
    seen.add(key);
    counters.rowsParsed += 1;
    yield rec;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const { values } = parseArgs({
    args,
    options: {
      county: { type: "string" },
      file: { type: "string" },
      "tax-year": { type: "string" },
      vintage: { type: "string" },
      "batch-size": { type: "string" },
      limit: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      list: { type: "boolean", default: false },
    },
  });

  if (values.list) {
    log("recognized StratMap counties (land-use -> cad_property):");
    for (const c of Object.values(TXGIO_COUNTIES)) {
      log(`  ${c.fips}  ${c.name.padEnd(11)} ${c.downloadUrl}`);
    }
    log(`total: ${Object.keys(TXGIO_COUNTIES).length}`);
    return;
  }

  if (!values.county) {
    fail(
      "usage: stratmap-landuse --county=<fips|name> [--file=<path-or-url>] " +
        "[--tax-year=NNNN] [--vintage=label] [--limit=N] [--dry-run] | " +
        "stratmap-landuse --list",
    );
  }
  const county = resolveTxgioCounty(values.county);
  if (!county) {
    const supported = Object.values(TXGIO_COUNTIES)
      .map((c) => `${c.fips} ${c.name}`)
      .join(", ");
    fail(`unknown county "${values.county}" - supported: ${supported}`);
  }
  const dryRun = values["dry-run"] ?? false;
  const databaseUrl = process.env.DATABASE_URL;
  if (!dryRun && !databaseUrl) {
    fail("DATABASE_URL must be set (or pass --dry-run to parse only)");
  }
  const fallbackTaxYear =
    values["tax-year"] !== undefined ? Number(values["tax-year"]) : undefined;
  if (fallbackTaxYear !== undefined && !Number.isInteger(fallbackTaxYear)) {
    fail(`--tax-year must be an integer, got "${values["tax-year"]}"`);
  }

  const startedAt = Date.now();

  // 1. Resolve input: default TxGIO URL -> download; zip -> extract.
  let input = values.file ?? county.downloadUrl;
  const sourceLabel = input;
  const workDir = await mkdtemp(join(tmpdir(), "stratmap-landuse-"));
  if (isUrl(input)) {
    input = await downloadToFile(input, workDir, log);
  }
  const sourceFile = basename(input);

  let dbfFile: string;
  const kind = await pathKind(input);
  if (kind === "missing") fail(`input not found: ${input}`);
  if (kind === "file" && /\.zip$/i.test(input)) {
    const files = await extractZipEntries(input, workDir, TXGIO_ENTRY_FILTER, log);
    dbfFile = discoverDbf(files);
  } else if (kind === "dir") {
    const names = await readdir(input);
    dbfFile = discoverDbf(names.map((n) => join(input, n)));
  } else if (/\.dbf$/i.test(input)) {
    dbfFile = input;
  } else if (/\.shp$/i.test(input)) {
    dbfFile = input.replace(/\.shp$/i, ".dbf");
  } else {
    fail(`unrecognized --file input (expected .zip, dir, .dbf, or .shp): ${input}`);
  }
  if ((await pathKind(dbfFile)) !== "file") fail(`.dbf not found: ${dbfFile}`);

  const vintage =
    values.vintage ?? basename(dbfFile, extname(dbfFile)).toLowerCase();
  const limit = values.limit !== undefined ? Number(values.limit) : undefined;

  log(`county=${county.fips} (${county.name}) source=${sourceLabel}`);
  log(`dbf: ${dbfFile}`);
  log(`vintage=${vintage}${fallbackTaxYear !== undefined ? ` fallback-tax-year=${fallbackTaxYear}` : ""}`);

  // 2. Parse + upsert (or drain, when --dry-run).
  const counters = newCounters();
  const records = readLandUseRecords(
    county.fips,
    dbfFile,
    counters,
    fallbackTaxYear,
    limit,
  );

  let coded = 0;
  let rowsUpserted = 0;
  if (dryRun) {
    for await (const rec of records) {
      if (rec.propertyUseCode) coded += 1;
    }
  } else {
    // Count coded rows without buffering: tee through a generator.
    async function* counting(): AsyncGenerator<CadPropertyRecord> {
      for await (const rec of records) {
        if (rec.propertyUseCode) coded += 1;
        yield rec;
      }
    }
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const db = drizzle(pool);
      const summary = await upsertCadProperties(db, counting(), {
        sourceFile,
        sourceVintage: vintage,
        batchSize:
          values["batch-size"] !== undefined
            ? Number(values["batch-size"])
            : DEFAULT_BATCH_SIZE,
        onBatch: (total) => {
          if (total % 50_000 < DEFAULT_BATCH_SIZE) log(`upserted ${total} rows...`);
        },
      });
      rowsUpserted = summary.rowsUpserted;
    } finally {
      await pool.end();
    }
  }

  // 3. Summary.
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  log("---- land-use ingest summary ----");
  log(`county:           ${county.fips} (${county.name})`);
  log(`source file:      ${sourceFile}`);
  log(`source vintage:   ${vintage}`);
  log(`rows read:        ${counters.rowsRead}`);
  log(`rows parsed:      ${counters.rowsParsed}`);
  log(`  with land-use:  ${coded} (STAT_LAND_ present)`);
  log(`  land-use null:  ${counters.rowsParsed - coded} (blank STAT_LAND_ - left null)`);
  log(`rows upserted:    ${dryRun ? "0 (dry-run)" : rowsUpserted}`);
  log(`rows skipped:     ${counters.rowsSkipped} (no Prop_ID / no TAX_YEAR)`);
  log(`duplicate rows:   ${counters.duplicateRows} (same prop+year in file)`);
  log(`duration:         ${seconds}s`);
  if (counters.skipSamples.length > 0) {
    log(`skip samples:     ${counters.skipSamples.join(" | ")}`);
  }
  if (counters.rowsParsed === 0) {
    fail("zero rows parsed - wrong file or schema drift; nothing ingested");
  }
}

main().catch((err) => {
  console.error("[stratmap-landuse] FATAL:", err);
  process.exit(1);
});
