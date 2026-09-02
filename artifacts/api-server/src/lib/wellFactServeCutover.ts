/**
 * The one real PARCEL-B-READER integration point this card ships (F-01,
 * `_decisions/2026-09-02_step7_consumer_c_then_b.md`). Proves the reader +
 * allowlist mechanism is wired into a live call site rather than dormant
 * code nobody calls -- the exact defect the step-5 review named for the
 * publish gate, not repeated here for the allowlist.
 *
 * With PARCEL_RECORD_SLATE empty (this card's shipped state), the
 * allowlist check below short-circuits to 'legacy' synchronously, in
 * memory, before any I/O -- loadWellFactAtom runs exactly as it did before
 * this file existed, byte-identical, which is what the staging probe in
 * this card's close verifies.
 *
 * The 'record' branch is NOT a full parcel_record-to-WellFactRead adapter.
 * Building one now, unreachable and unverifiable against a live cutover,
 * would be exactly the unverified-speculative-code smell this repo's own
 * conventions warn against. It is PARCEL-B-SLATE1's job, per rail, carrying
 * its own retirement item -- this branch names that plainly with a typed
 * refusal rather than silently returning something that looks finished.
 */

import { resolveAllowlist } from "./parcelRecordAllowlist";
import { countyFipsFromParcelNodeId } from "./verdictLayerServe";
import { loadWellFactAtom, WELL_FACT_SOURCE, type WellFactRead } from "./wellFactRead";
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
  return {
    state: "refused",
    code: "parcel-record-adapter-not-built",
    source: WELL_FACT_SOURCE,
    tried: [],
    reason:
      "Allowlist resolved to 'record' for wells, but no parcel_record-to-WellFactRead adapter exists yet -- that is PARCEL-B-SLATE1's scope. This branch should be unreachable until that card lands; refusing rather than serving an incomplete shape.",
  };
}
