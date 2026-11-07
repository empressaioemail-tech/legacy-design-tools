/**
 * Serve-layer cutover wrapper for utilityService (F-01, serve/prod cutover
 * for ACQUIRE-GIS wave 1 + PARCEL wave 2,
 * `_decisions/2026-09-02_step7_consumer_c_then_b.md`), on the allowlist
 * pattern wellFactServeCutover.ts (PARCEL-B-READER/PARCEL-B-SLATE1)
 * established.
 *
 * The "not served from the ledger" branch here is not a legacy reader --
 * utilityService has none (see utilityServiceFactRead.ts's module doc). It
 * resolves to `notCutOverUtilityServiceFact`, an honest typed "not live yet"
 * refusal rather than a call to an atom store that was never written for this
 * rail. This still fails closed the same way: nothing is fabricated, and a
 * typed refusal is indistinguishable in shape from every other refusal this
 * module can produce.
 *
 * P-297 (2026-09-16, operator ruling A-193) narrowed WHEN that branch runs.
 * It used to run for any pair that was not `record`, which meant a slated
 * county whose gate verdict read `refuse` served `not-cut-over` for every
 * parcel even though this rail's cells exist and are earned in that county.
 * It now runs only for a pair OUTSIDE PARCEL_RECORD_SLATE: the slate is the
 * cut-over switch, and a slated pair serves this parcel's own cell through
 * the record adapter, including the adapter's own typed refusal.
 *
 * NO GATE VERDICT EXISTS for this rail at the time of this card, which is
 * exactly the case the ruling is about: a pair slated ahead of its verdict
 * used to resolve `legacy` (here: not-cut-over) forever. Under P-297 it
 * serves its cells as soon as they exist, and a cell that is not there yet
 * is a declared refusal WITH ITS REASON.
 */

import { loadCellServeDecision } from "./cellServeRule";
import { parseParcelNodeId } from "./parcelNodeId";
import { utilityServiceFactFromParcelRecord } from "./utilityServiceFactFromParcelRecord";
import {
  notCutOverUtilityServiceFact,
  UTILITY_SERVICE_RAIL_KEY,
  type UtilityServiceFactRead,
} from "./utilityServiceFactRead";

export async function loadUtilityServiceFactForServe(
  parcelNodeId: string,
): Promise<UtilityServiceFactRead> {
  const parsed = parseParcelNodeId(parcelNodeId);
  if (!parsed) {
    return notCutOverUtilityServiceFact(parcelNodeId);
  }
  const decision = await loadCellServeDecision(
    parsed.countyFips,
    parsed.propId,
    UTILITY_SERVICE_RAIL_KEY,
  );
  if (decision.serve === "current-path") {
    return notCutOverUtilityServiceFact(parcelNodeId);
  }
  return utilityServiceFactFromParcelRecord(parcelNodeId);
}
