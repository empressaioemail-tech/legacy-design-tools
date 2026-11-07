/**
 * Serve-layer cutover wrapper for maxHeightFt (F-01, OPS-21 P-148 / P-133).
 * The "not served from the ledger" branch is not a legacy reader --
 * maxHeightFt has none -- and resolves to `notCutOverMaxHeightFtFact`. Slating
 * this rail is a one-line change in parcelRecordAllowlist.ts once its blocking
 * dependency clears; the call site already exists.
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
import { maxHeightFtFactFromParcelRecord } from "./maxHeightFtFactFromParcelRecord";
import {
  notCutOverMaxHeightFtFact,
  MAX_HEIGHT_FT_RAIL_KEY,
  type MaxHeightFtFactRead,
} from "./maxHeightFtFactRead";

export async function loadMaxHeightFtFactForServe(
  parcelNodeId: string,
): Promise<MaxHeightFtFactRead> {
  const parsed = parseParcelNodeId(parcelNodeId);
  if (!parsed) {
    return notCutOverMaxHeightFtFact(parcelNodeId);
  }
  const decision = await loadCellServeDecision(
    parsed.countyFips,
    parsed.propId,
    MAX_HEIGHT_FT_RAIL_KEY,
  );
  if (decision.serve === "current-path") {
    return notCutOverMaxHeightFtFact(parcelNodeId);
  }
  return maxHeightFtFactFromParcelRecord(parcelNodeId);
}
