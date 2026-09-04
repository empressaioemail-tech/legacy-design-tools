/**
 * Serve-layer cutover wrapper for utilityService (F-01, serve/prod cutover
 * for ACQUIRE-GIS wave 1 + PARCEL wave 2,
 * `_decisions/2026-09-02_step7_consumer_c_then_b.md`), on the allowlist
 * pattern wellFactServeCutover.ts (PARCEL-B-READER/PARCEL-B-SLATE1)
 * established.
 *
 * UNLIKE that precedent, the "not record" branch here is not a legacy
 * reader -- utilityService has none (see utilityServiceFactRead.ts's module
 * doc). Any (county, "utilityService") pair not in PARCEL_RECORD_SLATE, or
 * lacking a passing gate verdict, resolves to `notCutOverUtilityServiceFact`
 * rather than a call to an atom store that was never written for this rail.
 * This still fails closed the same way: nothing is fabricated, and a typed
 * refusal is indistinguishable in shape from every other refusal this
 * module can produce.
 */

import { resolveAllowlist } from "./parcelRecordAllowlist";
import { countyFipsFromParcelNodeId } from "./verdictLayerServe";
import { resolveVerdictStore } from "./parcelGateVerdictRead";
import { utilityServiceFactFromParcelRecord } from "./utilityServiceFactFromParcelRecord";
import {
  notCutOverUtilityServiceFact,
  UTILITY_SERVICE_RAIL_KEY,
  type UtilityServiceFactRead,
} from "./utilityServiceFactRead";
import type { ParcelRecordQueryable } from "./parcelRecordCellRead";

/**
 * Test/deploy seam for the verdict store this wrapper consults.
 * `undefined` (the default) means: use the real env-resolved pool
 * (resolveVerdictStore, parcelGateVerdictRead.ts). Tests inject an
 * explicit store or `null`.
 */
let injectedVerdictStore: ParcelRecordQueryable | null | undefined;

export function setUtilityServiceVerdictStoreForTests(
  store: ParcelRecordQueryable | null,
): void {
  injectedVerdictStore = store;
}

export function resetUtilityServiceVerdictStoreForTests(): void {
  injectedVerdictStore = undefined;
}

export async function loadUtilityServiceFactForServe(
  parcelNodeId: string,
): Promise<UtilityServiceFactRead> {
  const countyFips = countyFipsFromParcelNodeId(parcelNodeId);
  if (!countyFips) {
    return notCutOverUtilityServiceFact(parcelNodeId);
  }
  const state = await resolveAllowlist(
    resolveVerdictStore(injectedVerdictStore),
    countyFips,
    UTILITY_SERVICE_RAIL_KEY,
  );
  if (state !== "record") {
    return notCutOverUtilityServiceFact(parcelNodeId);
  }
  return utilityServiceFactFromParcelRecord(parcelNodeId);
}
