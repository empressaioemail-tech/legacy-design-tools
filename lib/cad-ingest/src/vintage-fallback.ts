/**
 * Upsert explicit prior-vintage fallback entries (L21 follow-up 3 / P-25).
 *
 * The entries authorize a named fallback; they do not themselves read CAD
 * rows or alter the county declaration. Reads still go through vintage.ts.
 */

import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { cadPropertyVintageFallback } from "@workspace/db";

export type CadFallbackDb = Pick<
  NodePgDatabase<Record<string, unknown>>,
  "insert"
>;

export interface CadFallbackRecord {
  countyFips: string;
  requestedPropId: string;
  declaredTaxYear: number;
  fallbackPropId: string;
  fallbackTaxYear: number;
  method: string;
  evidenceClass: string;
  sourceFile: string;
  sourceVintage: string;
}

export async function upsertCadVintageFallback(
  database: CadFallbackDb,
  rows: CadFallbackRecord[],
  batchSize = 2_000,
): Promise<number> {
  if (rows.length === 0) return 0;
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error(
      `cad fallback batchSize must be positive, got ${batchSize}`,
    );
  }

  const clean = rows.map((r) => {
    if (
      !/^\d{5}$/.test(r.countyFips) ||
      !r.requestedPropId ||
      !r.fallbackPropId ||
      !Number.isInteger(r.declaredTaxYear) ||
      !Number.isInteger(r.fallbackTaxYear) ||
      r.declaredTaxYear === r.fallbackTaxYear ||
      r.method !== "named-fallback-2025" ||
      !r.evidenceClass ||
      !r.sourceFile ||
      !r.sourceVintage
    ) {
      throw new Error(`invalid named CAD fallback row: ${JSON.stringify(r)}`);
    }
    return r;
  });

  for (let i = 0; i < clean.length; i += batchSize) {
    const batch = clean.slice(i, i + batchSize);
    await database
      .insert(cadPropertyVintageFallback)
      .values(batch)
      .onConflictDoUpdate({
        target: [
          cadPropertyVintageFallback.countyFips,
          cadPropertyVintageFallback.requestedPropId,
          cadPropertyVintageFallback.declaredTaxYear,
        ],
        set: {
          fallbackPropId: sql`excluded.fallback_prop_id`,
          fallbackTaxYear: sql`excluded.fallback_tax_year`,
          method: sql`excluded.method`,
          evidenceClass: sql`excluded.evidence_class`,
          sourceFile: sql`excluded.source_file`,
          sourceVintage: sql`excluded.source_vintage`,
          ingestedAt: sql`now()`,
        },
      });
  }
  return clean.length;
}
