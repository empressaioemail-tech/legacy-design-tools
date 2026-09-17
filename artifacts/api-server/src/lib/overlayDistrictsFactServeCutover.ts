/**
 * Serve-layer cutover wrapper for overlayDistricts (F-01, serve/prod cutover
 * for ACQUIRE-GIS wave 1 + PARCEL wave 2,
 * `_decisions/2026-09-02_step7_consumer_c_then_b.md`).
 *
 * The "not served from the ledger" branch is not a legacy reader --
 * overlayDistricts has none. It resolves to `notCutOverOverlayDistrictsFact`.
 * NOTE the writer only writes a cell inside the 12 confirmed cities; every
 * parcel outside them was never examined, so before this rail has a gate
 * verdict most of its slated pairs still refuse -- and under P-297 that
 * refusal names the PARCEL's own cell state, which is the honest answer.
 *
 * P-297 (2026-09-16, operator ruling A-193) replaced the county-verdict
 * gate this file used to apply. Until P-297 the wrapper asked
 * `resolveAllowlist` for (record | legacy | refused) and served the record's
 * own answer only on `record`, which required a PASSING county gate verdict
 * -- so a slated county whose verdict read `refuse` (one unaccounted cell on
 * this rail, anywhere in the county) fell back for EVERY parcel in it,
 * including parcels whose own cell was earned and correct. The verdict is a
 * completeness and publish grade; it stopped deciding what a parcel shows.
 *
 * The wrapper now decides from PARCEL_RECORD_SLATE and the PARCEL'S OWN CELL
 * through the one rule in `cellServeRule.ts`:
 *
 *   - pair NOT in the slate -> the fallback below, short-circuiting before any
 *     I/O, byte-identical to the behavior before this file existed. The slate,
 *     not the verdict, is the cut-over switch.
 *   - pair in the slate -> this parcel's own cell, served through the record
 *     adapter AS-IS: a value with its source and vintage, a stated absence
 *     with its reason, or a declared refusal carrying the cell's own reason
 *     (unaccounted, engine-refused, cell-miss, malformed-cell,
 *     store-not-configured). Never the legacy or baked value.
 *
 * The county verdict is no longer read on this path; `cellServeRule.test.ts`
 * fails if this file imports the verdict reader again.
 */

import { loadCellServeDecision } from "./cellServeRule";
import { parseParcelNodeId } from "./parcelNodeId";
import { overlayDistrictsFactFromParcelRecord } from "./overlayDistrictsFactFromParcelRecord";
import {
  notCutOverOverlayDistrictsFact,
  OVERLAY_DISTRICTS_RAIL_KEY,
  type OverlayDistrictsFactRead,
} from "./overlayDistrictsFactRead";

export async function loadOverlayDistrictsFactForServe(
  parcelNodeId: string,
): Promise<OverlayDistrictsFactRead> {
  const parsed = parseParcelNodeId(parcelNodeId);
  if (!parsed) {
    return notCutOverOverlayDistrictsFact(parcelNodeId);
  }
  const decision = await loadCellServeDecision(
    parsed.countyFips,
    parsed.propId,
    OVERLAY_DISTRICTS_RAIL_KEY,
  );
  if (decision.serve === "current-path") {
    return notCutOverOverlayDistrictsFact(parcelNodeId);
  }
  return overlayDistrictsFactFromParcelRecord(parcelNodeId);
}
