#!/usr/bin/env node
/**
 * CAD bulk-export ingest CLI.
 *
 * Usage:
 *   pnpm --filter @workspace/cad-ingest cad-ingest -- \
 *     --county=48055 \
 *     --file=<local file | directory | zip | https URL> \
 *     [--tax-year=2026]            # REQUIRED for Orion counties (48209/48491)
 *     [--vintage=<label>]          # default: derived from the file name
 *     [--owner-file=<path>]        # Orion owner file override
 *     [--segment-file=<path>]      # Orion segment file override
 *     [--improvement-file=<path>]  # PACS improvement-detail override
 *     [--batch-size=1000] [--limit=N] [--dry-run]
 *
 * DATABASE_URL must point at the target Postgres unless --dry-run.
 *
 * Counties: 48453 Travis (PACS), 48021 Bastrop (PACS), 48055 Caldwell
 * (PACS), 48209 Hays (Orion CSV), 48491 Williamson (Orion CSV via the
 * data.wcad.org Socrata portal — see src/counties.ts for the bulk CSV
 * endpoints).
 *
 * The run is exit-bounded: parse + upsert + summary, then exit. Exit
 * code 0 on success (even with skipped malformed rows), 1 on fatal
 * errors or when zero rows parsed.
 */

import { parseArgs } from "node:util";
import { mkdtemp, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { resolveCounty } from "./counties";
import type { CadPropertyRecord, ParseCounters } from "./types";
import { newCounters } from "./types";
import { parsePacsExport } from "./pacs/parser";
import { classifyOrionHeader, parseOrionExport } from "./orion/parser";
import { HeaderIndex, readCsvRows } from "./csv";
import { upsertCadProperties, DEFAULT_BATCH_SIZE } from "./ingest";
import { deriveVintage, downloadToFile, isUrl } from "./download";
import { extractCadDrop, ORION_ENTRY_FILTER, PACS_ENTRY_FILTER } from "./zip";

const { Pool } = pg;

function log(msg: string): void {
  console.log(`[cad-ingest] ${msg}`);
}

function fail(msg: string): never {
  console.error(`[cad-ingest] ERROR: ${msg}`);
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

async function readHeader(filePath: string): Promise<HeaderIndex | null> {
  for await (const row of readCsvRows(filePath)) {
    return new HeaderIndex(row);
  }
  return null;
}

interface ResolvedInputs {
  /** PACS APPRAISAL_INFO / Orion property file. */
  propertyFile: string;
  improvementFile?: string;
  ownerFile?: string;
  segmentFile?: string;
}

async function discoverFiles(
  format: "pacs" | "orion",
  files: string[],
): Promise<ResolvedInputs> {
  if (format === "pacs") {
    const info = files.find((f) => /APPRAISAL_INFO\.TXT$/i.test(f));
    if (!info) {
      fail(
        "no *APPRAISAL_INFO.TXT found in the input. PACS counties need the " +
          "CAD's appraisal-export drop (e.g. Bastrop's DATA-EXPORT-*.zip, " +
          "not the vendor-copy TSV zip).",
      );
    }
    const detail = files.find((f) =>
      /APPRAISAL_IMPROVEMENT_DETAIL\.TXT$/i.test(f),
    );
    return { propertyFile: info, improvementFile: detail };
  }
  // Orion: classify by header columns.
  const out: Partial<ResolvedInputs> = {};
  for (const f of files) {
    if (!/\.(txt|csv)$/i.test(f)) continue;
    const header = await readHeader(f);
    if (header === null) continue;
    const kind = classifyOrionHeader(header);
    if (kind === "property" && out.propertyFile === undefined) {
      out.propertyFile = f;
    } else if (kind === "owner" && out.ownerFile === undefined) {
      out.ownerFile = f;
    } else if (kind === "segment" && out.segmentFile === undefined) {
      out.segmentFile = f;
    }
  }
  if (out.propertyFile === undefined) {
    fail(
      "no Orion property file found in the input (expected a CSV with " +
        "PropertyID/MarketValue/Situs columns).",
    );
  }
  return out as ResolvedInputs;
}

async function main(): Promise<void> {
  // pnpm forwards the `--` separator into argv; drop it so parseArgs
  // does not treat everything after it as positionals.
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const { values } = parseArgs({
    args,
    options: {
      county: { type: "string" },
      file: { type: "string" },
      "tax-year": { type: "string" },
      vintage: { type: "string" },
      "owner-file": { type: "string" },
      "segment-file": { type: "string" },
      "improvement-file": { type: "string" },
      "batch-size": { type: "string" },
      limit: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });

  if (!values.county || !values.file) {
    fail(
      "usage: cad-ingest --county=<fips|name> --file=<path-or-url> " +
        "[--tax-year=NNNN] [--vintage=label] [--dry-run]",
    );
  }
  const county = resolveCounty(values.county);
  if (!county) {
    fail(
      `unknown county "${values.county}" — supported: 48453 Travis, ` +
        "48021 Bastrop, 48055 Caldwell, 48209 Hays, 48491 Williamson",
    );
  }
  const dryRun = values["dry-run"] ?? false;
  const databaseUrl = process.env.DATABASE_URL;
  if (!dryRun && !databaseUrl) {
    fail("DATABASE_URL must be set (or pass --dry-run to parse only)");
  }

  const startedAt = Date.now();

  // 1. Resolve input: URL -> download; zip -> extract; dir -> discover.
  let input = values.file;
  const workDir = await mkdtemp(join(tmpdir(), "cad-ingest-"));
  if (isUrl(input)) {
    input = await downloadToFile(input, workDir, log);
  }
  const sourceFile = basename(input);

  let inputs: ResolvedInputs;
  const kind = await pathKind(input);
  if (kind === "missing") fail(`input not found: ${input}`);
  if (kind === "file" && /\.zip$/i.test(input)) {
    const filter = county.format === "pacs" ? PACS_ENTRY_FILTER : ORION_ENTRY_FILTER;
    const extracted = await extractCadDrop(input, workDir, filter, log);
    inputs = await discoverFiles(county.format, extracted);
  } else if (kind === "dir") {
    const names = await readdir(input);
    inputs = await discoverFiles(
      county.format,
      names.map((n) => join(input, n)),
    );
  } else {
    inputs = { propertyFile: input };
  }
  // Override files accept URLs exactly like --file does (they used to
  // be passed through verbatim and ENOENT on URLs).
  async function resolveOverride(
    value: string | undefined,
  ): Promise<string | undefined> {
    if (value === undefined) return undefined;
    return isUrl(value) ? await downloadToFile(value, workDir, log) : value;
  }
  const improvementOverride = await resolveOverride(values["improvement-file"]);
  const ownerOverride = await resolveOverride(values["owner-file"]);
  const segmentOverride = await resolveOverride(values["segment-file"]);
  if (improvementOverride) inputs.improvementFile = improvementOverride;
  if (ownerOverride) inputs.ownerFile = ownerOverride;
  if (segmentOverride) inputs.segmentFile = segmentOverride;

  const taxYearArg =
    values["tax-year"] !== undefined ? Number(values["tax-year"]) : undefined;
  if (taxYearArg !== undefined && !Number.isInteger(taxYearArg)) {
    fail(`--tax-year must be an integer, got "${values["tax-year"]}"`);
  }
  if (county.format === "orion" && taxYearArg === undefined) {
    fail(
      `--tax-year is required for ${county.name} (Orion exports do not ` +
        "carry the roll year in-row; it is in the drop's name)",
    );
  }

  const vintage = values.vintage ?? deriveVintage(values.file);
  const limit = values.limit !== undefined ? Number(values.limit) : undefined;

  log(`county=${county.fips} (${county.name} / ${county.cad}) format=${county.format}`);
  log(`property file: ${inputs.propertyFile}`);
  if (inputs.improvementFile) log(`improvement detail: ${inputs.improvementFile}`);
  if (inputs.ownerFile) log(`owner file: ${inputs.ownerFile}`);
  if (inputs.segmentFile) log(`segment file: ${inputs.segmentFile}`);
  log(`vintage=${vintage}${taxYearArg !== undefined ? ` tax-year=${taxYearArg}` : ""}`);

  // 2. Parse.
  const counters: ParseCounters = newCounters();
  let records: AsyncGenerator<CadPropertyRecord, ParseCounters>;
  if (county.format === "pacs") {
    records = parsePacsExport(
      {
        countyFips: county.fips,
        infoFile: inputs.propertyFile,
        improvementDetailFile: inputs.improvementFile,
        limit,
      },
      counters,
    );
  } else {
    records = parseOrionExport(
      {
        countyFips: county.fips,
        propertyFile: inputs.propertyFile,
        taxYear: taxYearArg as number,
        ownerFile: inputs.ownerFile,
        segmentFile: inputs.segmentFile,
        limit,
      },
      counters,
    );
  }

  // 3. Upsert (or drain, when --dry-run).
  let rowsUpserted = 0;
  if (dryRun) {
    for await (const _rec of records) {
      // parse-only
    }
  } else {
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const db = drizzle(pool);
      const summary = await upsertCadProperties(db, records, {
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

  // 4. Summary.
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  log("---- ingest summary ----");
  log(`county:          ${county.fips} (${county.name})`);
  log(`source file:     ${sourceFile}`);
  log(`source vintage:  ${vintage}`);
  log(`rows read:       ${counters.rowsRead}`);
  log(`rows parsed:     ${counters.rowsParsed}`);
  log(`rows upserted:   ${dryRun ? "0 (dry-run)" : rowsUpserted}`);
  log(`rows skipped:    ${counters.rowsSkipped} (malformed)`);
  log(`duplicate rows:  ${counters.duplicateRows} (same prop+year in file)`);
  log(`duration:        ${seconds}s`);
  if (counters.skipSamples.length > 0) {
    log(`skip samples:    ${counters.skipSamples.join(" | ")}`);
  }
  if (counters.rowsParsed === 0) {
    fail("zero rows parsed — wrong file or layout drift; nothing ingested");
  }
}

main().catch((err) => {
  console.error("[cad-ingest] FATAL:", err);
  process.exit(1);
});
