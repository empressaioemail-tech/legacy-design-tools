/**
 * Serve-layer cutover wrapper for setbackRules (F-01, OPS-21 P-148 / P-132),
 * on the allowlist pattern maxImperviousCoverPctFactServeCutover.ts
 * established.
 *
 * The "not record" branch here is not a legacy reader -- setbackRules has
 * none (distinct from its Ft-suffixed siblings, which fall back to their
 * own bake-derived envelope section via setbacksFactServeCutover.ts's own,
 * different contract -- see that module's doc). NOT SLATED by this card
 * (fails the gate on every in-scope county, blocked on the 3,376-parcel
 * zoningDistrict residual Z1/P-147 owns -- see parcelRecordAllowlist.ts).
 * Every (county, "setbackRules") pair therefore resolves to
 * notCutOverSetbackRulesFact today, by construction, not by omission.
 */

import { resolveAllowlist } from "./parcelRecordAllowlist";
import { countyFipsFromParcelNodeId } from "./verdictLayerServe";
import { resolveVerdictStore } from "./parcelGateVerdictRead";
import { setbackRulesFactFromParcelRecord } from "./setbackRulesFactFromParcelRecord";
import {
  notCutOverSetbackRulesFact,
  SETBACK_RULES_RAIL_KEY,
  type SetbackRulesFactRead,
} from "./setbackRulesFactRead";
import type { ParcelRecordQueryable } from "./parcelRecordCellRead";

let injectedVerdictStore: ParcelRecordQueryable | null | undefined;

export function setSetbackRulesVerdictStoreForTests(
  store: ParcelRecordQueryable | null,
): void {
  injectedVerdictStore = store;
}

export function resetSetbackRulesVerdictStoreForTests(): void {
  injectedVerdictStore = undefined;
}

export async function loadSetbackRulesFactForServe(
  parcelNodeId: string,
): Promise<SetbackRulesFactRead> {
  const countyFips = countyFipsFromParcelNodeId(parcelNodeId);
  if (!countyFips) {
    return notCutOverSetbackRulesFact(parcelNodeId);
  }
  const state = await resolveAllowlist(
    resolveVerdictStore(injectedVerdictStore),
    countyFips,
    SETBACK_RULES_RAIL_KEY,
  );
  if (state !== "record") {
    return notCutOverSetbackRulesFact(parcelNodeId);
  }
  return setbackRulesFactFromParcelRecord(parcelNodeId);
}
