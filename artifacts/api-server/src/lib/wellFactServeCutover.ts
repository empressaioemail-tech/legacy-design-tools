/**
 * The PARCEL-B-READER integration point (F-01,
 * `_decisions/2026-09-02_step7_consumer_c_then_b.md`), extended by
 * PARCEL-B-SLATE1 with the real parcel_record-to-WellFactRead adapter.
 * Proves the reader + allowlist mechanism is wired into a live call site
 * rather than dormant code nobody calls -- the exact defect the step-5
 * review named for the publish gate, not repeated here for the allowlist.
 *
 * PARCEL_RECORD_SLATE now carries real (county, "wells") entries
 * (PARCEL-B-SLATE1's wells cutover) -- the allowlist check below reaches
 * the verdict store for those pairs and resolves 'record' when the gate
 * passes. injectedVerdictStore's `undefined` default resolves to the real
 * env-connected pool via resolveVerdictStore (parcelGateVerdictRead.ts),
 * not to `null` -- see that function's own comment for why this mattered.
 */

import { resolveAllowlist } from "./parcelRecordAllowlist";
import { countyFipsFromParcelNodeId } from "./verdictLayerServe";
import { resolveVerdictStore } from "./parcelGateVerdictRead";
import { wellFactFromParcelRecord } from "./wellFactFromParcelRecord";
import { loadWellFactAtom, type WellFactRead } from "./wellFactRead";
import type { ParcelRecordQueryable } from "./parcelRecordCellRead";

const WELLS_RAIL_KEY = "wells";

/**
 * Test/deploy seam for the verdict store this wrapper consults.
 * `undefined` (the default) means: use the real env-resolved pool
 * (resolveVerdictStore). Tests inject an explicit store or `null`.
 */
let injectedVerdictStore: ParcelRecordQueryable | null | undefined;

export function setWellsVerdictStoreForTests(
  store: ParcelRecordQueryable | null,
): void {
  injectedVerdictStore = store;
}

export function resetWellsVerdictStoreForTests(): void {
  injectedVerdictStore = undefined;
}

export async function loadWellFactForServe(
  parcelNodeId: string,
): Promise<WellFactRead> {
  const countyFips = countyFipsFromParcelNodeId(parcelNodeId);
  if (!countyFips) {
    // Malformed parcelNodeId: unchanged behavior, let loadWellFactAtom's
    // own bind logic produce its existing refusal shape.
    return loadWellFactAtom(parcelNodeId);
  }
  const state = await resolveAllowlist(
    resolveVerdictStore(injectedVerdictStore),
    countyFips,
    WELLS_RAIL_KEY,
  );
  if (state !== "record") {
    return loadWellFactAtom(parcelNodeId);
  }
  return wellFactFromParcelRecord(parcelNodeId);
}
