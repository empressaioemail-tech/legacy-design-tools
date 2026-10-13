/**
 * Serve-layer cutover wrapper for valueHistory (F-01, PARCEL-B-SLATE1 template,
 * serve/prod cutover, `_decisions/2026-09-02_step7_consumer_c_then_b.md`).
 *
 * The "not served from the ledger" branch is not a legacy reader --
 * valueHistory has none (confirmed by a repo-wide search before that card).
 * It resolves to `notCutOverValueHistoryFact`.
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
import { valueHistoryFactFromParcelRecord } from "./valueHistoryFactFromParcelRecord";
import { isRailPlanGatedOnRecord } from "./parcelRecordReaderClient";
import { isSlatedForCellServe } from "./cellServeRule";
import {
  notCutOverValueHistoryFact,
  VALUE_HISTORY_FACT_SOURCE,
  VALUE_HISTORY_RAIL_KEY,
  type ValueHistoryFactRead,
} from "./valueHistoryFactRead";

export async function loadValueHistoryFactForServe(
  parcelNodeId: string,
): Promise<ValueHistoryFactRead> {
  const parsed = parseParcelNodeId(parcelNodeId);
  if (!parsed) {
    return notCutOverValueHistoryFact(parcelNodeId);
  }
  // hauska-engine #525: a value history the reader withheld for this caller's
  // plan is a studio-gated refusal, not a cell miss. (Before #525 such a
  // caller saw the entries with every dollar figure studio-gated; the reader
  // now sends no entries at all without the grant.)
  if (
    isSlatedForCellServe(parsed.countyFips, VALUE_HISTORY_RAIL_KEY) &&
    (await isRailPlanGatedOnRecord(`${parsed.countyFips}:${parsed.propId}`, VALUE_HISTORY_RAIL_KEY))
  ) {
    return {
      state: "refused",
      code: "studio-gated",
      source: VALUE_HISTORY_FACT_SOURCE,
      entityId: parcelNodeId,
      reason:
        "County tax-assessed value history is Studio or Team only, or requires an active property unlock on this parcel.",
    };
  }
  const decision = await loadCellServeDecision(
    parsed.countyFips,
    parsed.propId,
    VALUE_HISTORY_RAIL_KEY,
  );
  if (decision.serve === "current-path") {
    return notCutOverValueHistoryFact(parcelNodeId);
  }
  return valueHistoryFactFromParcelRecord(parcelNodeId);
}
