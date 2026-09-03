/**
 * PARCEL-FLOOD-CUTOVER (F-01, `_decisions/2026-09-02_step7_consumer_c_then_b.md`)
 * serve-layer cutover wrapper for flood, on the exact pattern
 * wellFactServeCutover.ts (PARCEL-B-READER / PARCEL-B-SLATE1) established.
 * With (county, "flood") absent from PARCEL_RECORD_SLATE, the allowlist
 * check below short-circuits to 'legacy' synchronously, in memory, before
 * any I/O -- loadFloodHazardFactAtom runs exactly as it did before this
 * file existed. The 'record' branch only becomes reachable for a slated,
 * gate-passing pair.
 */

import { resolveAllowlist } from "./parcelRecordAllowlist";
import { countyFipsFromParcelNodeId } from "./verdictLayerServe";
import { resolveVerdictStore } from "./parcelGateVerdictRead";
import { floodHazardFactFromParcelRecord } from "./floodHazardFactFromParcelRecord";
import {
  loadFloodHazardFactAtom,
  type FloodHazardFactRead,
} from "./floodHazardFactRead";
import type { ParcelRecordQueryable } from "./parcelRecordCellRead";

const FLOOD_RAIL_KEY = "flood";

/**
 * Test/deploy seam for the verdict store this wrapper consults.
 * `undefined` (the default) means: use the real env-resolved pool
 * (resolveVerdictStore, parcelGateVerdictRead.ts). Tests inject an
 * explicit store or `null`.
 */
let injectedVerdictStore: ParcelRecordQueryable | null | undefined;

export function setFloodVerdictStoreForTests(
  store: ParcelRecordQueryable | null,
): void {
  injectedVerdictStore = store;
}

export function resetFloodVerdictStoreForTests(): void {
  injectedVerdictStore = undefined;
}

export async function loadFloodHazardFactForServe(
  parcelNodeId: string,
): Promise<FloodHazardFactRead> {
  const countyFips = countyFipsFromParcelNodeId(parcelNodeId);
  if (!countyFips) {
    // Malformed parcelNodeId: unchanged behavior, let loadFloodHazardFactAtom's
    // own bind logic produce its existing refusal shape.
    return loadFloodHazardFactAtom(parcelNodeId);
  }
  const state = await resolveAllowlist(
    resolveVerdictStore(injectedVerdictStore),
    countyFips,
    FLOOD_RAIL_KEY,
  );
  if (state !== "record") {
    return loadFloodHazardFactAtom(parcelNodeId);
  }
  return floodHazardFactFromParcelRecord(parcelNodeId);
}
