#!/usr/bin/env node
/**
 * CAD bulk-export ingest CLI.
 *
 * Usage:
 *   pnpm --filter @workspace/cad-ingest cad-ingest -- \
 *     --county=48055 \
 *     [--file=<local file | directory | zip | https URL>] \
 *                                  # OMIT for open-fetch CADs (e.g. 48491
 *                                  #   WCAD, 48439 TAD, 48113 DCAD): the
 *                                  #   per-CAD bulk source is resolved and
 *                                  #   fetched automatically.
 *                                  #   REQUIRED for manual-download CADs
 *                                  #   (e.g. 48209 Hays — WAF-gated ZIP)
 *                                  #   and PACS counties.
 *     [--tax-year=2026]            # REQUIRED for Orion counties (48209/48491)
 *     [--vintage=<label>]          # default: derived from the file name
 *     [--owner-file=<path>]        # Orion owner file override
 *     [--land-file=<path>]         # Orion land file override (state code)
 *     [--segment-file=<path>]      # Orion segment file override
 *     [--improvement-file=<path>]  # PACS improvement-detail override
 *     [--batch-size=1000] [--limit=N] [--dry-run]
 *
 * DATABASE_URL must point at the target Postgres unless --dry-run.
 *
 * Counties: 48453 Travis (PACS), 48021 Bastrop (PACS), 48055 Caldwell
 * (PACS), 48209 Hays (Orion CSV), 48491 Williamson (Orion CSV),
 * 48439 Tarrant (TAD pipe), 48113 Dallas (DCAD certified CSV).
 *
 * bulk_primary counties (48113, 48439) MUST load via cad-export; silent
 * StratMap fallback is forbidden — use stratmap-landuse only with
 * --allow-stratmap-fallback when explicitly intended.
 *
 * The run is exit-bounded: parse + upsert + summary, then exit. Exit
 * code 0 on success (even with skipped malformed rows), 1 on fatal
 * errors or when zero rows parsed.
 */

