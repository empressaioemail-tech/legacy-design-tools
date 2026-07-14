/**
 * Shared types for the CAD bulk-export ingest pipeline.
 */

/** A normalized property row bound for the `cad_property` table. */
export interface CadPropertyRecord {
  countyFips: string;
  /** CAD property id, leading zeros stripped. */
  propId: string;
  taxYear: number;
  ownerName: string | null;
  /** Single normalized mailing-address line. */
  ownerMailingAddress: string | null;
  /** Single situs line (number, street, suffix, unit). */
  situsAddress: string | null;
  situsCity: string | null;
  situsZip: string | null;
  legalDescription: string | null;
  /** Normalized exemption short codes (HS, OV65, DV1, EX, ...). */
  exemptionCodes: string[] | null;
  /** Whole dollars. */
  landValue: number | null;
  improvementValue: number | null;
  marketValue: number | null;
  assessedValue: number | null;
  yearBuilt: number | null;
  livingAreaSqft: number | null;
  /** Decimal string, 4 fraction digits (numeric(14,4) column). */
  landAcres: string | null;
  propertyUseCode: string | null;
}

/** Counters accumulated by every parser. */
export interface ParseCounters {
  /** Lines/rows read from the property file (excl. header rows). */
  rowsRead: number;
  /** Rows that produced a normalized record. */
  rowsParsed: number;
  /** Malformed rows skipped (wrong length, unparsable key fields). */
  rowsSkipped: number;
  /** Rows dropped because their (prop_id, tax_year) was already seen. */
  duplicateRows: number;
  /** First few skip reasons, for the summary printout. */
  skipSamples: string[];
}

export function newCounters(): ParseCounters {
  return {
    rowsRead: 0,
    rowsParsed: 0,
    rowsSkipped: 0,
    duplicateRows: 0,
    skipSamples: [],
  };
}

export const SKIP_SAMPLE_CAP = 5;

export function recordSkip(c: ParseCounters, reason: string): void {
  c.rowsSkipped += 1;
  if (c.skipSamples.length < SKIP_SAMPLE_CAP) c.skipSamples.push(reason);
}

/** Result of an upsert pass. */
export interface UpsertSummary {
  rowsUpserted: number;
  batches: number;
}
