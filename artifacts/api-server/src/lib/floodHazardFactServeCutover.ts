/**
 * PARCEL-FLOOD-CUTOVER (F-01, `_decisions/2026-09-02_step7_consumer_c_then_b.md`)
 * serve-layer cutover wrapper for flood, on the pattern
 * wellFactServeCutover.ts (PARCEL-B-READER / PARCEL-B-SLATE1) established.
 *
 * P-297 (2026-09-16, operator ruling A-193) replaced the county-verdict gate
 * this file used to apply: the decision now comes from PARCEL_RECORD_SLATE
 * and the parcel's own cell, through the one rule in `cellServeRule.ts`. An
 * unslated pair runs `loadFloodHazardFactAtom` exactly as before, with no
 * I/O; a slated pair serves this parcel's cell through the record adapter,
 * including the adapter's own typed refusal. This is the rail the
 * parcelRecordAllowlist.ts slate deliberately included Caldwell (48055) on so
 * that a `refused`/`excluded` verdict would be VISIBLE rather than silent --
 * under P-297 that visible refusal is the PARCEL's, decided by its own cell,
 * not the county's.
 */

import { loadCellServeDecision } from "./cellServeRule";
import { parseParcelNodeId } from "./parcelNodeId";
import { floodHazardFactFromParcelRecord } from "./floodHazardFactFromParcelRecord";
import {
  loadFloodHazardFactAtom,
  type FloodHazardFactRead,
} from "./floodHazardFactRead";

const FLOOD_RAIL_KEY = "flood";

export async function loadFloodHazardFactForServe(
  parcelNodeId: string,
): Promise<FloodHazardFactRead> {
  const parsed = parseParcelNodeId(parcelNodeId);
  if (!parsed) {
    // Malformed parcelNodeId: unchanged behavior, let loadFloodHazardFactAtom's
    // own bind logic produce its existing refusal shape.
    return loadFloodHazardFactAtom(parcelNodeId);
  }
  const decision = await loadCellServeDecision(
    parsed.countyFips,
    parsed.propId,
    FLOOD_RAIL_KEY,
  );
  if (decision.serve === "current-path") {
    return loadFloodHazardFactAtom(parcelNodeId);
  }
  return floodHazardFactFromParcelRecord(parcelNodeId);
}
