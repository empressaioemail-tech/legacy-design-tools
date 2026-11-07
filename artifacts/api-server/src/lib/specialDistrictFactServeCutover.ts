/**
 * PARCEL-B-SLATE1 (F-01, `_decisions/2026-09-02_step7_consumer_c_then_b.md`)
 * serve-layer cutover wrapper for specialDistricts, on the pattern
 * wellFactServeCutover.ts (PARCEL-B-READER) established.
 *
 * P-297 (2026-09-16, operator ruling A-193) replaced the county-verdict gate
 * this file used to apply: the decision now comes from PARCEL_RECORD_SLATE
 * and the parcel's own cell, through the one rule in `cellServeRule.ts`. An
 * unslated pair runs `loadSpecialDistrictFactAtom` exactly as before, with no
 * I/O; a slated pair serves this parcel's cell through the record adapter,
 * including the adapter's own typed refusal. Caldwell (48055) is
 * deliberately NOT on this rail's slate, so it keeps the atom path -- a slate
 * decision, made once and visible here, not a county-wide verdict.
 */

import { loadCellServeDecision } from "./cellServeRule";
import { parseParcelNodeId } from "./parcelNodeId";
import { specialDistrictFactFromParcelRecord } from "./specialDistrictFactFromParcelRecord";
import {
  loadSpecialDistrictFactAtom,
  type SpecialDistrictFactRead,
} from "./specialDistrictFactRead";

const SPECIAL_DISTRICTS_RAIL_KEY = "specialDistricts";

export async function loadSpecialDistrictFactForServe(
  parcelNodeId: string,
): Promise<SpecialDistrictFactRead> {
  const parsed = parseParcelNodeId(parcelNodeId);
  if (!parsed) {
    // Malformed parcelNodeId: unchanged behavior, let the atom read's own
    // bind logic produce its existing refusal shape.
    return loadSpecialDistrictFactAtom(parcelNodeId);
  }
  const decision = await loadCellServeDecision(
    parsed.countyFips,
    parsed.propId,
    SPECIAL_DISTRICTS_RAIL_KEY,
  );
  if (decision.serve === "current-path") {
    return loadSpecialDistrictFactAtom(parcelNodeId);
  }
  return specialDistrictFactFromParcelRecord(parcelNodeId);
}