import { parseArgs } from "node:util";
import { mkdtemp, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { resolveCounty, CAD_COUNTIES, type CadFormat } from "./counties";
import { resolveCadBulkSource } from "./sources";
import { resolveCadRollRoute } from "./routing";
import { formatSourceVintage } from "./tier";
import type { CadPropertyRecord, ParseCounters } from "./types";
import { newCounters } from "./types";
import { parsePacsExport } from "./pacs/parser";
import { classifyOrionHeader, parseOrionExport } from "./orion/parser";
import { parseTadPropertyExport } from "./vendors/tad-propertydata/parser";
import { parseDcadCertifiedExport } from "./vendors/dcad-certified/parser";
import { HeaderIndex, readCsvRows } from "./csv";
import { upsertCadProperties, DEFAULT_BATCH_SIZE } from "./ingest";
import { deriveVintage, downloadToFile, isUrl } from "./download";
import {
  extractCadDrop,
  ORION_ENTRY_FILTER,
  PACS_ENTRY_FILTER,
  TAD_ENTRY_FILTER,
  DCAD_ENTRY_FILTER,
} from "./zip";

const { Pool } = pg;

function log(msg: string): void {
  console.log(`[cad-ingest] ${msg}`);
}

function fail(msg: string): never {
  console.error(`[cad-ingest] ERROR: ${msg}`);
  process.exit(1);
}

function supportedCountyHint(): string {
  return Object.values(CAD_COUNTIES)
    .map((c) => `${c.fips} ${c.name}`)
    .join(", ");
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
  /** PACS APPRAISAL_INFO / Orion property / TAD pipe / DCAD account file. */
  propertyFile: string;
  improvementFile?: string;
  ownerFile?: string;
  landFile?: string;
  segmentFile?: string;
  /** DCAD RES_DETAIL.CSV */
  resDetailFile?: string;
  /** DCAD ACCOUNT_APPRL_YEAR.CSV */
  apprlYearFile?: string;
}

function zipEntryFilter(format: CadFormat) {
  if (format === "pacs") return PACS_ENTRY_FILTER;
  if (format === "tad-propertydata") return TAD_ENTRY_FILTER;
  if (format === "dcad-certified") return DCAD_ENTRY_FILTER;
  return ORION_ENTRY_FILTER;
}

async function discoverFiles(
  format: CadFormat,
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

  if (format === "tad-propertydata") {
    const txt = files.find((f) => /\.txt$/i.test(f));
    if (!txt) {
      fail(
        "no PropertyData .txt found in the input — expected TAD " +
          "PropertyData(Delimited) pipe file.",
      );
    }
    return { propertyFile: txt };
  }

  if (format === "dcad-certified") {
    const accountInfo = files.find((f) => /ACCOUNT_INFO\.CSV$/i.test(f));
    if (!accountInfo) {
      fail(
        "no ACCOUNT_INFO.CSV found in the input — expected DCAD certified " +
          "comma-delimited export files.",
      );
    }
    return {
      propertyFile: accountInfo,
      resDetailFile: files.find((f) => /RES_DETAIL\.CSV$/i.test(f)),
      apprlYearFile: files.find((f) => /ACCOUNT_APPRL_YEAR\.CSV$/i.test(f)),
      landFile: files.find((f) => /^LAND\.CSV$/i.test(basename(f))),
    };
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
    } else if (kind === "land" && out.landFile === undefined) {
      out.landFile = f;
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

function bulkPrimaryFailure(countyName: string, fips: string): never {
  fail(
    `${countyName} (${fips}) is bulk_primary — cad-export is the required ` +
      "source tier. Pass --file=<local export> or ensure the open-fetch " +
      "bulk source is registered. Silent StratMap fallback is forbidden; " +
      "use stratmap-landuse with --allow-stratmap-fallback only when " +
      "explicitly intended.",
  );
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
      "owner-file": { type: "string" },
      "land-file": { type: "string" },
      "segment-file": { type: "string" },
      "improvement-file": { type: "string" },
      "batch-size": { type: "string" },
      limit: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });

  if (!values.county) {
    fail(
      "usage: cad-ingest --county=<fips|name> [--file=<path-or-url>] " +
        "[--tax-year=NNNN] [--vintage=label] [--dry-run]",
    );
  }
  const county = resolveCounty(values.county);
  if (!county) {
    fail(`unknown county "${values.county}" — supported: ${supportedCountyHint()}`);
  }

  const route = resolveCadRollRoute(county.fips);
  const bulkSource = resolveCadBulkSource(county.fips);

  if (!values.file) {
    if (route.bulkPrimary && !bulkSource) {
      bulkPrimaryFailure(county.name, county.fips);
    }
    if (!bulkSource) {
      fail(
        `--file is required for ${county.name} (${county.fips}): no ` +
          "open-fetch bulk source is registered for it. Pass the local " +
          "export drop with --file=<path>.",
      );
    }
    if (bulkSource.mode === "manual-download") {
      fail(
        `${county.name} (${county.fips}) is a manual-download CAD — its ` +
          `bulk roll is not an open HTTP fetch.\n  Source page: ${bulkSource.page}\n  ${bulkSource.instructions}`,
      );
    }
  }

  const dryRun = values["dry-run"] ?? false;
  const databaseUrl = process.env.DATABASE_URL;
  if (!dryRun && !databaseUrl) {
    fail("DATABASE_URL must be set (or pass --dry-run to parse only)");
  }

  const startedAt = Date.now();
  const workDir = await mkdtemp(join(tmpdir(), "cad-ingest-"));

  let inputs: ResolvedInputs;
  let sourceFile: string;

  if (!values.file) {
    if (bulkSource?.mode === "open-fetch") {
      log(`open-fetch bulk source: ${bulkSource.datasets.length} dataset(s)`);
      const partial: Partial<ResolvedInputs> = {};
      for (const ds of bulkSource.datasets) {
        const local = await downloadToFile(ds.url, workDir, log, `${ds.kind}.csv`);
        if (ds.kind === "property") partial.propertyFile = local;
        else if (ds.kind === "owner") partial.ownerFile = local;
        else if (ds.kind === "land") partial.landFile = local;
        else if (ds.kind === "segment") partial.segmentFile = local;
      }
      if (partial.propertyFile === undefined) {
        fail("open-fetch source declared no property dataset");
      }
      inputs = partial as ResolvedInputs;
      sourceFile = basename(inputs.propertyFile);
    } else if (bulkSource?.mode === "open-fetch-zip") {
      log(`open-fetch-zip: ${bulkSource.label}`);
      let localZip: string;
      try {
        localZip = await downloadToFile(bulkSource.url, workDir, log, bulkSource.label);
      } catch (err) {
        if (route.bulkPrimary) {
          console.error("[cad-ingest] open-fetch failed:", err);
          bulkPrimaryFailure(county.name, county.fips);
        }
        throw err;
      }
      sourceFile = bulkSource.label;
      const extracted = await extractCadDrop(
        localZip,
        workDir,
        zipEntryFilter(county.format),
        log,
      );
      inputs = await discoverFiles(county.format, extracted);
    } else {
      bulkPrimaryFailure(county.name, county.fips);
    }
  } else {
    let input = values.file;
    if (isUrl(input)) {
      try {
        input = await downloadToFile(input, workDir, log);
      } catch (err) {
        if (route.bulkPrimary) {
          console.error("[cad-ingest] URL fetch failed:", err);
          bulkPrimaryFailure(county.name, county.fips);
        }
        throw err;
      }
    }
    sourceFile = basename(input);

    const kind = await pathKind(input);
    if (kind === "missing") fail(`input not found: ${input}`);
    if (kind === "file" && /\.zip$/i.test(input)) {
      const extracted = await extractCadDrop(
        input,
        workDir,
        zipEntryFilter(county.format),
        log,
      );
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
  }

  async function resolveOverride(
    value: string | undefined,
  ): Promise<string | undefined> {
    if (value === undefined) return undefined;
    return isUrl(value) ? await downloadToFile(value, workDir, log) : value;
  }
  const improvementOverride = await resolveOverride(values["improvement-file"]);
  const ownerOverride = await resolveOverride(values["owner-file"]);
  const landOverride = await resolveOverride(values["land-file"]);
  const segmentOverride = await resolveOverride(values["segment-file"]);
  if (improvementOverride) inputs.improvementFile = improvementOverride;
  if (ownerOverride) inputs.ownerFile = ownerOverride;
  if (landOverride) inputs.landFile = landOverride;
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

  const dropLabel =
    values.vintage ?? deriveVintage(values.file ?? sourceFile);
  const sourceVintage = formatSourceVintage({
    tier: "cad-export",
    adapter: route.adapterKind ?? county.format,
    drop: dropLabel,
  });
  const limit = values.limit !== undefined ? Number(values.limit) : undefined;

  log(`county=${county.fips} (${county.name} / ${county.cad}) format=${county.format}`);
  if (route.bulkPrimary) {
    log(`routing: bulk_primary preferred_tier=cad-export adapter=${route.adapterKind}`);
  }
  log(`property file: ${inputs.propertyFile}`);
  if (inputs.improvementFile) log(`improvement detail: ${inputs.improvementFile}`);
  if (inputs.resDetailFile) log(`res detail: ${inputs.resDetailFile}`);
  if (inputs.apprlYearFile) log(`apprl year: ${inputs.apprlYearFile}`);
  if (inputs.ownerFile) log(`owner file: ${inputs.ownerFile}`);
  if (inputs.landFile) log(`land file: ${inputs.landFile}`);
  if (inputs.segmentFile) log(`segment file: ${inputs.segmentFile}`);
  log(`source_vintage=${sourceVintage}${taxYearArg !== undefined ? ` tax-year=${taxYearArg}` : ""}`);

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
  } else if (county.format === "tad-propertydata") {
    records = parseTadPropertyExport(
      {
        countyFips: county.fips,
        propertyFile: inputs.propertyFile,
        limit,
      },
      counters,
    );
  } else if (county.format === "dcad-certified") {
    records = parseDcadCertifiedExport(
      {
        countyFips: county.fips,
        accountInfoFile: inputs.propertyFile,
        resDetailFile: inputs.resDetailFile,
        apprlYearFile: inputs.apprlYearFile,
        landFile: inputs.landFile,
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
        landFile: inputs.landFile,
        segmentFile: inputs.segmentFile,
        limit,
      },
      counters,
    );
  }

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
        sourceVintage,
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

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  log("---- ingest summary ----");
  log(`county:          ${county.fips} (${county.name})`);
  log(`source file:     ${sourceFile}`);
  log(`source vintage:  ${sourceVintage}`);
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
