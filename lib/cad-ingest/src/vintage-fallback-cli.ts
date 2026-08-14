/**
 * CLI: upsert named CAD prior-vintage fallback entries from CSV.
 *
 * Required columns:
 * county_fips,requested_prop_id,declared_tax_year,fallback_prop_id,
 * fallback_tax_year,method,evidence_class
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  upsertCadVintageFallback,
  type CadFallbackRecord,
} from "./vintage-fallback.js";

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  return (
    process.argv
      .slice(2)
      .find((a) => a.startsWith(prefix))
      ?.slice(prefix.length) ?? null
  );
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = (lines[0] ?? "").split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = line.split(",");
    return Object.fromEntries(
      header.map((h, i) => [h, (cols[i] ?? "").trim()]),
    );
  });
}

async function main(): Promise<void> {
  const file = argValue("file");
  const dryRun = process.argv.includes("--dry-run");
  if (!file) throw new Error("FAIL CLOSED: --file=path.csv is required");

  const sourceVintage =
    argValue("source-vintage") ?? "l21-tarrant-named-fallback";
  const raw = parseCsv(readFileSync(resolve(file), "utf8"));
  const rows: CadFallbackRecord[] = raw.map((r) => ({
    countyFips: r.county_fips ?? "",
    requestedPropId: r.requested_prop_id ?? "",
    declaredTaxYear: Number(r.declared_tax_year),
    fallbackPropId: r.fallback_prop_id ?? "",
    fallbackTaxYear: Number(r.fallback_tax_year),
    method: r.method ?? "",
    evidenceClass: r.evidence_class ?? "",
    sourceFile: file,
    sourceVintage,
  }));

  // Validation happens inside the shared upsert helper; dry-run uses the
  // same validations with a no-op insert surface.
  console.log(`[cad-vintage-fallback] parsed ${rows.length} rows from ${file}`);
  if (dryRun) {
    for (const row of rows) {
      if (
        !/^\d{5}$/.test(row.countyFips) ||
        !row.requestedPropId ||
        !row.fallbackPropId ||
        row.method !== "named-fallback-2025" ||
        !row.evidenceClass ||
        row.declaredTaxYear === row.fallbackTaxYear
      ) {
        throw new Error(
          `invalid named CAD fallback row: ${JSON.stringify(row)}`,
        );
      }
    }
    console.log("[cad-vintage-fallback] dry-run; no write");
    return;
  }

  const url = process.env.DATABASE_URL ?? process.env.DEPLOYMENT_DATABASE_URL;
  if (!url) {
    throw new Error(
      "FAIL CLOSED: DATABASE_URL or DEPLOYMENT_DATABASE_URL required",
    );
  }
  const pool = new pg.Pool({ connectionString: url });
  try {
    const n = await upsertCadVintageFallback(drizzle(pool), rows);
    console.log(`[cad-vintage-fallback] upserted ${n}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
