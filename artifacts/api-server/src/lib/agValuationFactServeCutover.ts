/**
 * Serve-layer cutover wrapper for agValuation (F-01, serve/prod cutover for
 * ACQUIRE-GIS wave 1 + PARCEL wave 2,
 * `_decisions/2026-09-02_step7_consumer_c_then_b.md`), on the allowlist
 * pattern wellFactServeCutover.ts (PARCEL-B-READER/PARCEL-B-SLATE1)
 * established.
 *
 * UNLIKE that precedent, the "not record" branch here is not a legacy
 * reader -- agValuation has none. Any (county, "agValuation") pair not in
 * PARCEL_RECORD_SLATE (which is only Williamson 48491 and Travis 48453; see
 * agValuationFactRead.ts's module doc), or lacking a passing gate verdict,
 * resolves to `notCutOverAgValuationFact`.
 */

import { resolveAllowlist } from "./parcelRecordAllowlist";
import { countyFipsFromParcelNodeId } from "./verdictLayerServe";
import { resolveVerdictStore } from "./parcelGateVerdictRead";
import { agValuationFactFromParcelRecord } from "./agValuationFactFromParcelRecord";
import {
  notCutOverAgValuationFact,
  AG_VALUATION_RAIL_KEY,
  type AgValuationFactRead,
} from "./agValuationFactRead";
import type { ParcelRecordQueryable } from "./parcelRecordCellRead";

/**
 * Test/deploy seam for the verdict store this wrapper consults.
 * `undefined` (the default) means: use the real env-resolved pool
 * (resolveVerdictStore, parcelGateVerdictRead.ts). Tests inject an
 * explicit store or `null`.
 */
let injectedVerdictStore: ParcelRecordQueryable | null | undefined;

export function setAgValuationVerdictStoreForTests(
  store: ParcelRecordQueryable | null,
): void {
  injectedVerdictStore = store;
}

export function resetAgValuationVerdictStoreForTests(): void {
  injectedVerdictStore = undefined;
}

export async function loadAgValuationFactForServe(
  parcelNodeId: string,
): Promise<AgValuationFactRead> {
  const countyFips = countyFipsFromParcelNodeId(parcelNodeId);
  if (!countyFips) {
    return notCutOverAgValuationFact(parcelNodeId);
  }
  const state = await resolveAllowlist(
    resolveVerdictStore(injectedVerdictStore),
    countyFips,
    AG_VALUATION_RAIL_KEY,
  );
  if (state !== "record") {
    return notCutOverAgValuationFact(parcelNodeId);
  }
  return agValuationFactFromParcelRecord(parcelNodeId);
}
