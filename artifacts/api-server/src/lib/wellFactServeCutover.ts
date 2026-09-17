/**
 * The PARCEL-B-READER integration point (F-01,
 * `_decisions/2026-09-02_step7_consumer_c_then_b.md`), extended by
 * PARCEL-B-SLATE1 with the real parcel_record-to-WellFactRead adapter.
 *
 * P-297 (2026-09-16, operator ruling A-193) REPLACED THE GATE THIS FILE USED
 * TO APPLY. Until P-297 this wrapper asked `resolveAllowlist` for a
 * (record | legacy | refused) state and served the live atom only on
 * `record`, which required a PASSING county gate verdict. A slated county
 * whose gate verdict was `refuse` -- one unaccounted cell on this rail,
 * anywhere in the county -- fell back to the atom store for EVERY parcel,
 * including parcels whose own cell was earned and correct. The verdict is a
 * completeness and publish grade; it stopped deciding what a parcel shows.
 *
 * The wrapper now decides from the SLATE and the PARCEL'S OWN CELL, through
 * the one rule in `cellServeRule.ts`:
 *
 *   - (county, "wells") not in PARCEL_RECORD_SLATE -> `loadWellFactAtom`,
 *     byte-identical to before this file existed. The slate is the cut-over
 *     switch, and an unslated pair still short-circuits before any I/O.
 *   - slated -> the record adapter's own answer for THIS parcel's cell is
 *     served, AS-IS: a present well, a verified absence, or the adapter's own
 *     typed refusal (unaccounted, engine-refused, cell-miss,
 *     malformed-cell, store-not-configured). NEVER the atom store, and never
 *     the stale atom value, once a pair is slated.
 *
 * The county verdict is no longer read on this path at all; `cellServeRule.
 * test.ts` fails if this file imports the verdict reader again.
 */

import { loadCellServeDecision } from "./cellServeRule";
import { parseParcelNodeId } from "./parcelNodeId";
import { wellFactFromParcelRecord } from "./wellFactFromParcelRecord";
import { loadWellFactAtom, type WellFactRead } from "./wellFactRead";

const WELLS_RAIL_KEY = "wells";

export async function loadWellFactForServe(
  parcelNodeId: string,
): Promise<WellFactRead> {
  const parsed = parseParcelNodeId(parcelNodeId);
  if (!parsed) {
    // Malformed parcelNodeId: unchanged behavior, let loadWellFactAtom's
    // own bind logic produce its existing refusal shape.
    return loadWellFactAtom(parcelNodeId);
  }
  const decision = await loadCellServeDecision(
    parsed.countyFips,
    parsed.propId,
    WELLS_RAIL_KEY,
  );
  if (decision.serve === "current-path") {
    return loadWellFactAtom(parcelNodeId);
  }
  return wellFactFromParcelRecord(parcelNodeId);
}
