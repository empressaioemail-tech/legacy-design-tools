/**
 * maxFootprintSqFt fact type (F-01, OPS-21 P-148 / P-133).
 *
 * NOT a legacy atom reader -- there is no pre-existing maxFootprintSqFt
 * serve path anywhere in this repo. This module carries only the shared
 * type and the "not cut over yet" refusal a rail with no legacy source
 * needs, mirroring maxImperviousCoverPctFactRead.ts's own contract exactly.
 *
 * Derived (parcelAreaSqFt x maxLotCoveragePct / 100, live-verified sample:
 * 48491:R391328 value=2658.8, inputs{parcelAreaSqFt:5317.61,
 * maxLotCoveragePct:50}) by parcel-envelope-cells.mjs (hauska-factory).
 * Depends on maxLotCoveragePct resolving to a real value first, which
 * itself depends on zoningDistrict -- fails the gate on every in-scope
 * county as of this card (live-verified, S4/P-135 and re-verified this
 * card's own CP1). Never slated by this card.
 */

export const MAX_FOOTPRINT_SQFT_FACT_SOURCE = "max-footprint-sqft-fact" as const;
export const MAX_FOOTPRINT_SQFT_RAIL_KEY = "maxFootprintSqFt" as const;

export type MaxFootprintSqFtFactPresent = {
  state: "present";
  source: typeof MAX_FOOTPRINT_SQFT_FACT_SOURCE;
  entityId: string;
  sqFt: number;
  method: string | null;
  /** The two upstream cell values this figure was derived from, when the engine recorded them. Never fabricated -- null unless the cell itself carries them. */
  inputs: { parcelAreaSqFt: number | null; maxLotCoveragePct: number | null } | null;
  sourceAdapter: "parcel_record";
  sourceVintage: string | null;
  evaluatedAt: string | null;
};

export type MaxFootprintSqFtFactAbsent = {
  state: "absent";
  source: typeof MAX_FOOTPRINT_SQFT_FACT_SOURCE;
  entityId: string;
  absence: { kind: string; reason: string } | null;
  verifiedAbsence: boolean | null;
  sourceTier: string | null;
  sourceAdapter: "parcel_record";
  sourceVintage: string | null;
};

export type MaxFootprintSqFtFactRefusalCode =
  | "invalid-parcel-node-id"
  | "not-cut-over"
  | "parcel-record-unaccounted"
  | "parcel-record-engine-refused"
  | "parcel-record-cell-miss"
  | "parcel-record-malformed-cell"
  | "parcel-record-store-not-configured";

export type MaxFootprintSqFtFactRefusal = {
  state: "refused";
  code: MaxFootprintSqFtFactRefusalCode;
  source: typeof MAX_FOOTPRINT_SQFT_FACT_SOURCE;
  entityId: string | null;
  reason: string;
};

export type MaxFootprintSqFtFactRead =
  | MaxFootprintSqFtFactPresent
  | MaxFootprintSqFtFactAbsent
  | MaxFootprintSqFtFactRefusal;

export function notCutOverMaxFootprintSqFtFact(
  parcelNodeId: string,
): MaxFootprintSqFtFactRefusal {
  return {
    state: "refused",
    code: "not-cut-over",
    source: MAX_FOOTPRINT_SQFT_FACT_SOURCE,
    entityId: parcelNodeId,
    reason:
      "maxFootprintSqFt has no legacy serve path -- it is served only from parcel_record, and only once this (county, rail) pair is slated with a passing gate verdict. Not there yet for this parcel.",
  };
}
