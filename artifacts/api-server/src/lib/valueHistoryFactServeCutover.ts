/**
 * Serve-layer cutover wrapper for valueHistory (F-01, PARCEL-B-SLATE1
 * template, serve/prod cutover,
 * `_decisions/2026-09-02_step7_consumer_c_then_b.md`), on the allowlist
 * pattern wellFactServeCutover.ts (PARCEL-B-READER/PARCEL-B-SLATE1)
 * established.
 *
 * UNLIKE that precedent, the "not record" branch here is not a legacy
 * reader -- valueHistory has none (confirmed by a repo-wide search; see
 * valueHistoryFactRead.ts's module doc). Any (county, "valueHistory") pair
 * not in PARCEL_RECORD_SLATE, or lacking a passing gate verdict, resolves
 * to `notCutOverValueHistoryFact`.
 */

import { resolveAllowlist } from "./parcelRecordAllowlist";
import { countyFipsFromParcelNodeId } from "./verdictLayerServe";
import { resolveVerdictStore } from "./parcelGateVerdictRead";
import { valueHistoryFactFromParcelRecord } from "./valueHistoryFactFromParcelRecord";
import {
  notCutOverValueHistoryFact,
  VALUE_HISTORY_RAIL_KEY,
  type ValueHistoryFactRead,
} from "./valueHistoryFactRead";
import type { ParcelRecordQueryable } from "./parcelRecordCellRead";

/**
 * Test/deploy seam for the verdict store this wrapper consults.
 * `undefined` (the default) means: use the real env-resolved pool
 * (resolveVerdictStore, parcelGateVerdictRead.ts). Tests inject an
 * explicit store or `null`.
 */
let injectedVerdictStore: ParcelRecordQueryable | null | undefined;

export function setValueHistoryVerdictStoreForTests(
  store: ParcelRecordQueryable | null,
): void {
  injectedVerdictStore = store;
}

export function resetValueHistoryVerdictStoreForTests(): void {
  injectedVerdictStore = undefined;
}

export async function loadValueHistoryFactForServe(
  parcelNodeId: string,
): Promise<ValueHistoryFactRead> {
  const countyFips = countyFipsFromParcelNodeId(parcelNodeId);
  if (!countyFips) {
    return notCutOverValueHistoryFact(parcelNodeId);
  }
  const state = await resolveAllowlist(
    resolveVerdictStore(injectedVerdictStore),
    countyFips,
    VALUE_HISTORY_RAIL_KEY,
  );
  if (state !== "record") {
    return notCutOverValueHistoryFact(parcelNodeId);
  }
  return valueHistoryFactFromParcelRecord(parcelNodeId);
}
