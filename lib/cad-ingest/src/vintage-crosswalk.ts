/**
 * Upsert deterministic CAD vintage crosswalk rows (L21 / P-25).
 * Ambiguous many-to-one / one-to-many writes fail closed via UNIQUE.
 */

import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { cadPropertyVintageCrosswalk } from "@workspace/db";

export type CadCrosswalkDb = Pick<
  NodePgDatabase<Record<string, unknown>>,
  "insert"
>;

export interface CadCrosswalkRecord {
  countyFips: string;
  fromTaxYear: number;
  fromPropId: string;
  toTaxYear: number;
  toPropId: string;
  method: string;
  evidenceClass: string;
  sourceFile: string;
  sourceVintage: string;
}

export async function upsertCadVintageCrosswalk(
  database: CadCrosswalkDb,
  rows: CadCrosswalkRecord[],
): Promise<number> {
  if (rows.length === 0) return 0;
  // Reject identity no-ops and empty keys before hitting the DB.
  const clean = rows.filter(
    (r) =>
      r.fromPropId.length > 0 &&
      r.toPropId.length > 0 &&
      r.fromPropId !== r.toPropId,
  );
  if (clean.length === 0) return 0;

  await database
    .insert(cadPropertyVintageCrosswalk)
    .values(
      clean.map((r) => ({
        countyFips: r.countyFips,
        fromTaxYear: r.fromTaxYear,
        fromPropId: r.fromPropId,
        toTaxYear: r.toTaxYear,
        toPropId: r.toPropId,
        method: r.method,
        evidenceClass: r.evidenceClass,
        sourceFile: r.sourceFile,
        sourceVintage: r.sourceVintage,
      })),
    )
    .onConflictDoUpdate({
      target: [
        cadPropertyVintageCrosswalk.countyFips,
        cadPropertyVintageCrosswalk.fromTaxYear,
        cadPropertyVintageCrosswalk.fromPropId,
        cadPropertyVintageCrosswalk.toTaxYear,
      ],
      set: {
        toPropId: sql`excluded.to_prop_id`,
        method: sql`excluded.method`,
        evidenceClass: sql`excluded.evidence_class`,
        sourceFile: sql`excluded.source_file`,
        sourceVintage: sql`excluded.source_vintage`,
        ingestedAt: sql`now()`,
      },
    });
  return clean.length;
}
