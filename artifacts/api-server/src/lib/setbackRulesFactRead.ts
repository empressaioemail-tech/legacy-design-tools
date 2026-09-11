/**
 * setbackRules fact type (F-01, OPS-21 P-148 / P-132).
 *
 * NOT a legacy atom reader -- there is no pre-existing setbackRules serve
 * path anywhere in this repo (distinct from its Ft-suffixed siblings
 * setbackFrontFt/setbackSideFt/setbackRearFt/setbackCornerFt, which DO have
 * one via setbacksFactServeCutover.ts -- see that module's own doc). This
 * module carries only the shared type and the "not cut over yet" refusal a
 * rail with no legacy source needs.
 *
 * STRUCTURALLY DIFFERENT FROM ITS SIBLINGS, live-verified (this card's own
 * CP1, direct SQL against parcel_record_cell / parcel_record_companion_row
 * on the FACTORY host): unlike setbackFrontFt/SideFt/RearFt/CornerFt (plain
 * scalar `value` cells), setbackRules' "value" cell_state carries NO scalar
 * value field at all (cell_state->'value' is JSON null on every present
 * row; disposition:'rows', rowCount:1) -- the real content is the
 * rule-citation object living in parcel_record_companion_row (rowIndex 0):
 * matchKind, citationUrl, districtCode, districtName, effectiveDate,
 * jurisdictionKey, resolvedTableKey, note. This is a companion-row rail,
 * mirroring utilityServiceFactRead.ts's own shape, NOT the scalar shape its
 * naming proximity to setbackFrontFt etc. would suggest.
 *
 * Written by the same job as its four Ft-suffixed siblings
 * (parcel-setback-cells.mjs, hauska-factory) -- "all 5 setback rails always
 * move together as one unit" per that job's own close (S1/P-132). Fails the
 * gate on every in-scope county as of this card (live-verified, S4/P-135
 * and re-verified this card's own CP1). Never slated by this card.
 */

export const SETBACK_RULES_FACT_SOURCE = "setback-rules-fact" as const;
export const SETBACK_RULES_RAIL_KEY = "setbackRules" as const;

export type SetbackRulesFactPresent = {
  state: "present";
  source: typeof SETBACK_RULES_FACT_SOURCE;
  entityId: string;
  matchKind: string | null;
  citationUrl: string | null;
  districtCode: string | null;
  districtName: string | null;
  effectiveDate: string | null;
  jurisdictionKey: string | null;
  resolvedTableKey: string | null;
  note: string | null;
  sourceAdapter: "parcel_record";
  sourceVintage: string | null;
  evaluatedAt: string | null;
};

export type SetbackRulesFactAbsent = {
  state: "absent";
  source: typeof SETBACK_RULES_FACT_SOURCE;
  entityId: string;
  absence: { kind: string; reason: string } | null;
  verifiedAbsence: boolean | null;
  sourceTier: string | null;
  sourceAdapter: "parcel_record";
  sourceVintage: string | null;
};

export type SetbackRulesFactRefusalCode =
  | "invalid-parcel-node-id"
  | "not-cut-over"
  | "parcel-record-unaccounted"
  | "parcel-record-engine-refused"
  | "parcel-record-cell-miss"
  | "parcel-record-malformed-cell"
  | "parcel-record-store-not-configured";

export type SetbackRulesFactRefusal = {
  state: "refused";
  code: SetbackRulesFactRefusalCode;
  source: typeof SETBACK_RULES_FACT_SOURCE;
  entityId: string | null;
  reason: string;
};

export type SetbackRulesFactRead =
  | SetbackRulesFactPresent
  | SetbackRulesFactAbsent
  | SetbackRulesFactRefusal;

export function notCutOverSetbackRulesFact(
  parcelNodeId: string,
): SetbackRulesFactRefusal {
  return {
    state: "refused",
    code: "not-cut-over",
    source: SETBACK_RULES_FACT_SOURCE,
    entityId: parcelNodeId,
    reason:
      "setbackRules has no legacy serve path -- it is served only from parcel_record, and only once this (county, rail) pair is slated with a passing gate verdict. Not there yet for this parcel.",
  };
}
