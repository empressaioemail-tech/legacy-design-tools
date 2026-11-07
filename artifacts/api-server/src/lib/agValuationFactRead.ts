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
 * (COUNTY_NOT_IN_SCOPE). This module carries no SERVING county guard of its
 * own: the allowlist slate structurally excludes every other county (they are
 * simply never in PARCEL_RECORD_SLATE for this rail), which resolves to the
 * same `notCutOverAgValuationFact` refusal any unslated pair gets -- one
 * mechanism, not two.
 *
 * P-322 (OPS-16 A-212, operator 2026-09-17). The refusal above was TRUE about
 * the serve path and FALSE about the cause for four of the six program
 * counties: Bastrop, Caldwell, Hays and McLennan are not waiting on a slating
 * step, they have no source at all, and the source planned for them is the
 * Cotality agreement, which is not in hand (A-184; P-267; P-283 deferred to
 * Phase 1). A customer reading "not yet slated" reads a scheduling gap where
 * the truth is an acquisition gap; that is a degraded answer presented as
 * complete, and the ruling forbids it. The four counties now get a DECLARED
 * ABSENCE instead: what the rail is, that it is not yet sourced, and what
 * would fill it. The cells themselves are untouched -- they stay honestly
 * `unaccounted` in the store (317,918 of them at the ruling), and nothing is
 * relabelled `absent-verified`.
 *
 * `AG_VALUATION_NO_SOURCE_COUNTIES` is not a serve guard and must not become
 * one: it selects which TRUE REASON to print, and nothing else. The serve
 * decision remains the slate's alone (see agValuationFactServeCutover.ts).
 * Its four FIPS are read from the vendor register's own entry for this rail,
 * `_catalog/vendor_contracts.json` -> vendors.cotality.rails.agValuation
 * .counties, so the list has one owner and the register can retire it when the
 * agreement lands.
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

/**
 * P-322: the four program counties whose agricultural land-record source is not
 * yet acquired. Read from `_catalog/vendor_contracts.json`
 * (vendors.cotality.rails.agValuation.counties, ruling A-184, row P-267).
 * NOT a serve guard -- see the module doc.
 */
export const AG_VALUATION_NO_SOURCE_COUNTIES: readonly string[] = Object.freeze([
  "48021", // Bastrop
  "48055", // Caldwell
  "48209", // Hays
  "48309", // McLennan
]);

/**
 * P-322 declared absence (A-212). Names the rail, says it is not yet sourced,
 * and says what would fill it. Never claims anything was looked at.
 */
export const AG_VALUATION_DECLARED_ABSENCE_REASON =
  "Not yet sourced. Agricultural valuation is the county appraisal district's own record of the land it appraises as agricultural, with its acres and ag values. No such record source is held for this county, so nothing has been looked up for this parcel: this is a declared absence, never a value, and never a verified absence. An agricultural land-record source for this county would fill it.";

export function notCutOverAgValuationFact(
  parcelNodeId: string,
): AgValuationFactRefusal {
  // Only a well-formed `countyFips:propId` pair can name a county. A bare or malformed
  // id must not be read as one: this function is reached with raw input on the
  // unparseable-id path, and widening the declared absence to a string that never
  // named a county would be a new falsehood in place of the old one.
  const [countyFips = "", propId = ""] = String(parcelNodeId).split(":");
  const namesANoSourceCounty =
    propId !== "" && AG_VALUATION_NO_SOURCE_COUNTIES.includes(countyFips);
  return {
    state: "refused",
    code: "not-cut-over",
    source: AG_VALUATION_FACT_SOURCE,
    entityId: parcelNodeId,
    reason: namesANoSourceCounty
      ? AG_VALUATION_DECLARED_ABSENCE_REASON
      : "agValuation has no legacy serve path -- it is served only from parcel_record (Williamson and Travis counties only), and only once this (county, rail) pair is slated with a passing gate verdict. Not there yet for this parcel.",
  };
}
