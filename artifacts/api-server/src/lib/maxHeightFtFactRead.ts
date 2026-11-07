/**
 * maxHeightFt fact type (F-01, OPS-21 P-148 / P-133).
 *
 * NOT a legacy atom reader -- there is no pre-existing maxHeightFt serve
 * path anywhere in this repo. This module carries only the shared type and
 * the "not cut over yet" refusal a rail with no legacy source needs,
 * mirroring maxImperviousCoverPctFactRead.ts's own contract exactly.
 *
 * Sourced from @empressaio/setback-corpus via envelope-corpus-lookup.mjs
 * (hauska-factory, parcel-envelope-cells.mjs), the same per-district
 * ruled-table routing setbackRules/setbackFrontFt use. Depends on
 * zoningDistrict being resolved first (like its setback siblings, NOT like
 * parcelAreaSqFt) -- gated on the 3,376-parcel zoningDistrict residual
 * Z1/P-147 is characterising; fails the gate on every in-scope county as of
 * this card (live-verified, S4/P-135 and re-verified this card's own CP1).
 * Never slated by this card -- see parcelRecordAllowlist.ts's own module
 * doc for the one rail this card does slate.
 */

export const MAX_HEIGHT_FT_FACT_SOURCE = "max-height-ft-fact" as const;
export const MAX_HEIGHT_FT_RAIL_KEY = "maxHeightFt" as const;

export type MaxHeightFtFactPresent = {
  state: "present";
  source: typeof MAX_HEIGHT_FT_FACT_SOURCE;
  entityId: string;
  feet: number;
  citationUrl: string | null;
  districtCode: string | null;
  districtName: string | null;
  jurisdictionKey: string | null;
  sourceAdapter: "parcel_record";
  sourceVintage: string | null;
  evaluatedAt: string | null;
};

export type MaxHeightFtFactAbsent = {
  state: "absent";
  source: typeof MAX_HEIGHT_FT_FACT_SOURCE;
  entityId: string;
  absence: { kind: string; reason: string } | null;
  verifiedAbsence: boolean | null;
  sourceTier: string | null;
  sourceAdapter: "parcel_record";
  sourceVintage: string | null;
};

export type MaxHeightFtFactRefusalCode =
  | "invalid-parcel-node-id"
  | "not-cut-over"
  | "parcel-record-unaccounted"
  | "parcel-record-engine-refused"
  | "parcel-record-cell-miss"
  | "parcel-record-malformed-cell"
  | "parcel-record-store-not-configured";

export type MaxHeightFtFactRefusal = {
  state: "refused";
  code: MaxHeightFtFactRefusalCode;
  source: typeof MAX_HEIGHT_FT_FACT_SOURCE;
  entityId: string | null;
  reason: string;
};

export type MaxHeightFtFactRead =
  | MaxHeightFtFactPresent
  | MaxHeightFtFactAbsent
  | MaxHeightFtFactRefusal;

export function notCutOverMaxHeightFtFact(
  parcelNodeId: string,
): MaxHeightFtFactRefusal {
  return {
    state: "refused",
    code: "not-cut-over",
    source: MAX_HEIGHT_FT_FACT_SOURCE,
    entityId: parcelNodeId,
    reason:
      "maxHeightFt has no legacy serve path -- it is served only from parcel_record, and only once this (county, rail) pair is slated with a passing gate verdict. Not there yet for this parcel.",
  };
}
