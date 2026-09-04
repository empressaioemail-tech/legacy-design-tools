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
 * Dollar rails (assessedValue, improvementValue, landValue, marketValue)
 * plus the two structural rails (livingAreaSqft, yearBuilt) were held out of
 * PARCEL_RECORD_SLATE until PARCEL-S6-COLLISION closed. It closed
 * 2026-09-02 (_inbox/2026-09-02_parcel-s6-collision_close.json); PARCEL-B-
 * SLATE2 is the sanctioned cutover card that added them below.
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
 *
 * marketValue, assessedValue, landValue, improvementValue, livingAreaSqft,
 * yearBuilt, ALL SIX counties including Caldwell (F-01, PARCEL-B-SLATE2,
 * 2026-09-03): every one of the 36 (county, rail) pairs passes the gate
 * live (gate-rail-cli.mjs, unaccountedCount=0 for all 36 -- these six rails
 * have no txgio-geometry dependency at all, sourced from cad_property via a
 * CAD-attribute join, not spatial containment, so Caldwell's known geometry
 * gap does not apply here the way it does for wells/specialDistricts/flood).
 * No excluded/refused pair exists in this set. Unlike wells/specialDistricts/
 * cityLimits/flood (each a whole-function legacy-loader swap), these six
 * rails are served via a request-time OVERLAY onto the legacy value
 * (cadRollServeCutover.ts) -- the legacy bake/live-read path is never
 * modified, only overlaid where the allowlist resolves to 'record'.
 *
 * utilityService, ALL SIX counties including Caldwell (F-01, serve/prod
 * cutover for ACQUIRE-GIS wave 1 + PARCEL wave 2, 2026-09-04): sourced from
 * tx_puct_ccn via a statewide centroid-in-polygon sweep with no per-county
 * restriction in the writer (parcel-utility-service.mjs) and no
 * txgio-geometry dependency of the kind that holds Caldwell out of
 * wells/specialDistricts -- so Caldwell is slated on the same footing as
 * every other program county, matching cityLimits' and flood's own
 * reasoning, not wells/specialDistricts'. UNLIKE every rail above,
 * utilityService has NO legacy serve path at all (verified: no reference to
 * `utilityService`, `sewer`, or CCN-adjacent fields exists anywhere in
 * `artifacts/api-server/src` before this card) -- there is nothing to swap
 * and nothing to retire. No gate verdict has been computed for this rail as
 * of this card (the scheduled evaluation covers the four PARCEL-B-SLATE1
 * rails and PARCEL-B-SLATE2's six only; see PARCEL-B-GATE-SCHED's own close,
 * which documents no automatic trigger exists) -- every one of these six
 * entries therefore resolves to 'legacy' (utilityServiceFactServeCutover.ts's
 * own typed not-cut-over refusal, since there is no legacy reader) until a
 * gate evaluation for utilityService lands. Slating ahead of the verdict is
 * fail-closed by construction, per this file's own PARCEL-B-READER
 * precedent (shipped with an empty slate for the same reason).
 *
 * overlayDistricts, ALL SIX counties including Caldwell (F-01, serve/prod
 * cutover, 2026-09-04): the writer (parcel-overlay-districts.mjs) itself
 * scans all 6 program counties with no documented per-county exclusion --
 * unlike wells/specialDistricts, there is no stated txgio-geometry reason to
 * hold any county out, so all 6 are slated on the writer's own declared
 * scope rather than on an inferred guess about which counties happen to
 * contain the 12 confirmed cities. No legacy serve path exists for this
 * rail either. OPEN QUESTION, not resolved by this cutover: the writer
 * deliberately leaves a parcel's cell untouched (stays 'unaccounted') for
 * every parcel outside all 12 confirmed cities -- the large majority of
 * parcels in every county -- so a per-county unaccountedCount-based gate
 * verdict may never read 'pass' for this rail unless gate-rail-cli.mjs (out
 * of this repo's scope) can distinguish "outside this rail's own reach"
 * from "never examined". No gate verdict exists for this rail as of this
 * card; every entry resolves to 'legacy' until one does.
 *
 * agValuation, Williamson (48491) + Travis (48453) ONLY (F-01, serve/prod
 * cutover, 2026-09-04): the writer (parcel-ag-valuation.mjs) refuses any
 * other county outright (COUNTY_NOT_IN_SCOPE) -- the other four program
 * counties are correctly never slated, not an oversight. No legacy serve
 * path exists for this rail. No gate verdict exists for this rail as of
 * this card; every entry resolves to 'legacy' until one does.
 *
 * schoolDistrict, ALL SIX counties including Caldwell (F-01, serve/prod
 * cutover, 2026-09-04): statewide source (tx_school_district), scanned
 * per-county by the writer with no per-county exclusion -- every one of the
 * 6 program counties is slated. No legacy serve path exists for this rail.
 * KNOWN ANOMALY CLASS: 13 parcels program-wide are zero-hit/multi-hit
 * centroids the writer deliberately never wrote a cell for (see
 * schoolDistrictFactRead.ts's module doc) -- these serve as an ordinary
 * `unaccounted` refusal, not a defect. No gate verdict exists for this
 * rail as of this card; every entry resolves to 'legacy' until one does.
 *
 * maxImperviousCoverPct, Travis (48453) ONLY / Austin scope (F-01,
 * serve/prod cutover, 2026-09-04): the writer refuses every other county
 * outright, matching agValuation's own COUNTY_NOT_IN_SCOPE pattern. Even
 * within Travis, most parcels sit outside Austin's watershed-regulation
 * area entirely and are deliberately left untouched (not an anomaly, per
 * that job's own module doc) -- the same large-scale "unaccounted by
 * design" shape as overlayDistricts, so the same open question about
 * gate-evaluability applies here too. No legacy serve path exists for this
 * rail. No gate verdict exists for this rail as of this card; every entry
 * resolves to 'legacy' until one does.
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
  "48021:marketValue",
  "48055:marketValue",
  "48209:marketValue",
  "48309:marketValue",
  "48453:marketValue",
  "48491:marketValue",
  "48021:assessedValue",
  "48055:assessedValue",
  "48209:assessedValue",
  "48309:assessedValue",
  "48453:assessedValue",
  "48491:assessedValue",
  "48021:landValue",
  "48055:landValue",
  "48209:landValue",
  "48309:landValue",
  "48453:landValue",
  "48491:landValue",
  "48021:improvementValue",
  "48055:improvementValue",
  "48209:improvementValue",
  "48309:improvementValue",
  "48453:improvementValue",
  "48491:improvementValue",
  "48021:livingAreaSqft",
  "48055:livingAreaSqft",
  "48209:livingAreaSqft",
  "48309:livingAreaSqft",
  "48453:livingAreaSqft",
  "48491:livingAreaSqft",
  "48021:yearBuilt",
  "48055:yearBuilt",
  "48209:yearBuilt",
  "48309:yearBuilt",
  "48453:yearBuilt",
  "48491:yearBuilt",
  "48021:utilityService",
  "48055:utilityService",
  "48209:utilityService",
  "48309:utilityService",
  "48453:utilityService",
  "48491:utilityService",
  "48021:overlayDistricts",
  "48055:overlayDistricts",
  "48209:overlayDistricts",
  "48309:overlayDistricts",
  "48453:overlayDistricts",
  "48491:overlayDistricts",
  "48491:agValuation",
  "48453:agValuation",
  "48021:schoolDistrict",
  "48055:schoolDistrict",
  "48209:schoolDistrict",
  "48309:schoolDistrict",
  "48453:schoolDistrict",
  "48491:schoolDistrict",
  "48453:maxImperviousCoverPct",
]);

/**
 * Historical: the five dollar-named rail keys this allowlist held out of
 * the slate pending PARCEL-S6-COLLISION. That gate lifted (PARCEL-B-SLATE2,
 * 2026-09-03) -- kept as a named list for any future code that needs to
 * enumerate "the dollar rails" specifically (e.g. yearBuilt is a rail but
 * not a dollar amount, so it is deliberately excluded from this set).
 */
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
