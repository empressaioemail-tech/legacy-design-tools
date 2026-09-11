/**
 * maxLotCoveragePct fact type (F-01, OPS-21 P-148 / P-133).
 *
 * NOT a legacy atom reader -- there is no pre-existing maxLotCoveragePct
 * serve path anywhere in this repo. This module carries only the shared
 * type and the "not cut over yet" refusal a rail with no legacy source
 * needs, mirroring maxImperviousCoverPctFactRead.ts's own contract exactly
 * (a genuinely different rail -- lot COVERAGE, not IMPERVIOUS cover -- that
 * happens to share the same adapter shape).
 *
 * Sourced from @empressaio/setback-corpus via envelope-corpus-lookup.mjs
 * (hauska-factory, parcel-envelope-cells.mjs). Depends on zoningDistrict
 * being resolved first; fails the gate on every in-scope county as of this
 * card (live-verified, S4/P-135 and re-verified this card's own CP1).
 * Never slated by this card.
 */

export const MAX_LOT_COVERAGE_PCT_FACT_SOURCE = "max-lot-coverage-pct-fact" as const;
export const MAX_LOT_COVERAGE_PCT_RAIL_KEY = "maxLotCoveragePct" as const;

export type MaxLotCoveragePctFactPresent = {
  state: "present";
  source: typeof MAX_LOT_COVERAGE_PCT_FACT_SOURCE;
  entityId: string;
  percent: number;
  citationUrl: string | null;
  districtCode: string | null;
  districtName: string | null;
  jurisdictionKey: string | null;
  sourceAdapter: "parcel_record";
  sourceVintage: string | null;
  evaluatedAt: string | null;
};

export type MaxLotCoveragePctFactAbsent = {
  state: "absent";
  source: typeof MAX_LOT_COVERAGE_PCT_FACT_SOURCE;
  entityId: string;
  absence: { kind: string; reason: string } | null;
  verifiedAbsence: boolean | null;
  sourceTier: string | null;
  sourceAdapter: "parcel_record";
  sourceVintage: string | null;
};

export type MaxLotCoveragePctFactRefusalCode =
  | "invalid-parcel-node-id"
  | "not-cut-over"
  | "parcel-record-unaccounted"
  | "parcel-record-engine-refused"
  | "parcel-record-cell-miss"
  | "parcel-record-malformed-cell"
  | "parcel-record-store-not-configured";

export type MaxLotCoveragePctFactRefusal = {
  state: "refused";
  code: MaxLotCoveragePctFactRefusalCode;
  source: typeof MAX_LOT_COVERAGE_PCT_FACT_SOURCE;
  entityId: string | null;
  reason: string;
};

export type MaxLotCoveragePctFactRead =
  | MaxLotCoveragePctFactPresent
  | MaxLotCoveragePctFactAbsent
  | MaxLotCoveragePctFactRefusal;

export function notCutOverMaxLotCoveragePctFact(
  parcelNodeId: string,
): MaxLotCoveragePctFactRefusal {
  return {
    state: "refused",
    code: "not-cut-over",
    source: MAX_LOT_COVERAGE_PCT_FACT_SOURCE,
    entityId: parcelNodeId,
    reason:
      "maxLotCoveragePct has no legacy serve path -- it is served only from parcel_record, and only once this (county, rail) pair is slated with a passing gate verdict. Not there yet for this parcel.",
  };
}
