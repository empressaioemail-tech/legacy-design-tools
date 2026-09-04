/**
 * Serve-layer cutover wrapper for overlayDistricts (F-01, serve/prod
 * cutover for ACQUIRE-GIS wave 1 + PARCEL wave 2,
 * `_decisions/2026-09-02_step7_consumer_c_then_b.md`), on the allowlist
 * pattern wellFactServeCutover.ts (PARCEL-B-READER/PARCEL-B-SLATE1)
 * established.
 *
 * UNLIKE that precedent, the "not record" branch here is not a legacy
 * reader -- overlayDistricts has none (see overlayDistrictsFactRead.ts's
 * module doc). Any (county, "overlayDistricts") pair not in
 * PARCEL_RECORD_SLATE, or lacking a passing gate verdict, resolves to
 * `notCutOverOverlayDistrictsFact`.
 */

import { resolveAllowlist } from "./parcelRecordAllowlist";
import { countyFipsFromParcelNodeId } from "./verdictLayerServe";
import { resolveVerdictStore } from "./parcelGateVerdictRead";
import { overlayDistrictsFactFromParcelRecord } from "./overlayDistrictsFactFromParcelRecord";
import {
  notCutOverOverlayDistrictsFact,
  OVERLAY_DISTRICTS_RAIL_KEY,
  type OverlayDistrictsFactRead,
} from "./overlayDistrictsFactRead";
import type { ParcelRecordQueryable } from "./parcelRecordCellRead";

/**
 * Test/deploy seam for the verdict store this wrapper consults.
 * `undefined` (the default) means: use the real env-resolved pool
 * (resolveVerdictStore, parcelGateVerdictRead.ts). Tests inject an
 * explicit store or `null`.
 */
let injectedVerdictStore: ParcelRecordQueryable | null | undefined;

export function setOverlayDistrictsVerdictStoreForTests(
  store: ParcelRecordQueryable | null,
): void {
  injectedVerdictStore = store;
}

export function resetOverlayDistrictsVerdictStoreForTests(): void {
  injectedVerdictStore = undefined;
}

export async function loadOverlayDistrictsFactForServe(
  parcelNodeId: string,
): Promise<OverlayDistrictsFactRead> {
  const countyFips = countyFipsFromParcelNodeId(parcelNodeId);
  if (!countyFips) {
    return notCutOverOverlayDistrictsFact(parcelNodeId);
  }
  const state = await resolveAllowlist(
    resolveVerdictStore(injectedVerdictStore),
    countyFips,
    OVERLAY_DISTRICTS_RAIL_KEY,
  );
  if (state !== "record") {
    return notCutOverOverlayDistrictsFact(parcelNodeId);
  }
  return overlayDistrictsFactFromParcelRecord(parcelNodeId);
}
