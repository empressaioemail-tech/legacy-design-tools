/**
 * parcelAreaSqFt fact type (F-01, OPS-21 P-148 / P-133).
 *
 * NOT a legacy atom reader -- there is no pre-existing parcelAreaSqFt serve
 * path anywhere in this repo (confirmed by repo-wide grep before this card;
 * nodeFacetBakeTier1.ts's buildableAreaSqFt/buildableAreaPct are a distinct,
 * unrelated bake-time rail family, not a namespace collision). This module
 * carries only the shared type and the "not cut over yet" refusal a rail
 * with no legacy source needs, mirroring maxImperviousCoverPctFactRead.ts's
 * own contract exactly.
 *
 * Sourced from real geometry: ST_Area(geography) over
 * ST_MakeValid(ST_Union(...)) of every txgio_parcel fragment for the
 * prop_id (parcel-envelope-cells.mjs, hauska-factory). Independent of
 * zoning status -- unlike its three envelope siblings (maxHeightFt,
 * maxLotCoveragePct, maxFootprintSqFt), parcelAreaSqFt does not depend on
 * the zoningDistrict residual, which is why it alone passes the gate today
 * (live-verified, S4/P-135 and re-verified this card's own CP1).
 */

export const PARCEL_AREA_SQFT_FACT_SOURCE = "parcel-area-sqft-fact" as const;
export const PARCEL_AREA_SQFT_RAIL_KEY = "parcelAreaSqFt" as const;

export type ParcelAreaSqFtFactPresent = {
  state: "present";
  source: typeof PARCEL_AREA_SQFT_FACT_SOURCE;
  entityId: string;
  sqFt: number;
  method: string | null;
  fragmentCount: number | null;
  sourceAdapter: "parcel_record";
  sourceVintage: string | null;
  evaluatedAt: string | null;
};

export type ParcelAreaSqFtFactAbsent = {
  state: "absent";
  source: typeof PARCEL_AREA_SQFT_FACT_SOURCE;
  entityId: string;
  absence: { kind: string; reason: string } | null;
  verifiedAbsence: boolean | null;
  sourceTier: string | null;
  sourceAdapter: "parcel_record";
  sourceVintage: string | null;
};

export type ParcelAreaSqFtFactRefusalCode =
  | "invalid-parcel-node-id"
  | "not-cut-over"
  | "parcel-record-unaccounted"
  | "parcel-record-engine-refused"
  | "parcel-record-cell-miss"
  | "parcel-record-malformed-cell"
  | "parcel-record-store-not-configured";

export type ParcelAreaSqFtFactRefusal = {
  state: "refused";
  code: ParcelAreaSqFtFactRefusalCode;
  source: typeof PARCEL_AREA_SQFT_FACT_SOURCE;
  entityId: string | null;
  reason: string;
};

export type ParcelAreaSqFtFactRead =
  | ParcelAreaSqFtFactPresent
  | ParcelAreaSqFtFactAbsent
  | ParcelAreaSqFtFactRefusal;

export function notCutOverParcelAreaSqFtFact(
  parcelNodeId: string,
): ParcelAreaSqFtFactRefusal {
  return {
    state: "refused",
    code: "not-cut-over",
    source: PARCEL_AREA_SQFT_FACT_SOURCE,
    entityId: parcelNodeId,
    reason:
      "parcelAreaSqFt has no legacy serve path -- it is served only from parcel_record, and only once this (county, rail) pair is slated with a passing gate verdict. Not there yet for this parcel.",
  };
}
