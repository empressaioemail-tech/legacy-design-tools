/**
 * The PARCEL-B-READER integration point (F-01,
 * `_decisions/2026-09-02_step7_consumer_c_then_b.md`), extended by
 * PARCEL-B-SLATE1 with the real parcel_record-to-WellFactRead adapter.
 * Proves the reader + allowlist mechanism is wired into a live call site
 * rather than dormant code nobody calls -- the exact defect the step-5
 * review named for the publish gate, not repeated here for the allowlist.
 *
 * With PARCEL_RECORD_SLATE empty (PARCEL-B-READER's shipped state), the
 * allowlist check below short-circuits to 'legacy' synchronously, in
 * memory, before any I/O -- loadWellFactAtom runs exactly as it did before
 * this file existed, byte-identical, which is what that card's staging
 * probe verified. PARCEL-B-SLATE1 slates (county, "wells") pairs one at a
 * time; the 'record' branch below only becomes reachable for a slated,
 * gate-passing pair.
 */

import { resolveAllowlist } from "./parcelRecordAllowlist";
import { countyFipsFromParcelNodeId } from "./verdictLayerServe";
import { wellFactFromParcelRecord } from "./wellFactFromParcelRecord";
import { loadWellFactAtom, type WellFactRead } from "./wellFactRead";
import type { ParcelRecordQueryable } from "./parcelRecordCellRead";

const WELLS_RAIL_KEY = "wells";

/**
 * Test/deploy seam for the verdict store this wrapper consults. Not the
 * parcel_record store itself -- that only matters once the 'record' branch
 * is real. `undefined` (the default, and every production path today)
 * means: do not even attempt to configure a store, since the slate is
 * empty and resolveAllowlist never reaches the store for an unslated pair.
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
    injectedVerdictStore ?? null,
    countyFips,
    WELLS_RAIL_KEY,
  );
  if (state !== "record") {
    return loadWellFactAtom(parcelNodeId);
  }
  return wellFactFromParcelRecord(parcelNodeId);
}
