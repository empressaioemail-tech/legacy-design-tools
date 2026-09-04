/**
 * PARCEL-B-SLATE1 (F-01, `_decisions/2026-09-02_step7_consumer_c_then_b.md`)
 * serve-layer cutover wrapper for specialDistricts, on the exact pattern
 * wellFactServeCutover.ts (PARCEL-B-READER) established. With
 * (county, "specialDistricts") absent from PARCEL_RECORD_SLATE, the
 * allowlist check below short-circuits to 'legacy' synchronously, in
 * memory, before any I/O -- loadSpecialDistrictFactAtom runs exactly as it
 * did before this file existed. The 'record' branch only becomes reachable
 * for a slated, gate-passing pair.
 */

import { resolveAllowlist } from "./parcelRecordAllowlist";
import { countyFipsFromParcelNodeId } from "./verdictLayerServe";
import { resolveVerdictStore } from "./parcelGateVerdictRead";
import { specialDistrictFactFromParcelRecord } from "./specialDistrictFactFromParcelRecord";
import {
  loadSpecialDistrictFactAtom,
  type SpecialDistrictFactRead,
} from "./specialDistrictFactRead";
import type { ParcelRecordQueryable } from "./parcelRecordCellRead";

const SPECIAL_DISTRICTS_RAIL_KEY = "specialDistricts";

/**
 * Test/deploy seam for the verdict store this wrapper consults.
 * `undefined` (the default) means: use the real env-resolved pool
 * (resolveVerdictStore, parcelGateVerdictRead.ts). Tests inject an
 * explicit store or `null`.
 */
let injectedVerdictStore: ParcelRecordQueryable | null | undefined;

export function setSpecialDistrictsVerdictStoreForTests(
  store: ParcelRecordQueryable | null,
): void {
  injectedVerdictStore = store;
}

export function resetSpecialDistrictsVerdictStoreForTests(): void {
  injectedVerdictStore = undefined;
}

export async function loadSpecialDistrictFactForServe(
  parcelNodeId: string,
): Promise<SpecialDistrictFactRead> {
  const countyFips = countyFipsFromParcelNodeId(parcelNodeId);
  if (!countyFips) {
    // Malformed parcelNodeId: unchanged behavior, let the atom read's own
    // bind logic produce its existing refusal shape.
    return loadSpecialDistrictFactAtom(parcelNodeId);
  }
  const state = await resolveAllowlist(
    resolveVerdictStore(injectedVerdictStore),
    countyFips,
    SPECIAL_DISTRICTS_RAIL_KEY,
  );
  if (state !== "record") {
    return loadSpecialDistrictFactAtom(parcelNodeId);
  }
  return specialDistrictFactFromParcelRecord(parcelNodeId);
}
