/**
 * Serve-layer cutover wrapper for setbacks (setbackFrontFt + setbackSideFt +
 * setbackRearFt + setbackCornerFt) (F-01, PARCEL-B-SLATE3, OPS-16
 * A-096/A-097/A-098), mirroring zoningFactServeCutover.ts's own contract
 * exactly -- see that file's module doc for why there is no legacy fallback
 * loader here (setbacks' legacy value is whatever nodeFacetBakeTier1.ts's
 * computeTier1Envelope already wrote at bake time, not read live) and why a
 * record-side refusal is served as-is once gated in rather than falling
 * back to legacy.
 *
 * Gated on setbackFrontFt's own slate/verdict entry alone (representative of
 * the whole four-key group -- see setbacksFactFromParcelRecord.ts's module
 * doc).
 */

import { resolveAllowlist } from "./parcelRecordAllowlist";
import { countyFipsFromParcelNodeId } from "./verdictLayerServe";
import { resolveVerdictStore } from "./parcelGateVerdictRead";
import { setbacksFactFromParcelRecord } from "./setbacksFactFromParcelRecord";
import { SETBACK_FRONT_FT_RAIL_KEY, type SetbacksFactRead } from "./setbacksFactFromParcelRecord";
import type { ParcelRecordQueryable } from "./parcelRecordCellRead";

/**
 * Test/deploy seam for the verdict store this wrapper consults.
 * `undefined` (the default) means: use the real env-resolved pool
 * (resolveVerdictStore, parcelGateVerdictRead.ts). Tests inject an
 * explicit store or `null`.
 */
let injectedVerdictStore: ParcelRecordQueryable | null | undefined;

export function setSetbacksVerdictStoreForTests(
  store: ParcelRecordQueryable | null,
): void {
  injectedVerdictStore = store;
}

export function resetSetbacksVerdictStoreForTests(): void {
  injectedVerdictStore = undefined;
}

/**
 * `null` means "not cut over for this parcel -- caller keeps its own
 * bake-derived envelope/setbacks section unchanged." A non-null result means
 * the (county, setbackFrontFt) pair is slated and gate-passing: the record's
 * own SetbacksFactRead is authoritative, served as-is.
 */
export async function loadSetbacksFactForServe(
  parcelNodeId: string,
): Promise<SetbacksFactRead | null> {
  const countyFips = countyFipsFromParcelNodeId(parcelNodeId);
  if (!countyFips) return null;
  const state = await resolveAllowlist(
    resolveVerdictStore(injectedVerdictStore),
    countyFips,
    SETBACK_FRONT_FT_RAIL_KEY,
  );
  if (state !== "record") return null;
  return setbacksFactFromParcelRecord(parcelNodeId);
}
