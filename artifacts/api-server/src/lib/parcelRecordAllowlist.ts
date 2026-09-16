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
import type { ParcelGateVerdictKind } from "./parcelGateVerdictVocabulary";
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
 * yearBuilt, ALL SIX counties -- Bastrop/Caldwell/Hays/McLennan/Travis/
 * Williamson. Hays was held back by P-177 (2026-09-13) and that hold was
 * LIFTED by P-180 (2026-09-14, OPS-23 wave 5) once the ledger cells were
 * repaired; every one of the 36 (county, rail) pairs originally
 * passed the gate live (gate-rail-cli.mjs, unaccountedCount=0 for all 36 --
 * these six rails have no txgio-geometry dependency at all, sourced from
 * cad_property via a CAD-attribute join, not spatial containment, so
 * Caldwell's known geometry gap does not apply here the way it does for
 * wells/specialDistricts/flood). No excluded/refused pair exists in this
 * set. Unlike wells/specialDistricts/cityLimits/flood (each a whole-function
 * legacy-loader swap), these six rails are served via a request-time OVERLAY
 * onto the legacy value (cadRollServeCutover.ts) -- the legacy bake/live-read
 * path is never modified, only overlaid where the allowlist resolves to
 * 'record'.
 *
 * HAYS HOLDBACK -- ADDED P-177 (2026-09-13), LIFTED P-180 (2026-09-14,
 * OPS-23 wave 5). P-177 held Hays back from these six rails because
 * `parcel_gate_verdict`'s 'pass' means only "every cell is populated"
 * (unaccounted_count=0) -- it has never checked whether a populated cell is
 * CORRECT -- and Hays' record-sourced cells predated the crosswalk
 * protection (`LANDUSE_JOIN_HOLD_FIPS`, hauska-engine `fact-writer-ids.ts`):
 * live-read via get_smart_site, 2026-09-13, all five Sturgeon nodes
 * (48209:97658/97651/97652/97653/97657) served a bare-prop_id CAD-account
 * COLLISION under this overlay -- Mesa Verde/Austin house dollars and
 * living-area square footage on vacant Sturgeon lots (landValue identically
 * 177000 on all five distinct parcels; improvementValue/livingAreaSqft each
 * a real neighbouring house's, not the served parcel's). P-180 then repaired
 * the ledger at the WRITE path: hauska-factory's `factory-parcel-record-fill`
 * account-crosswalk fix (PR #145, mergeCommit 610204b8f) was re-run for
 * county 48209 only (execution factory-parcel-record-fill-7d8vb,
 * Completed=True, 11m1.82s), and the cells now name the crosswalked ACCOUNT
 * (basis.propId 84632/84633/84634/84638/84639) carrying P-177's own
 * known-good values (97658 -> 629 STURGEON DR / 50,390; 97651/97652/97653 ->
 * 50,130; 97657 -> 50,390). With the cells correct the hold has no further
 * work to do, so Hays is slated here for these six rails like the other five
 * counties. The legacy path (the tier-1 bake) remains P-177-fixed and
 * live-verified correct on both stores. Williamson is NOT held back (and was
 * never the subject of this hold): its TxGIO/CAD key spaces are lexically
 * DISJOINT (R-prefixed vs six-digit, per
 * `_inbox/2026-09-10_ctx-hays-key_close.json`), so a bare-prop_id collision
 * of this kind cannot occur there -- live-spot-read 48491:R638791 the same
 * day shows no sign of the collision shape Hays does. NOTE (P-180, cost of a
 * future change): Williamson's crosswalk is NOT inert at the fix's write
 * path -- its geo_id is 100% blank, so that path's SEED_BLOCKED_FIPS branch
 * would replace ~282,565 currently owner-correct cells with absence; it is
 * carried as an explicit leave_behind for its own row.
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
 *
 * valueHistory, ALL SIX counties including Caldwell (F-01, PARCEL-B-SLATE1
 * template, serve/prod cutover, 2026-09-04): the ingest job
 * (parcel-value-history.mjs, PARCEL-VALUE-HISTORY, closed 2026-09-02) ran
 * --apply on all six program counties, every county's companion-row count
 * exactly matching its landing denominator, zero orphans. A Williamson-only
 * crosswalk collision between two situs-sharing R-accounts was found and
 * fixed (PARCEL-VH-COLLISION, closed 2026-09-03, doc_repo
 * `_inbox/2026-09-03_parcel-vh-collision_close.json`); the other five
 * counties never touch the crosswalk path and were never exposed. No
 * per-county writer exclusion exists for this rail (contrast agValuation /
 * maxImperviousCoverPct), so all six are slated on the writer's own
 * demonstrated scope, matching cityLimits/flood/dollar-rails/utilityService/
 * schoolDistrict's own reasoning. No legacy serve path exists for this
 * rail (confirmed by a repo-wide search before this card). No gate verdict
 * exists for this rail as of this card (checked doc_repo for a
 * `parcel_gate_verdict` evaluation record before assuming none exists --
 * PARCEL-B-GATE-SCHED's own close documents its scheduled evaluation
 * covering only the four PARCEL-B-SLATE1 rails and PARCEL-B-SLATE2's six;
 * valueHistory, added afterward, is not among them); every entry resolves
 * to 'legacy' (valueHistoryFactServeCutover.ts's own typed not-cut-over
 * refusal, since there is no legacy reader) until a gate evaluation for
 * valueHistory lands. Slating ahead of the verdict is fail-closed by
 * construction, per this file's own PARCEL-B-READER precedent.
 *
 * parcelAreaSqFt, FIVE counties -- Bastrop/Caldwell/McLennan/Travis/
 * Williamson, Hays EXCLUDED (OPS-21 S5, P-148, 2026-09-11): the one rail
 * S4/P-135 measured passing the gate with zero wrapper to consume it --
 * "textually compliant and functionally inert," the exact defect class this
 * program exists to close. This card builds parcelAreaSqFtFactServeCutover.ts
 * (resolveAllowlist call site now exists, grep-confirmed) so this entry is
 * non-vacuous. Hays excluded per this dispatch's own standing fact (P-145
 * has not landed) -- not measured here, not assumed passing. Gate verdict
 * re-verified live immediately before this edit (2026-09-11T12:20:42Z,
 * FACTORY host ep-round-base-au0jofwp/neondb): all 5 pass, unaccounted_count
 * 0, fresh run_ids on every county (some newer than this card's own CP1
 * read, e.g. 48453 run 448bb019 at 12:16:32Z) -- no drift in OUTCOME despite
 * the scheduler re-evaluating mid-session, matching S4's own documented
 * behavior on this exact rail. The other four rails S5 also builds wrappers
 * for (setbackRules, maxHeightFt, maxLotCoveragePct, maxFootprintSqFt) are
 * deliberately NOT added here -- they fail the gate on every in-scope county
 * (blocked on the 3,376-parcel zoningDistrict residual Z1/P-147 is
 * characterising) and adding them would slate a rail with no genuine
 * passing verdict, the opposite failure mode from the one this card fixes.
 *
 * setbackRules, maxHeightFt, maxLotCoveragePct, maxFootprintSqFt, FIVE
 * counties -- Bastrop/Caldwell/McLennan/Travis/Williamson, Hays EXCLUDED
 * (OPS-21 S6, P-150, 2026-09-11): the four rails S5/P-148 built wrappers for
 * but deliberately did not slate, because at that time all four failed the
 * gate everywhere -- blocked on the same 3,376-parcel (5-county)
 * zoningDistrict residual as setbackFrontFt itself (see below). Z2/P-149
 * closed that residual (taught both writers to propagate zoningDistrict
 * not-applicable to their eight dependent rails); this card re-verified live
 * immediately before writing (2026-09-11, FACTORY host
 * ep-round-base-au0jofwp/neondb): all 20 of these (county,rail) pairs read
 * verdict=pass, unaccounted_count=0, no drift between the CP1 read and the
 * write-time read. Hays excluded per this dispatch's own standing fact
 * (P-145 has not landed) -- confirmed live at verdict=excluded for all 8
 * dependent rails, not merely assumed. Each of these four rails has NO
 * legacy serve path (confirmed by S5's repo-wide grep before it built the
 * wrappers) -- nothing to retire, matching parcelAreaSqFt's own contract.
 * setbackRules is the one companion-row rail in this group (S5's own live
 * finding: its cell's value field is null on all present rows; the real
 * content lives in parcel_record_companion_row) -- its wrapper already
 * handles that; this card only adds the slate entry.
 *
 * RETIRED (P-152 lane 6, OPS-23, ruling A-140, overseer 2026-09-13):
 * setbackSideFt, setbackRearFt, setbackCornerFt (five counties, Hays
 * EXCLUDED) and zoningJurisdictionKey, zoningProvenance (all six counties)
 * NOW HAVE independent slate entries below, superseding the
 * representative-key design this comment used to document. The prior
 * reasoning ("these have NO resolveAllowlist call site of their own
 * anywhere in this repo, so a literal entry would never be read by any
 * code") is still true of THIS repo's own consumers
 * (setbacksFactServeCutover.ts / zoningFactServeCutover.ts still gate the
 * whole group on their representative key alone, unchanged by this card --
 * see those files' own module docs) but is NOT true of hauska-engine's
 * services/retrieval-api parcel-record-reader.ts, which iterates every rail
 * key in this slate independently with no group/representative-key concept
 * of its own (R-9, OPS-23: one reader). That second, newer consumer reads
 * and acts on a literal "<county>:setbackSideFt"-shaped entry, so leaving
 * these five ungated there was a genuine slate gap for it, not an inert
 * no-op -- confirmed live before this card's edit: parcel_gate_verdict
 * reads verdict=pass, unaccounted_count=0 for all five siblings in
 * 48021/48055/48309/48453/48491 (setbackSideFt/RearFt/CornerFt EXCLUDED
 * only in Hays 48209; zoningJurisdictionKey/zoningProvenance pass in all
 * six including Hays), and parcel_record_cell for the Bastrop probe parcel
 * (48021:34049) carries real, non-null, earned values for every one of
 * them (setbackSideFt=10, setbackRearFt=30, setbackCornerFt=20, source
 * "@empressaio/setback-corpus@1.1.0:bastrop-development-code";
 * zoningJurisdictionKey="bastrop-tx", zoningProvenance a real ArcGIS
 * FeatureServer citation URL) -- re-verified live at edit time
 * (2026-09-13), not assumed from the prior card's read. The divergence test
 * (parcelRecordAllowlist.test.ts) is extended so a sibling missing its own
 * entry for a county where the gate already passes fails loudly, rather
 * than silently reading legacy there.
 *
 * acreageAcres (all six counties) and acreageMethod (Bastrop/Travis/
 * Williamson only -- Caldwell/Hays REFUSE, McLennan EXCLUDED) (P-152 lane 6):
 * two more rails with no resolveAllowlist call site in THIS repo (grep-
 * confirmed, same shape as the siblings above) but read independently by
 * the retrieval-api reader and composed onto the panel's baseFacts.acreage
 * by hauska-map's own BFF. Verdict re-checked live 2026-09-13: acreageAcres
 * passes everywhere with unaccounted_count 0; acreageMethod passes only in
 * 48021/48453/48491 (48055 and 48209 REFUSE with real unaccounted counts,
 * 48309 EXCLUDED -- not slated for those three, not an oversight).
 * acreageSqft has NO earned cell in ANY county (verdict=excluded
 * everywhere) and stays unslated -- adding it would violate "do not widen a
 * check to admit a value it does not satisfy."
 *
 * zoningDistrict + setbackFrontFt, ALL SIX counties including Caldwell
 * (F-01, PARCEL-B-SLATE3, OPS-16 A-096/A-097/A-098, 2026-09-04): the
 * specific defect that card fixed. Unlike every rail above, zoning
 * (zoningDistrict/zoningJurisdictionKey/zoningProvenance) and setbacks
 * (setbackFrontFt/setbackSideFt/setbackRearFt/setbackCornerFt) DO have a
 * live legacy serve path (r1BriefCompose.ts's zoningDisposition and
 * nodeFacetBakeTier1.ts's computeTier1Envelope, both reading only the
 * Tier-1 bake payload) -- but that path has no code path to ever emit
 * not-applicable, so 346,165 unincorporated parcels across these six
 * counties (independently reproduced,
 * _inbox/2026-09-02_p106_rail_census_zoningdiv.json) read UNKNOWN for these
 * seven rail keys when they should read NOT_APPLICABLE, matching what
 * hauska-factory's parcel-record-engine already writes at row-creation time
 * (rail-keys.js's UNINCORPORATED_NOT_APPLICABLE_RAIL_KEYS, instantiate.js).
 * Operator ruling (OPS-16 A-096): "it should be not applicable." zoningDistrict
 * and setbackFrontFt are the representative keys THIS repo's own
 * setbacksFactServeCutover.ts / zoningFactServeCutover.ts still gate their
 * whole group on (unchanged by P-152 lane 6 -- see RETIRED note above for
 * why that remains correct for this repo's own consumers even though the
 * siblings now also carry their own independent entries for the
 * retrieval-api reader). All six counties are slated with no per-county
 * exclusion -- rail-keys.js/instantiate.js apply this logic statewide with
 * no documented geographic restriction, matching overlayDistricts'/
 * schoolDistrict's own "all six, no exclusion documented" reasoning, not
 * wells'/specialDistricts' Caldwell exclusion. No gate verdict exists for
 * either representative rail key as of this card
 * (gate-rail-cli.mjs evaluation is a separate, out-of-repo process per
 * OPS-16 A-098); every entry resolves to 'legacy' until one does -- the
 * same accepted, zero-regression-risk initial state utilityService,
 * overlayDistricts, agValuation, schoolDistrict, and maxImperviousCoverPct
 * all shipped with. Verified directly against the adapter (bypassing the
 * gate, which is exactly what this initial state means) with a fixture
 * matching a real sample parcel from the census
 * (_inbox/2026-09-02_p106_projection_recon.json, 48021:10001, unincorporated,
 * zoningDistrict labeled "absent-verified"/"unincorporated-no-municipal-
 * zoning" there): the adapter treats both of parcel_record's own absence
 * kinds (absent-verified AND not-applicable -- instantiate.js's own writer
 * code is cited using "not-applicable" per OPS-16 A-097's direct read of
 * rail-keys.js; the census projection's own vocabulary differs, honestly
 * unreconciled here since either kind resolves the same way downstream) as
 * a verified absence, never a fabricated unknown-collapsed-to-absent or an
 * unconditional not-applicable regardless of which the live writer turns
 * out to use.
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
  "48209:marketValue",
  "48055:marketValue",
  "48309:marketValue",
  "48453:marketValue",
  "48491:marketValue",
  "48021:assessedValue",
  "48209:assessedValue",
  "48055:assessedValue",
  "48309:assessedValue",
  "48453:assessedValue",
  "48491:assessedValue",
  "48021:landValue",
  "48209:landValue",
  "48055:landValue",
  "48309:landValue",
  "48453:landValue",
  "48491:landValue",
  "48021:improvementValue",
  "48209:improvementValue",
  "48055:improvementValue",
  "48309:improvementValue",
  "48453:improvementValue",
  "48491:improvementValue",
  "48021:livingAreaSqft",
  "48209:livingAreaSqft",
  "48055:livingAreaSqft",
  "48309:livingAreaSqft",
  "48453:livingAreaSqft",
  "48491:livingAreaSqft",
  "48021:yearBuilt",
  "48209:yearBuilt",
  "48055:yearBuilt",
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
  "48021:valueHistory",
  "48055:valueHistory",
  "48209:valueHistory",
  "48309:valueHistory",
  "48453:valueHistory",
  "48491:valueHistory",
  "48021:zoningDistrict",
  "48055:zoningDistrict",
  "48209:zoningDistrict",
  "48309:zoningDistrict",
  "48453:zoningDistrict",
  "48491:zoningDistrict",
  "48021:setbackFrontFt",
  "48055:setbackFrontFt",
  "48209:setbackFrontFt",
  "48309:setbackFrontFt",
  "48453:setbackFrontFt",
  "48491:setbackFrontFt",
  "48021:parcelAreaSqFt",
  "48055:parcelAreaSqFt",
  "48309:parcelAreaSqFt",
  "48453:parcelAreaSqFt",
  "48491:parcelAreaSqFt",
  "48021:setbackRules",
  "48055:setbackRules",
  "48309:setbackRules",
  "48453:setbackRules",
  "48491:setbackRules",
  "48021:maxHeightFt",
  "48055:maxHeightFt",
  "48309:maxHeightFt",
  "48453:maxHeightFt",
  "48491:maxHeightFt",
  "48021:maxLotCoveragePct",
  "48055:maxLotCoveragePct",
  "48309:maxLotCoveragePct",
  "48453:maxLotCoveragePct",
  "48491:maxLotCoveragePct",
  "48021:maxFootprintSqFt",
  "48055:maxFootprintSqFt",
  "48309:maxFootprintSqFt",
  "48453:maxFootprintSqFt",
  "48491:maxFootprintSqFt",
  // P-152 lane 6 (OPS-23, ruling A-140, 2026-09-13): the five representative-key
  // siblings, independent entries where parcel_gate_verdict passes.
  "48021:zoningJurisdictionKey",
  "48055:zoningJurisdictionKey",
  "48209:zoningJurisdictionKey",
  "48309:zoningJurisdictionKey",
  "48453:zoningJurisdictionKey",
  "48491:zoningJurisdictionKey",
  "48021:zoningProvenance",
  "48055:zoningProvenance",
  "48209:zoningProvenance",
  "48309:zoningProvenance",
  "48453:zoningProvenance",
  "48491:zoningProvenance",
  "48021:setbackSideFt",
  "48055:setbackSideFt",
  "48309:setbackSideFt",
  "48453:setbackSideFt",
  "48491:setbackSideFt",
  "48021:setbackRearFt",
  "48055:setbackRearFt",
  "48309:setbackRearFt",
  "48453:setbackRearFt",
  "48491:setbackRearFt",
  "48021:setbackCornerFt",
  "48055:setbackCornerFt",
  "48309:setbackCornerFt",
  "48453:setbackCornerFt",
  "48491:setbackCornerFt",
  // P-152 lane 6 (OPS-23, 2026-09-13): the nine safe-to-add acreage pairs
  // lane 4 identified (parcel_gate_verdict pass, unaccounted_count 0).
  "48021:acreageAcres",
  "48055:acreageAcres",
  "48209:acreageAcres",
  "48309:acreageAcres",
  "48453:acreageAcres",
  "48491:acreageAcres",
  "48021:acreageMethod",
  "48453:acreageMethod",
  "48491:acreageMethod",
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
 * no verdict -> legacy; in slate + pass -> record; in slate + any recognised
 * non-pass verdict -> refused.
 *
 * P-293 (2026-09-16): "any recognised non-pass" now includes the factory's
 * P-201 `excluded-*` kinds -- 'excluded-not-applicable',
 * 'excluded-mid-cutover', 'excluded-no-acquisition-path' -- which resolve
 * 'refused' exactly as the bare 'excluded' already did. THE DECISION TABLE
 * BELOW IS UNCHANGED: P-201 widened the vocabulary upstream of this
 * function, and this function's parameter type now follows
 * `parcelGateVerdictVocabulary.ts` so the two cannot drift apart. Note the
 * ordering too: a string the vocabulary does NOT recognise never reaches
 * here at all -- `parcelGateVerdictRead.ts` logs it and returns null, which
 * this function resolves to 'legacy' through the `!verdict` branch above.
 */
export function resolveAllowlistState(
  countyFips: string,
  railKey: string,
  verdict: { verdict: ParcelGateVerdictKind } | null,
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
