/**
 * THE ONE CELL-SERVE RULE (P-297, operator ruling A-193,
 * `_decisions/2026-09-16_county_verdict_is_not_the_serve_switch.md`, OPS-24
 * law 7).
 *
 * The (county, rail) gate verdict in `parcel_gate_verdict` answers "is this
 * rail complete enough in this county to publish". It is a grade. Until
 * P-297 the serve path used it as a switch: `parcelRecordAllowlist.ts`'s
 * `resolveAllowlistState` returned `record` only on a `pass` verdict, and the
 * ~19 `*ServeCutover.ts` wrappers served the live ledger only when it did.
 * Because the verdict refuses on a single unaccounted cell, one unaccounted
 * cell anywhere in a county turned EVERY parcel in that county back to the
 * legacy or baked value, including parcels whose own cell was earned.
 *
 * This module is the replacement decision, and it is the ONLY place the
 * decision is made. Slate membership says WHETHER a rail is cut over -- the
 * switch is code-owned config (`PARCEL_RECORD_SLATE`), not the verdict. The
 * parcel's OWN cell says WHAT is served, and there is nothing else to consult:
 *
 *   | cell state                                  | served as                        |
 *   |---------------------------------------------|----------------------------------|
 *   | `value` (incl. a verified zero)             | the value, its source, vintage   |
 *   | `absent-verified`, `not-applicable`         | the stated absence, with reason  |
 *   | `refused`, `unaccounted`                    | a declared refusal, cell's reason|
 *   | no cell, malformed cell, unreadable store   | a declared refusal naming that   |
 *
 * The legacy or baked value is NEVER the answer for a slated rail. An unslated
 * pair keeps its pre-cutover path, untouched.
 *
 * The county verdict is not read here and must not be: the verdict still
 * travels as information (it is the publish grade and it is on the retrieval
 * service's own `/record` rail wire), but no serve decision may branch on it.
 * `cellServeRule.test.ts` fails if any `*ServeCutover.ts` module imports the
 * verdict reader again.
 *
 * TWO ENTRY POINTS, ONE RULE. `resolveCellServeDecision(slated, cell)` is the
 * rule itself: it takes the slate membership and the cell and returns the
 * decision. `isSlatedForCellServe(countyFips, railKey)` is the same function's
 * first branch, extracted so that a wrapper which must ask about several rails
 * before it can afford its own shared reads (cadRollServeCutover.ts's six
 * rails share ONE CTX-B1 value-basis determination) does not have to read six
 * cells to learn the slate answer. They cannot drift: `cellServeRule.test.ts`
 * asserts they agree for every fixture row and for every pair in the slate.
 * `loadCellServeDecision` is the cheap I/O convenience over the same rule --
 * `parcelRecordReaderClient.ts` coalesces and caches one parcel's whole
 * `/record` response for 3s, so reading the cell here and then again inside
 * the rail's adapter costs no extra upstream call.
 */

import { PARCEL_RECORD_SLATE } from "./parcelRecordAllowlist";
import {
  loadParcelRecordCell,
  type ParcelRecordCellRead,
  type ParcelRecordCellRefusalCode,
} from "./parcelRecordCellRead";

export const CELL_SERVE_RULE_ID = "cell-serve-rule-v1" as const;

/** `value`: the cell's value is served. `absence`: a stated absence. `refusal`: a declared refusal. */
export type CellServeForm = "value" | "absence" | "refusal";

export type CellServeAbsenceVerdict = "absent-verified" | "not-applicable";

export type CellServeDecision = {
  /** `cell` = the cell's own answer is served; `current-path` = this rail's pre-cutover path runs untouched. */
  serve: "cell" | "current-path";
  form: CellServeForm | null;
  absenceVerdict: CellServeAbsenceVerdict | null;
  /** The cell reader's own refusal code (the rail's wire names it in its own vocabulary). */
  refusalCode: ParcelRecordCellRefusalCode | null;
  /** The cell's own reason for a refusal, verbatim; null when there is no refusal. */
  reason: string | null;
};

export const CELL_SERVE_NOT_SLATED_REASON = "not-slated" as const;

/** The slate question, alone and without I/O. See this module's "two entry points, one rule". */
export function isSlatedForCellServe(countyFips: string, railKey: string): boolean {
  const county = countyFips.trim();
  if (!county) return false;
  return PARCEL_RECORD_SLATE.has(`${county}:${railKey}`);
}

function currentPath(): CellServeDecision {
  return {
    serve: "current-path",
    form: null,
    absenceVerdict: null,
    refusalCode: null,
    reason: CELL_SERVE_NOT_SLATED_REASON,
  };
}

/**
 * The rule. `cell` is the parcel's own cell for this rail, or `null` when the
 * store had no cell row for it -- never `undefined`, so a caller cannot pass
 * "I did not look" off as "there was nothing there".
 */
export function resolveCellServeDecision(
  slated: boolean,
  cell: ParcelRecordCellRead | null,
): CellServeDecision {
  if (!slated) return currentPath();
  if (!cell) {
    return {
      serve: "cell",
      form: "refusal",
      absenceVerdict: null,
      refusalCode: "no-such-parcel-or-rail",
      reason:
        "No parcel_record_cell row exists for this parcel on this slated rail. " +
        "Refusing rather than serving the legacy or baked value: the store's silence about a " +
        "rail that is supposed to be served from it is not evidence about the parcel.",
    };
  }
  if (cell.state === "present") {
    return {
      serve: "cell",
      form: "value",
      absenceVerdict: null,
      refusalCode: null,
      reason: null,
    };
  }
  if (cell.state === "absent") {
    return {
      serve: "cell",
      form: "absence",
      absenceVerdict: cell.verdict,
      refusalCode: null,
      reason: null,
    };
  }
  return {
    serve: "cell",
    form: "refusal",
    absenceVerdict: null,
    refusalCode: cell.code,
    reason: cell.reason,
  };
}

/** The rule, with the cell read for you. A malformed or missing parcelNodeId is its own refusal. */
export async function loadCellServeDecision(
  countyFips: string,
  propId: string,
  railKey: string,
): Promise<CellServeDecision> {
  if (!isSlatedForCellServe(countyFips, railKey)) return currentPath();
  const cell = await loadParcelRecordCell(countyFips, propId, railKey);
  return resolveCellServeDecision(true, cell);
}
