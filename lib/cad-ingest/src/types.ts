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

/**
 * WHY a feature was declined. One value per distinct refusal path, so a
 * declination can be counted BY CAUSE rather than lumped into a single
 * "skipped" integer whose printed label ("no polygon geometry") was
 * wrong for two of the three paths that fed it.
 */
export type DeclineReason =
  | "no-polygon-geometry"
  | "empty-geometry"
  | "degenerate-bbox"
  | "out-of-envelope-null-placeholder";

/**
 * ONE DECLINED FEATURE, WITH ENOUGH IDENTITY TO FIND IT AGAIN.
 *
 * The honest-absence doctrine applied to ingest: a feature we
 * deliberately refuse is a FINDING, not a gap. Before this existed the
 * ingest incremented `rowsSkipped` and kept at most five sample strings,
 * so when the per-feature skip path fired 148 times across 9 landed
 * counties nobody could answer "which parcels, and were any of them
 * real?". Every field here exists to make that question answerable:
 * `featureIndex` locates the record in the source shapefile, `propId` /
 * `geoId` / `objectId` carry whatever source identity the record had
 * (all null on a true placeholder — itself the evidence), `reason` says
 * which rule fired, and `detail` carries the offending value (the bbox
 * that fell outside Texas, the geometry type that was not a polygon).
 */
export interface DeclinedFeature {
  countyFips: string;
  /** Zero-based index in the source shapefile; +1 is the SHP recNum. */
  featureIndex: number;
  propId: string | null;
  geoId: string | null;
  /** Source OBJECTID_1 — survives even when Prop_ID is blank. */
  objectId: string | null;
  ownerName: string | null;
  reason: DeclineReason;
  /** The offending value, e.g. the out-of-envelope bbox or geom type. */
  detail: string;
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
  /**
   * EVERY declined feature, in full, with identity. Unlike `skipSamples`
   * this is NOT capped: a declination that is not recorded is a silent
   * drop, and the whole point is that none of them are silent. The
   * volume is bounded in practice by the halt ceiling
   * (`TXGIO_MAX_DECLINED_*` in `txgio/parse.ts`) — a county that would
   * produce an unbounded number of these aborts the run instead.
   */
  declined: DeclinedFeature[];
}

export function newCounters(): ParseCounters {
  return {
    rowsRead: 0,
    rowsParsed: 0,
    rowsSkipped: 0,
    duplicateRows: 0,
    skipSamples: [],
    declined: [],
  };
}

export const SKIP_SAMPLE_CAP = 5;

export function recordSkip(c: ParseCounters, reason: string): void {
  c.rowsSkipped += 1;
  if (c.skipSamples.length < SKIP_SAMPLE_CAP) c.skipSamples.push(reason);
}

/**
 * Record a declination WITH IDENTITY, and keep the legacy counters in
 * step so existing summaries and callers do not change meaning.
 *
 * This is deliberately a superset of `recordSkip` rather than a
 * replacement: `rowsSkipped` still counts, `skipSamples` still shows the
 * first few, and `declined` now carries the full identified roster.
 */
export function recordDecline(
  c: ParseCounters,
  declined: DeclinedFeature,
): void {
  c.declined.push(declined);
  recordSkip(
    c,
    `feature ${declined.featureIndex}: ${declined.reason} (${declined.detail})`,
  );
}

/** Group a declined roster by reason — for summaries and artifacts. */
export function summarizeDeclines(
  declined: DeclinedFeature[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of declined) out[d.reason] = (out[d.reason] ?? 0) + 1;
  return out;
}

/** Result of an upsert pass. */
export interface UpsertSummary {
  rowsUpserted: number;
  batches: number;
}
