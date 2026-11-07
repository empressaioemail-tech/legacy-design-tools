/**
 * maxImperviousCoverPct fact type (F-01, serve/prod cutover for ACQUIRE-GIS
 * wave 1 + PARCEL wave 2, `_decisions/2026-09-02_step7_consumer_c_then_b.md`).
 *
 * UNLIKE wellFactRead.ts / specialDistrictFactRead.ts / ownerFactRead.ts,
 * this module is NOT a legacy atom reader -- there is no pre-existing
 * maxImperviousCoverPct serve path anywhere in this repo. This file
 * carries only the shared type and the "not cut over yet" refusal a rail
 * with no legacy source needs.
 *
 * TRAVIS (48453) / AUSTIN ONLY, and only within it for parcels whose
 * centroid resolves to a WATER SUPPLY SUBURBAN watershed classification --
 * the writer (parcel-max-impervious-cover.mjs) leaves every other Austin
 * watershed classification (BSZ, SUBURBAN, URBAN, WATER SUPPLY RURAL)
 * genuinely unresolved (a real crosswalk gap, not a code gap -- see that
 * job's own IMPERVIOUS_COVER_CROSSWALK) and every parcel outside Austin's
 * watershed-regulation area entirely untouched (not an anomaly, per that
 * job's own module doc: "this rail has no meaningful value outside the
 * area the source actually covers").
 *
 * `watershedType`/`inRechargeZone`/`crosswalkCitation` live on the CELL
 * ITSELF, not a companion row (maxImperviousCoverCellState) -- read via
 * loadParcelRecordCell's `raw` field (parcelRecordCellRead.ts), added by
 * the same card that added schoolDistrict's cutover for the identical
 * reason.
 */

export const MAX_IMPERVIOUS_COVER_PCT_FACT_SOURCE = "max-impervious-cover-pct-fact" as const;
export const MAX_IMPERVIOUS_COVER_PCT_RAIL_KEY = "maxImperviousCoverPct" as const;

export type MaxImperviousCoverPctFactPresent = {
  state: "present";
  source: typeof MAX_IMPERVIOUS_COVER_PCT_FACT_SOURCE;
  entityId: string;
  percent: number;
  watershedType: string | null;
  inRechargeZone: boolean;
  /** Null only when the crosswalk did not resolve -- but a cell only reaches this rail's "present" state when it did. Never fabricated. */
  crosswalkCitation: string | null;
  sourceAdapter: "parcel_record";
  sourceVintage: string | null;
  evaluatedAt: string | null;
};

export type MaxImperviousCoverPctFactAbsent = {
  state: "absent";
  source: typeof MAX_IMPERVIOUS_COVER_PCT_FACT_SOURCE;
  entityId: string;
  absence: { kind: string; reason: string } | null;
  verifiedAbsence: boolean | null;
  sourceTier: string | null;
  sourceAdapter: "parcel_record";
  sourceVintage: string | null;
};

export type MaxImperviousCoverPctFactRefusalCode =
  | "invalid-parcel-node-id"
  | "not-cut-over"
  | "parcel-record-unaccounted"
  | "parcel-record-engine-refused"
  | "parcel-record-cell-miss"
  | "parcel-record-malformed-cell"
  | "parcel-record-store-not-configured";

export type MaxImperviousCoverPctFactRefusal = {
  state: "refused";
  code: MaxImperviousCoverPctFactRefusalCode;
  source: typeof MAX_IMPERVIOUS_COVER_PCT_FACT_SOURCE;
  entityId: string | null;
  reason: string;
};

export type MaxImperviousCoverPctFactRead =
  | MaxImperviousCoverPctFactPresent
  | MaxImperviousCoverPctFactAbsent
  | MaxImperviousCoverPctFactRefusal;

export function notCutOverMaxImperviousCoverPctFact(
  parcelNodeId: string,
): MaxImperviousCoverPctFactRefusal {
  return {
    state: "refused",
    code: "not-cut-over",
    source: MAX_IMPERVIOUS_COVER_PCT_FACT_SOURCE,
    entityId: parcelNodeId,
    reason:
      "maxImperviousCoverPct has no legacy serve path -- it is served only from parcel_record (Travis/Austin only), and only once this (county, rail) pair is slated with a passing gate verdict. Not there yet for this parcel.",
  };
}
