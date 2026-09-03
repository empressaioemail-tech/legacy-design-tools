/**
 * The rail-scoped serve allowlist (F-01, PARCEL-B-READER,
 * `_decisions/2026-09-02_step7_consumer_c_then_b.md`).
 *
 * A rail serves from parcel_record only where this allowlist says
 * "record". Three states per (county, rail):
 *
 *   record  — serve from parcel_record. Only reachable when BOTH (a) the
 *             pair is in the code-owned slate (a deliberate, reviewed cut-
 *             over decision — never auto-derived from a passing gate
 *             verdict alone, because a mechanical PASS does not capture
 *             every product-quality concern; see the dollar-rail / S6 case
 *             below) AND (b) the gate verdict for that pair is 'pass'.
 *   legacy  — keep the old serve path. The default for everything not in
 *             the slate, REGARDLESS of what the gate verdict says. Also
 *             the result of ANY failure to determine a verdict (missing
 *             row, query error, store not configured) — fail CLOSED.
 *   refused — the pair IS in the slate (a cutover was attempted) but the
 *             gate said no (verdict 'refuse' or 'excluded'). Behaves
 *             identically to legacy at the serve layer (old path, nothing
 *             from the record) but is a DISTINCT, visible state: the
 *             decision's own text is "a refused rail-county keeps its old
 *             path, visibly" — this is what makes that visible rather than
 *             indistinguishable from a rail nobody has attempted yet.
 *
 * THIS CARD (PARCEL-B-READER) ships with PARCEL_RECORD_SLATE empty. No rail
 * cuts over here — that is PARCEL-B-SLATE1's job, carrying its own
 * retirement item per rail per the ENFORCEMENT retirement rule. With an
 * empty slate, resolveAllowlistState below returns 'legacy' for every
 * (county, rail) pair unconditionally, which is what the staging probe
 * verifies byte-identical output against.
 *
 * Dollar rails (assessedValue, improvementValue, landValue, marketValue,
 * livingAreaSqft) MUST NOT be added to PARCEL_RECORD_SLATE until
 * PARCEL-S6-COLLISION closes — a hard requirement from the decision, named
 * here so a future edit to this file trips over the comment before
 * shipping a violation.
 */

import { loadParcelGateVerdict } from "./parcelGateVerdictRead";
import type { ParcelRecordQueryable } from "./parcelRecordCellRead";

export type ParcelAllowlistState = "record" | "legacy" | "refused";

/**
 * Code-owned slate of (county, rail) pairs authorized to attempt a
 * parcel_record cutover. Edited only by a dedicated slate card
 * (PARCEL-B-SLATE1 and successors), never by this reader's own logic,
 * never by a gate verdict alone.
 *
 * wells, 5 counties (F-01, PARCEL-B-SLATE1, 2026-09-03): every non-Caldwell
 * program county passes the gate live (gate-rail-cli.mjs, verified
 * unaccountedCount=0 for all five; Caldwell excluded, its known pre-
 * existing txgio geometry gap, stays legacy per this card's own premise 4).
 * LIVE IN PRODUCTION 2026-09-03T04:53Z.
 *
 * specialDistricts, same 5 counties, same reasoning (F-01, PARCEL-B-SLATE1,
 * 2026-09-03): Caldwell also verdict=excluded for specialDistricts.
 * LIVE IN PRODUCTION 2026-09-03T05:53Z.
 *
 * cityLimits, ALL SIX counties including Caldwell (F-01, PARCEL-B-SLATE1,
 * 2026-09-03): unlike wells/specialDistricts/flood, cityLimits has no
 * txgio-geometry dependency (sourced from landing_parcel_jurisdiction) --
 * Caldwell's gate verdict for cityLimits is 'pass', not 'excluded', live-
 * verified in this card's own CP3 grid search.
 *
 * flood, ALL SIX counties including Caldwell (F-01, PARCEL-FLOOD-CUTOVER,
 * 2026-09-03): unlike cityLimits, Caldwell's own flood gate verdict IS
 * 'excluded' (its known txgio geometry gap, live-verified twice --
 * matching wells/specialDistricts' own pattern, not cityLimits'). Caldwell
 * is slated here anyway, deliberately, per this card's own mission: an
 * excluded verdict on a SLATED pair resolves the allowlist to 'refused'
 * (attempted, visible, distinct from an unslated pair's silent 'legacy'
 * default) -- the "owed observed-refusing evidence" this card's own
 * premise names. Unlike wells/specialDistricts (where Caldwell was left
 * OUT of the slate entirely, so it never reaches a visible 'refused'
 * state), flood deliberately includes it to make that distinction real.
 */
export const PARCEL_RECORD_SLATE: ReadonlySet<string> = new Set<string>([
  "48021:wells",
  "48209:wells",
  "48309:wells",
  "48453:wells",
  "48491:wells",
  "48021:specialDistricts",
  "48209:specialDistricts",
  "48309:specialDistricts",
  "48453:specialDistricts",
  "48491:specialDistricts",
  "48021:cityLimits",
  "48055:cityLimits",
  "48209:cityLimits",
  "48309:cityLimits",
  "48453:cityLimits",
  "48491:cityLimits",
  "48021:flood",
  "48055:flood",
  "48209:flood",
  "48309:flood",
  "48453:flood",
  "48491:flood",
]);

export const DOLLAR_RAIL_KEYS: ReadonlySet<string> = new Set([
  "assessedValue",
  "improvementValue",
  "landValue",
  "marketValue",
  "livingAreaSqft",
]);

function slateKey(countyFips: string, railKey: string): string {
  return `${countyFips}:${railKey}`;
}

/**
 * Pure decision function. Tests drive every branch without a store: not in
 * slate (any verdict, including a fabricated 'pass') -> legacy; in slate +
 * no verdict -> legacy; in slate + pass -> record; in slate + refuse ->
 * refused; in slate + excluded -> refused.
 */
export function resolveAllowlistState(
  countyFips: string,
  railKey: string,
  verdict: { verdict: "pass" | "refuse" | "excluded" } | null,
): ParcelAllowlistState {
  if (!PARCEL_RECORD_SLATE.has(slateKey(countyFips, railKey))) return "legacy";
  if (!verdict) return "legacy";
  if (verdict.verdict === "pass") return "record";
  return "refused";
}

/**
 * Full async resolution. Checks slate membership FIRST, synchronously, in
 * memory -- with today's empty slate this means every call short-circuits
 * to 'legacy' WITHOUT ever touching the verdict store. This matters
 * operationally, not just as an optimization: the call site this feeds
 * (brokerageNodeFacets.ts) is a zero-AI, zero-live-compute, anonymous,
 * public hot path whose whole design point is "just a SELECT" -- issuing
 * an unconditional query against a table PARCEL-B-GATE-SCHED may not have
 * created yet, on every request, for a pair that can never resolve to
 * anything but legacy today, would be exactly the kind of needless new
 * failure surface that route's own header comment guards against.
 */
export async function resolveAllowlist(
  verdictStore: ParcelRecordQueryable | null,
  countyFips: string,
  railKey: string,
): Promise<ParcelAllowlistState> {
  if (!PARCEL_RECORD_SLATE.has(slateKey(countyFips, railKey))) return "legacy";
  const verdict = await loadParcelGateVerdict(verdictStore, countyFips, railKey);
  return resolveAllowlistState(countyFips, railKey, verdict);
}
