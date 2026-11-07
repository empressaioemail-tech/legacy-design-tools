/**
 * Serve-layer cutover wrapper for setbackRules (F-01, OPS-21 P-148 / P-132).
 * The "not served from the ledger" branch is not a legacy reader --
 * setbackRules has none (distinct from its Ft-suffixed siblings, which keep
 * their own bake-derived envelope section via setbacksFactServeCutover.ts's
 * different contract) -- and resolves to `notCutOverSetbackRulesFact`.
 * setbackRules is the one companion-row rail in this group: its cell's value
 * field is null on every present row and the real content lives in
 * parcel_record_companion_row, which its adapter already handles.
 *
 * P-297 (2026-09-16, operator ruling A-193) replaced the county-verdict
 * gate this file used to apply. Until P-297 the wrapper asked
 * `resolveAllowlist` for (record | legacy | refused) and served the record's
 * own answer only on `record`, which required a PASSING county gate verdict
 * -- so a slated county whose verdict read `refuse` (one unaccounted cell on
 * this rail, anywhere in the county) fell back for EVERY parcel in it,
 * including parcels whose own cell was earned and correct. The verdict is a
 * completeness and publish grade; it stopped deciding what a parcel shows.
 *
 * The wrapper now decides from PARCEL_RECORD_SLATE and the PARCEL'S OWN CELL
 * through the one rule in `cellServeRule.ts`:
 *
 *   - pair NOT in the slate -> the fallback below, short-circuiting before any
 *     I/O, byte-identical to the behavior before this file existed. The slate,
 *     not the verdict, is the cut-over switch.
 *   - pair in the slate -> this parcel's own cell, served through the record
 *     adapter AS-IS: a value with its source and vintage, a stated absence
 *     with its reason, or a declared refusal carrying the cell's own reason
 *     (unaccounted, engine-refused, cell-miss, malformed-cell,
 *     store-not-configured). Never the legacy or baked value.
 *
 * The county verdict is no longer read on this path; `cellServeRule.test.ts`
 * fails if this file imports the verdict reader again.
 */

import { loadCellServeDecision } from "./cellServeRule";
import { parseParcelNodeId } from "./parcelNodeId";
import { setbackRulesFactFromParcelRecord } from "./setbackRulesFactFromParcelRecord";
import {
  notCutOverSetbackRulesFact,
  SETBACK_RULES_RAIL_KEY,
  type SetbackRulesFactRead,
} from "./setbackRulesFactRead";

export async function loadSetbackRulesFactForServe(
  parcelNodeId: string,
): Promise<SetbackRulesFactRead> {
  const parsed = parseParcelNodeId(parcelNodeId);
  if (!parsed) {
    return notCutOverSetbackRulesFact(parcelNodeId);
  }
  const decision = await loadCellServeDecision(
    parsed.countyFips,
    parsed.propId,
    SETBACK_RULES_RAIL_KEY,
  );
  if (decision.serve === "current-path") {
    return notCutOverSetbackRulesFact(parcelNodeId);
  }
  return setbackRulesFactFromParcelRecord(parcelNodeId);
}
