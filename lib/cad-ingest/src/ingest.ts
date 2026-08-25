/**
 * Batch upsert of normalized CAD records into `cad_property`.
 *
 * ON CONFLICT (county_fips, prop_id, tax_year) DO UPDATE — re-running
 * an ingest for the same export (or a fresher drop of the same roll
 * year) merges per P-78: COALESCE on most attributes, CAMA-wins CASE on year_built and living_area_sqft, and
 * `ingested_at` is bumped so row age tracks the latest load.
 *
 * Callers pass a drizzle handle so the CLI (own pool from
 * DATABASE_URL) and tests (`withTestSchema`) share this code.
 */

import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { cadProperty } from "@workspace/db/schema";
import type { CadPropertyRecord, UpsertSummary } from "./types";
import { parseYearBuilt } from "./p78Merge";

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
    yearBuilt: parseYearBuilt(rec.yearBuilt),
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
          ownerName: sql`COALESCE(excluded.owner_name, ${cadProperty.ownerName})`,
          ownerMailingAddress: sql`COALESCE(excluded.owner_mailing_address, ${cadProperty.ownerMailingAddress})`,
          situsAddress: sql`COALESCE(excluded.situs_address, ${cadProperty.situsAddress})`,
          situsCity: sql`COALESCE(excluded.situs_city, ${cadProperty.situsCity})`,
          situsZip: sql`COALESCE(excluded.situs_zip, ${cadProperty.situsZip})`,
          legalDescription: sql`COALESCE(excluded.legal_description, ${cadProperty.legalDescription})`,
          exemptionCodes: sql`COALESCE(excluded.exemption_codes, ${cadProperty.exemptionCodes})`,
          landValue: sql`COALESCE(excluded.land_value, ${cadProperty.landValue})`,
          improvementValue: sql`COALESCE(excluded.improvement_value, ${cadProperty.improvementValue})`,
          marketValue: sql`COALESCE(excluded.market_value, ${cadProperty.marketValue})`,
          assessedValue: sql`COALESCE(excluded.assessed_value, ${cadProperty.assessedValue})`,
          landAcres: sql`COALESCE(excluded.land_acres, ${cadProperty.landAcres})`,
          propertyUseCode: sql`COALESCE(excluded.property_use_code, ${cadProperty.propertyUseCode})`,
          yearBuilt: sql`CASE
            WHEN NULLIF(excluded.year_built, 0) IS NULL THEN NULLIF(${cadProperty.yearBuilt}, 0)
            WHEN NULLIF(${cadProperty.yearBuilt}, 0) IS NULL THEN NULLIF(excluded.year_built, 0)
            WHEN excluded.source_vintage LIKE 'tier:cad-export;%' THEN NULLIF(excluded.year_built, 0)
            WHEN ${cadProperty.sourceVintage} LIKE 'tier:cad-export;%' THEN NULLIF(${cadProperty.yearBuilt}, 0)
            ELSE NULLIF(excluded.year_built, 0)
          END`,
          livingAreaSqft: sql`CASE
            WHEN excluded.living_area_sqft IS NULL THEN ${cadProperty.livingAreaSqft}
            WHEN ${cadProperty.livingAreaSqft} IS NULL THEN excluded.living_area_sqft
            WHEN excluded.source_vintage LIKE 'tier:cad-export;%' THEN excluded.living_area_sqft
            WHEN ${cadProperty.sourceVintage} LIKE 'tier:cad-export;%' THEN ${cadProperty.livingAreaSqft}
            ELSE excluded.living_area_sqft
          END`,
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
