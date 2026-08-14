/**
 * CLI: upsert CAD vintage crosswalk rows from CSV.
 *
 * Required columns:
 *   county_fips,from_tax_year,from_prop_id,to_tax_year,to_prop_id,method,evidence_class
 *
 * Usage:
 *   pnpm --filter @workspace/cad-ingest cad-vintage-crosswalk -- \
 *     --file=P:/tmp/l21_tarrant_whitespace_seed.csv
 *
 * Dry-run (parse + validate only):
 *   ... --dry-run
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  upsertCadVintageCrosswalk,
  type CadCrosswalkRecord,
} from "./vintage-crosswalk.js";

function parseArgs(argv: string[]): {
  file: string | null;
  dryRun: boolean;
  sourceFile: string;
  sourceVintage: string;
} {
  let file: string | null = null;
  let dryRun = false;
  let sourceFile = "stdin-or-arg";
  let sourceVintage = "l21-crosswalk";
  for (const a of argv) {
    if (a === "--dry-run") dryRun = true;
    else if (a.startsWith("--file=")) {
      file = a.slice("--file=".length);
      sourceFile = file;
    } else if (a.startsWith("--source-vintage=")) {
      sourceVintage = a.slice("--source-vintage=".length);
    }
  }
  return { file, dryRun, sourceFile, sourceVintage };
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = (lines[0] ?? "").split(",").map((h) => h.trim());
  const out: Record<string, string>[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    const row: Record<string, string> = {};
    header.forEach((h, i) => {
      row[h] = (cols[i] ?? "").trim();
    });
    out.push(row);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error("FAIL CLOSED: --file=path.csv is required");
    process.exit(2);
  }
  const text = readFileSync(resolve(args.file), "utf8");
  const raw = parseCsv(text);
  const rows: CadCrosswalkRecord[] = [];
  for (const r of raw) {
    const countyFips = r.county_fips ?? "";
    const fromPropId = r.from_prop_id ?? "";
    const toPropId = r.to_prop_id ?? "";
    const fromTaxYear = Number(r.from_tax_year);
    const toTaxYear = Number(r.to_tax_year);
    const method = r.method ?? "";
    const evidenceClass = r.evidence_class ?? "";
    if (!/^\d{5}$/.test(countyFips)) {
      throw new Error(`bad county_fips: ${JSON.stringify(countyFips)}`);
    }
    if (!Number.isFinite(fromTaxYear) || !Number.isFinite(toTaxYear)) {
      throw new Error(`bad tax years for ${fromPropId}`);
    }
    if (!fromPropId || !toPropId || !method || !evidenceClass) {
      throw new Error(`incomplete row: ${JSON.stringify(r)}`);
    }
    rows.push({
      countyFips,
      fromTaxYear,
      fromPropId,
      toTaxYear,
      toPropId,
      method,
      evidenceClass,
      sourceFile: args.sourceFile,
      sourceVintage: args.sourceVintage,
    });
  }
  console.log(`[cad-vintage-crosswalk] parsed ${rows.length} rows from ${args.file}`);
  if (args.dryRun) {
    console.log("[cad-vintage-crosswalk] dry-run; no write");
    return;
  }
  const url = process.env.DATABASE_URL ?? process.env.DEPLOYMENT_DATABASE_URL;
  if (!url) {
    console.error("FAIL CLOSED: DATABASE_URL or DEPLOYMENT_DATABASE_URL required");
    process.exit(2);
  }
  const pool = new pg.Pool({ connectionString: url });
  try {
    const db = drizzle(pool);
    const n = await upsertCadVintageCrosswalk(db, rows);
    console.log(`[cad-vintage-crosswalk] upserted ${n}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
