/**
 * Serve-layer cutover wrapper for schoolDistrict (F-01, serve/prod cutover
 * for ACQUIRE-GIS wave 1 + PARCEL wave 2,
 * `_decisions/2026-09-02_step7_consumer_c_then_b.md`), on the allowlist
 * pattern wellFactServeCutover.ts (PARCEL-B-READER/PARCEL-B-SLATE1)
 * established.
 *
 * UNLIKE that precedent, the "not record" branch here is not a legacy
 * reader -- schoolDistrict has none. Any (county, "schoolDistrict") pair
 * not in PARCEL_RECORD_SLATE, or lacking a passing gate verdict, resolves
 * to `notCutOverSchoolDistrictFact`.
 */

import { resolveAllowlist } from "./parcelRecordAllowlist";
import { countyFipsFromParcelNodeId } from "./verdictLayerServe";
import { resolveVerdictStore } from "./parcelGateVerdictRead";
import { schoolDistrictFactFromParcelRecord } from "./schoolDistrictFactFromParcelRecord";
import {
  notCutOverSchoolDistrictFact,
  SCHOOL_DISTRICT_RAIL_KEY,
  type SchoolDistrictFactRead,
} from "./schoolDistrictFactRead";
import type { ParcelRecordQueryable } from "./parcelRecordCellRead";

/**
 * Test/deploy seam for the verdict store this wrapper consults.
 * `undefined` (the default) means: use the real env-resolved pool
 * (resolveVerdictStore, parcelGateVerdictRead.ts). Tests inject an
 * explicit store or `null`.
 */
let injectedVerdictStore: ParcelRecordQueryable | null | undefined;

export function setSchoolDistrictVerdictStoreForTests(
  store: ParcelRecordQueryable | null,
): void {
  injectedVerdictStore = store;
}

export function resetSchoolDistrictVerdictStoreForTests(): void {
  injectedVerdictStore = undefined;
}

export async function loadSchoolDistrictFactForServe(
  parcelNodeId: string,
): Promise<SchoolDistrictFactRead> {
  const countyFips = countyFipsFromParcelNodeId(parcelNodeId);
  if (!countyFips) {
    return notCutOverSchoolDistrictFact(parcelNodeId);
  }
  const state = await resolveAllowlist(
    resolveVerdictStore(injectedVerdictStore),
    countyFips,
    SCHOOL_DISTRICT_RAIL_KEY,
  );
  if (state !== "record") {
    return notCutOverSchoolDistrictFact(parcelNodeId);
  }
  return schoolDistrictFactFromParcelRecord(parcelNodeId);
}
