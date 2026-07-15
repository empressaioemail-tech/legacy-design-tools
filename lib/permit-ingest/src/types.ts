/**
 * Shared types for the municipal permit ingest pipeline.
 */

/** A normalized permit row bound for the `building_permits` table. */
export interface BuildingPermitRecord {
  countyFips: string;
  /** Parcel key the permit hangs on, verbatim from source (may be ""). */
  propId: string;
  /** Jurisdiction permit number. */
  permitId: string;
  /** ISO calendar date (YYYY-MM-DD) or null. */
  issuedDate: string | null;
  appliedDate: string | null;
  workClass: string | null;
  status: string | null;
  description: string | null;
  permitType: string | null;
}

/** Counters accumulated during a parse pass. */
export interface ParseCounters {
  /** Data rows read from the source (excludes the header row). */
  rowsRead: number;
  /** Rows that produced a normalized record. */
  rowsParsed: number;
  /** Malformed rows skipped (missing permit id / unusable key fields). */
  rowsSkipped: number;
  /** Rows dropped because their (prop_id, permit_id) was already seen. */
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
