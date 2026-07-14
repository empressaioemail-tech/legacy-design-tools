/**
 * Batch upsert of normalized CAD records into `cad_property`.
 *
 * ON CONFLICT (county_fips, prop_id, tax_year) DO UPDATE — re-running
 * an ingest for the same export (or a fresher drop of the same roll
 * year) is idempotent: attribute columns are overwritten, and
 * `ingested_at` is bumped so row age tracks the latest load.
 *
 * Callers pass a drizzle handle so the CLI (own pool from
 * DATABASE_URL) and tests (`withTestSchema`) share this code.
 */

import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { cadProperty } from "@workspace/db/schema";
import type { CadPropertyRecord, UpsertSummary } from "./types";

/**
 * Minimal structural slice of a drizzle node-postgres database — only
 * `insert` is needed, so both the CLI's own handle and the test
 * harness's `withTestSchema` db (typed against the full schema) fit.
 */
export type CadIngestDb = Pick<NodePgDatabase<Record<string, unknown>>, "insert">;

export const DEFAULT_BATCH_SIZE = 1000;

function toInsertRow(rec: CadPropertyRecord, sourceFile: string, sourceVintage: string) {
  return {
    countyFips: rec.countyFips,
    propId: rec.propId,
    taxYear: rec.taxYear,
    ownerName: rec.ownerName,
    ownerMailingAddress: rec.ownerMailingAddress,
    situsAddress: rec.situsAddress,
    situsCity: rec.situsCity,
    situsZip: rec.situsZip,
    legalDescription: rec.legalDescription,
    exemptionCodes: rec.exemptionCodes,
    landValue: rec.landValue,
    improvementValue: rec.improvementValue,
    marketValue: rec.marketValue,
    assessedValue: rec.assessedValue,
    yearBuilt: rec.yearBuilt,
    livingAreaSqft: rec.livingAreaSqft,
    landAcres: rec.landAcres,
    propertyUseCode: rec.propertyUseCode,
    sourceFile,
    sourceVintage,
  };
}

export interface UpsertOptions {
  /** Basename recorded on every row. */
  sourceFile: string;
  /** Export drop label recorded on every row. */
  sourceVintage: string;
  batchSize?: number;
  /** Progress callback, called after each batch. */
  onBatch?: (totalUpserted: number) => void;
}

/**
 * Consume `records` and upsert them in batches. The input stream must
 * already be deduplicated on (county_fips, prop_id, tax_year) — the
 * parsers guarantee this — because a single INSERT cannot update the
 * same row twice.
 */
export async function upsertCadProperties(
  db: CadIngestDb,
  records: AsyncIterable<CadPropertyRecord> | Iterable<CadPropertyRecord>,
  opts: UpsertOptions,
): Promise<UpsertSummary> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  let batch: ReturnType<typeof toInsertRow>[] = [];
  let rowsUpserted = 0;
  let batches = 0;

  async function flush(): Promise<void> {
    if (batch.length === 0) return;
    await db
      .insert(cadProperty)
      .values(batch)
      .onConflictDoUpdate({
        target: [cadProperty.countyFips, cadProperty.propId, cadProperty.taxYear],
        set: {
          ownerName: sql`excluded.owner_name`,
          ownerMailingAddress: sql`excluded.owner_mailing_address`,
          situsAddress: sql`excluded.situs_address`,
          situsCity: sql`excluded.situs_city`,
          situsZip: sql`excluded.situs_zip`,
          legalDescription: sql`excluded.legal_description`,
          exemptionCodes: sql`excluded.exemption_codes`,
          landValue: sql`excluded.land_value`,
          improvementValue: sql`excluded.improvement_value`,
          marketValue: sql`excluded.market_value`,
          assessedValue: sql`excluded.assessed_value`,
          yearBuilt: sql`excluded.year_built`,
          livingAreaSqft: sql`excluded.living_area_sqft`,
          landAcres: sql`excluded.land_acres`,
          propertyUseCode: sql`excluded.property_use_code`,
          sourceFile: sql`excluded.source_file`,
          sourceVintage: sql`excluded.source_vintage`,
          ingestedAt: sql`now()`,
        },
      });
    rowsUpserted += batch.length;
    batches += 1;
    batch = [];
    opts.onBatch?.(rowsUpserted);
  }

  for await (const rec of records) {
    batch.push(toInsertRow(rec, opts.sourceFile, opts.sourceVintage));
    if (batch.length >= batchSize) await flush();
  }
  await flush();

  return { rowsUpserted, batches };
}
