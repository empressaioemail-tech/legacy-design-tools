/**
 * Serve-layer cutover wrapper for setbacks (setbackFrontFt + setbackSideFt +
 * setbackRearFt + setbackCornerFt) (F-01, PARCEL-B-SLATE3, OPS-16
 * A-096/A-097/A-098), mirroring zoningFactServeCutover.ts's own contract:
 * there is no legacy fallback loader, so the not-served-from-the-ledger answer
 * is `null`, meaning "the caller keeps its own bake-derived envelope/setbacks
 * section, unchanged".
 *
 * Gated on setbackFrontFt's own slate entry alone (representative of the whole
 * four-key group).
 *
 * This is the rail A-192/A-193 named: setbackFrontFt is slated in all six
 * counties, so under the verdict-as-switch reading a single unaccounted
 * setBackFrontFt cell in a county turned every parcel in it back to the stale
 * bake. Under P-297 the caller only keeps its baked section for a parcel whose
 * pair is UNSLATED; a slated parcel whose own cell is unaccounted now gets a
 * declared refusal instead of a silent stale value.
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
import { setbacksFactFromParcelRecord, SETBACK_FRONT_FT_RAIL_KEY, type SetbacksFactRead } from "./setbacksFactFromParcelRecord";

export async function loadSetbacksFactForServe(
  parcelNodeId: string,
): Promise<SetbacksFactRead | null> {
  const parsed = parseParcelNodeId(parcelNodeId);
  if (!parsed) return null;
  const decision = await loadCellServeDecision(
    parsed.countyFips,
    parsed.propId,
    SETBACK_FRONT_FT_RAIL_KEY,
  );
  if (decision.serve === "current-path") return null;
  return setbacksFactFromParcelRecord(parcelNodeId);
}
