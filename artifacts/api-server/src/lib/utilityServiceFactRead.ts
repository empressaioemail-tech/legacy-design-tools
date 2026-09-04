/**
 * utilityService fact type (F-01, serve/prod cutover for ACQUIRE-GIS wave 1
 * + PARCEL wave 2, `_decisions/2026-09-02_step7_consumer_c_then_b.md`).
 *
 * UNLIKE wellFactRead.ts / specialDistrictFactRead.ts / ownerFactRead.ts,
 * this module is NOT a legacy atom reader. There is no pre-existing
 * utilityService serve path anywhere in this repo (verified: no reference
 * to `utilityService`, `sewer`, or CCN-adjacent fields exists in
 * `artifacts/api-server/src` before this card) -- utilityService is
 * genuinely new-to-serve, sourced only from parcel_record
 * (utilityServiceFactFromParcelRecord.ts). This file therefore carries only
 * the shared type and the one refusal a "no legacy source exists" cutover
 * needs (`notCutOverUtilityServiceFact`), mirroring `studioGatedOwnerFactRefusal`'s
 * shape in spirit but for "never cut over yet" rather than "gated by
 * entitlement".
 *
 * No `tried`/`boundAs` dual-grammar fields (contrast wellFactRead.ts /
 * specialDistrictFactRead.ts): those exist there to document an atom-store
 * prefix-matching attempt this rail never makes -- there is only one
 * source, parcel_record, keyed by the plain place_key.
 *
 * Water, sewer, and electric are independent sub-types (parcel-utility-
 * service.mjs's own fixed companion-row slots: rowIndex 0 = water, rowIndex
 * 1 = sewer, rowIndex 2 = electric -- electric added in PARCEL wave 2,
 * source tiles the entire state so it is present for effectively every
 * parcel), not competing candidates the way wells/specialDistricts pick a
 * single "lead" -- a parcel served by more than one utility is not an
 * ambiguity to resolve, so `present` carries all three slots independently,
 * any or all `null`.
 *
 * BUGFIX 2026-09-04 (post-deploy live-witness check): the original cutover
 * only read rowIndex 0/1 (water/sewer), reflecting only the wave-1 writer
 * this adapter was built against. Wave 2 added the electric slot to the
 * SAME job (parcel-utility-service.mjs), which this card's own Phase 0
 * research read from the wave-1 clone and never re-checked against wave
 * 2's version of that specific file. Consequence: any parcel whose only
 * populated slot was electric (a large share of the population, since
 * electric's HIFLD source tiles the whole state while sewer covers ~51%)
 * was served a fabricated `parcel-record-malformed-cell` refusal instead of
 * its real electric utility record -- caught live in production via the
 * witness-parcel check this card's own dispatch mandated, not by a unit
 * test (none had a fixture with only rowIndex 2 populated).
 */

export const UTILITY_SERVICE_FACT_SOURCE = "utility-service-fact" as const;
export const UTILITY_SERVICE_RAIL_KEY = "utilityService" as const;

export type UtilityServiceEntry = {
  ccnNo: string | null;
  utility: string | null;
  status: string | null;
  ccnType: string | null;
};

export type UtilityServiceFactPresent = {
  state: "present";
  source: typeof UTILITY_SERVICE_FACT_SOURCE;
  entityId: string;
  /** Independent slots -- see module doc. All three null never reaches this variant (that is `absent`). */
  water: UtilityServiceEntry | null;
  sewer: UtilityServiceEntry | null;
  electric: UtilityServiceEntry | null;
  sourceAdapter: "parcel_record";
  sourceVintage: string | null;
  evaluatedAt: string | null;
};

export type UtilityServiceFactAbsent = {
  state: "absent";
  source: typeof UTILITY_SERVICE_FACT_SOURCE;
  entityId: string;
  absence: { kind: string; reason: string } | null;
  verifiedAbsence: boolean | null;
  sourceTier: string | null;
  sourceAdapter: "parcel_record";
  sourceVintage: string | null;
};

export type UtilityServiceFactRefusalCode =
  | "invalid-parcel-node-id"
  | "not-cut-over"
  | "parcel-record-unaccounted"
  | "parcel-record-engine-refused"
  | "parcel-record-cell-miss"
  | "parcel-record-malformed-cell"
  | "parcel-record-store-not-configured";

export type UtilityServiceFactRefusal = {
  state: "refused";
  code: UtilityServiceFactRefusalCode;
  source: typeof UTILITY_SERVICE_FACT_SOURCE;
  entityId: string | null;
  reason: string;
};

export type UtilityServiceFactRead =
  | UtilityServiceFactPresent
  | UtilityServiceFactAbsent
  | UtilityServiceFactRefusal;

/**
 * The "legacy" branch of the serve-cutover wrapper for every (county, rail)
 * pair not resolved to 'record' -- unlike wells/specialDistricts/cityLimits/
 * owner, there is no real alternate computation to fall back to, so this is
 * an honest, typed "not live yet" refusal rather than a call to a legacy
 * reader that does not exist. Distinct from every parcel_record-internal
 * refusal code above: this one is about the ALLOWLIST decision (not slated,
 * no pass verdict, gate never evaluated this pair), not about the cell.
 */
export function notCutOverUtilityServiceFact(
  parcelNodeId: string,
): UtilityServiceFactRefusal {
  return {
    state: "refused",
    code: "not-cut-over",
    source: UTILITY_SERVICE_FACT_SOURCE,
    entityId: parcelNodeId,
    reason:
      "utilityService has no legacy serve path -- it is served only from parcel_record, and only once this (county, rail) pair is slated with a passing gate verdict. Not there yet for this parcel.",
  };
}
