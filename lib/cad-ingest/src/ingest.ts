/**
 * Batch upsert of normalized CAD records into `cad_property`.
 *
 * ON CONFLICT (county_fips, prop_id, tax_year) DO UPDATE — re-running
 * an ingest for the same export (or a fresher drop of the same roll
 * year) merges per P-78: a CAMA(cad-export)-wins CASE on every
 * appraisal-sourced attribute (ownerName, situs*, legalDescription,
 * exemptionCodes, the four dollar fields, landAcres, propertyUseCode,
 * yearBuilt, livingAreaSqft — see p78Merge.ts's `mergeAuthority` for the
 * full rule), a bare COALESCE on the two identifiers the geometry loader
 * never populates (quickRefId, propertyNumber), and `ingested_at` is
 * bumped so row age tracks the latest load.
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
    quickRefId: rec.quickRefId,
    propertyNumber: rec.propertyNumber,
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
          // THE P-78 MERGE ROOT (Phase 0 audit section 3/4, P3). Every field below that the
          // StratMap/TxGIO geometry loader ALSO populates (everything except quick_ref_id /
          // property_number, which it hardcodes null -- see txgio/landuse.ts) is merged through
          // the SAME CAMA-wins CASE shape year_built/living_area_sqft already used, not a bare
          // COALESCE. A bare COALESCE(excluded.x, cad_property.x) lets a lower-authority
          // geometry re-apply (incoming, non-null) silently overwrite a real CAD export's value
          // (existing) -- measured live in Hays (joinNormalize.ts: 116,421 rows' situsAddress
          // byte-identical to TxGIO after the 2026-08-25 P-78 StratMap merge). This SET clause
          // must match p78Merge.ts's `applyPathAMerge`/`mergeAuthority` (AUTHORITY_COALESCE_FIELDS)
          // exactly -- see that file's test suite's own header comment.
          ownerName: sql`CASE
            WHEN excluded.owner_name IS NULL THEN ${cadProperty.ownerName}
            WHEN ${cadProperty.ownerName} IS NULL THEN excluded.owner_name
            WHEN excluded.source_vintage LIKE 'tier:cad-export;%' THEN excluded.owner_name
            WHEN ${cadProperty.sourceVintage} LIKE 'tier:cad-export;%' THEN ${cadProperty.ownerName}
            ELSE excluded.owner_name
          END`,
          ownerMailingAddress: sql`CASE
            WHEN excluded.owner_mailing_address IS NULL THEN ${cadProperty.ownerMailingAddress}
            WHEN ${cadProperty.ownerMailingAddress} IS NULL THEN excluded.owner_mailing_address
            WHEN excluded.source_vintage LIKE 'tier:cad-export;%' THEN excluded.owner_mailing_address
            WHEN ${cadProperty.sourceVintage} LIKE 'tier:cad-export;%' THEN ${cadProperty.ownerMailingAddress}
            ELSE excluded.owner_mailing_address
          END`,
          situsAddress: sql`CASE
            WHEN excluded.situs_address IS NULL THEN ${cadProperty.situsAddress}
            WHEN ${cadProperty.situsAddress} IS NULL THEN excluded.situs_address
            WHEN excluded.source_vintage LIKE 'tier:cad-export;%' THEN excluded.situs_address
            WHEN ${cadProperty.sourceVintage} LIKE 'tier:cad-export;%' THEN ${cadProperty.situsAddress}
            ELSE excluded.situs_address
          END`,
          situsCity: sql`CASE
            WHEN excluded.situs_city IS NULL THEN ${cadProperty.situsCity}
            WHEN ${cadProperty.situsCity} IS NULL THEN excluded.situs_city
            WHEN excluded.source_vintage LIKE 'tier:cad-export;%' THEN excluded.situs_city
            WHEN ${cadProperty.sourceVintage} LIKE 'tier:cad-export;%' THEN ${cadProperty.situsCity}
            ELSE excluded.situs_city
          END`,
          situsZip: sql`CASE
            WHEN excluded.situs_zip IS NULL THEN ${cadProperty.situsZip}
            WHEN ${cadProperty.situsZip} IS NULL THEN excluded.situs_zip
            WHEN excluded.source_vintage LIKE 'tier:cad-export;%' THEN excluded.situs_zip
            WHEN ${cadProperty.sourceVintage} LIKE 'tier:cad-export;%' THEN ${cadProperty.situsZip}
            ELSE excluded.situs_zip
          END`,
          legalDescription: sql`CASE
            WHEN excluded.legal_description IS NULL THEN ${cadProperty.legalDescription}
            WHEN ${cadProperty.legalDescription} IS NULL THEN excluded.legal_description
            WHEN excluded.source_vintage LIKE 'tier:cad-export;%' THEN excluded.legal_description
            WHEN ${cadProperty.sourceVintage} LIKE 'tier:cad-export;%' THEN ${cadProperty.legalDescription}
            ELSE excluded.legal_description
          END`,
          exemptionCodes: sql`CASE
            WHEN excluded.exemption_codes IS NULL THEN ${cadProperty.exemptionCodes}
            WHEN ${cadProperty.exemptionCodes} IS NULL THEN excluded.exemption_codes
            WHEN excluded.source_vintage LIKE 'tier:cad-export;%' THEN excluded.exemption_codes
            WHEN ${cadProperty.sourceVintage} LIKE 'tier:cad-export;%' THEN ${cadProperty.exemptionCodes}
            ELSE excluded.exemption_codes
          END`,
          landValue: sql`CASE
            WHEN excluded.land_value IS NULL THEN ${cadProperty.landValue}
            WHEN ${cadProperty.landValue} IS NULL THEN excluded.land_value
            WHEN excluded.source_vintage LIKE 'tier:cad-export;%' THEN excluded.land_value
            WHEN ${cadProperty.sourceVintage} LIKE 'tier:cad-export;%' THEN ${cadProperty.landValue}
            ELSE excluded.land_value
          END`,
          improvementValue: sql`CASE
            WHEN excluded.improvement_value IS NULL THEN ${cadProperty.improvementValue}
            WHEN ${cadProperty.improvementValue} IS NULL THEN excluded.improvement_value
            WHEN excluded.source_vintage LIKE 'tier:cad-export;%' THEN excluded.improvement_value
            WHEN ${cadProperty.sourceVintage} LIKE 'tier:cad-export;%' THEN ${cadProperty.improvementValue}
            ELSE excluded.improvement_value
          END`,
          marketValue: sql`CASE
            WHEN excluded.market_value IS NULL THEN ${cadProperty.marketValue}
            WHEN ${cadProperty.marketValue} IS NULL THEN excluded.market_value
            WHEN excluded.source_vintage LIKE 'tier:cad-export;%' THEN excluded.market_value
            WHEN ${cadProperty.sourceVintage} LIKE 'tier:cad-export;%' THEN ${cadProperty.marketValue}
            ELSE excluded.market_value
          END`,
          assessedValue: sql`CASE
            WHEN excluded.assessed_value IS NULL THEN ${cadProperty.assessedValue}
            WHEN ${cadProperty.assessedValue} IS NULL THEN excluded.assessed_value
            WHEN excluded.source_vintage LIKE 'tier:cad-export;%' THEN excluded.assessed_value
            WHEN ${cadProperty.sourceVintage} LIKE 'tier:cad-export;%' THEN ${cadProperty.assessedValue}
            ELSE excluded.assessed_value
          END`,
          landAcres: sql`CASE
            WHEN excluded.land_acres IS NULL THEN ${cadProperty.landAcres}
            WHEN ${cadProperty.landAcres} IS NULL THEN excluded.land_acres
            WHEN excluded.source_vintage LIKE 'tier:cad-export;%' THEN excluded.land_acres
            WHEN ${cadProperty.sourceVintage} LIKE 'tier:cad-export;%' THEN ${cadProperty.landAcres}
            ELSE excluded.land_acres
          END`,
          propertyUseCode: sql`CASE
            WHEN excluded.property_use_code IS NULL THEN ${cadProperty.propertyUseCode}
            WHEN ${cadProperty.propertyUseCode} IS NULL THEN excluded.property_use_code
            WHEN excluded.source_vintage LIKE 'tier:cad-export;%' THEN excluded.property_use_code
            WHEN ${cadProperty.sourceVintage} LIKE 'tier:cad-export;%' THEN ${cadProperty.propertyUseCode}
            ELSE excluded.property_use_code
          END`,
          // CTX-HAYS-REBIND. COALESCE incoming-first like before this change, which for THESE
          // two is already the safe direction and needs no authority CASE: the only
          // non-appraisal writer (the StratMap/TxGIO geometry loader) emits null for both, so a
          // geometry re-apply can never blank an identifier a real CAD export established. An
          // appraisal export re-publishing a corrected identifier should win, and does.
          quickRefId: sql`COALESCE(excluded.quick_ref_id, ${cadProperty.quickRefId})`,
          propertyNumber: sql`COALESCE(excluded.property_number, ${cadProperty.propertyNumber})`,
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
