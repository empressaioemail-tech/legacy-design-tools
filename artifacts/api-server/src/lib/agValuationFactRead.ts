/**
 * agValuation fact type (F-01, serve/prod cutover for ACQUIRE-GIS wave 1 +
 * PARCEL wave 2, `_decisions/2026-09-02_step7_consumer_c_then_b.md`).
 *
 * UNLIKE wellFactRead.ts / specialDistrictFactRead.ts / ownerFactRead.ts,
 * this module is NOT a legacy atom reader -- there is no pre-existing
 * agValuation serve path anywhere in this repo. This file carries only the
 * shared type and the "not cut over yet" refusal a rail with no legacy
 * source needs.
 *
 * WILLIAMSON (48491) AND TRAVIS (48453) ONLY -- the writer
 * (parcel-ag-valuation.mjs) refuses any other county outright
 * (COUNTY_NOT_IN_SCOPE). This module carries no county guard of its own:
 * the allowlist slate structurally excludes every other county (they are
 * simply never in PARCEL_RECORD_SLATE for this rail), which resolves to the
 * same `notCutOverAgValuationFact` refusal any unslated pair gets -- one
 * mechanism, not two.
 *
 * PLURAL, NOT A PICKED LEAD (contrast wells/specialDistricts): a parcel can
 * carry several distinct WCAD land-record segments (each its own
 * companion row); TCAD is "virtually always rowCount:1" but the shape is
 * still an array for both sources, since neither one crowds out the other
 * the way a single lead well does.
 */

export const AG_VALUATION_FACT_SOURCE = "ag-valuation-fact" as const;
export const AG_VALUATION_RAIL_KEY = "agValuation" as const;

export type AgValuationEntry = {
  statecode: string | null;
  landType: string | null;
  description: string | null;
  acres: number | null;
  value: number | null;
  currValue: number | null;
  agFlag: boolean;
  rawAgFlag: string | number | null;
  sequence: number | null;
  apprMethod: string | null;
  agYear: string | number | null;
  propertyNumber: string | null;
};

export type AgValuationFactPresent = {
  state: "present";
  source: typeof AG_VALUATION_FACT_SOURCE;
  entityId: string;
  entries: AgValuationEntry[];
  sourceAdapter: "parcel_record";
  sourceVintage: string | null;
  evaluatedAt: string | null;
};

export type AgValuationFactAbsent = {
  state: "absent";
  source: typeof AG_VALUATION_FACT_SOURCE;
  entityId: string;
  absence: { kind: string; reason: string } | null;
  verifiedAbsence: boolean | null;
  sourceTier: string | null;
  sourceAdapter: "parcel_record";
  sourceVintage: string | null;
};

export type AgValuationFactRefusalCode =
  | "invalid-parcel-node-id"
  | "not-cut-over"
  | "parcel-record-unaccounted"
  | "parcel-record-engine-refused"
  | "parcel-record-cell-miss"
  | "parcel-record-malformed-cell"
  | "parcel-record-store-not-configured";

export type AgValuationFactRefusal = {
  state: "refused";
  code: AgValuationFactRefusalCode;
  source: typeof AG_VALUATION_FACT_SOURCE;
  entityId: string | null;
  reason: string;
};

export type AgValuationFactRead =
  | AgValuationFactPresent
  | AgValuationFactAbsent
  | AgValuationFactRefusal;

export function notCutOverAgValuationFact(
  parcelNodeId: string,
): AgValuationFactRefusal {
  return {
    state: "refused",
    code: "not-cut-over",
    source: AG_VALUATION_FACT_SOURCE,
    entityId: parcelNodeId,
    reason:
      "agValuation has no legacy serve path -- it is served only from parcel_record (Williamson and Travis counties only), and only once this (county, rail) pair is slated with a passing gate verdict. Not there yet for this parcel.",
  };
}
