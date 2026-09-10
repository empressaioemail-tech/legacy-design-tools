/**
 * Land-use join key normalizer for the parcel bakes (PMTiles + Tier-1 facets).
 *
 * The bake joins a TxGIO parcel's `prop_id` to its `cad_property` row on
 * `(county_fips, normalizeForJoin(prop_id))`. The `cad_property` side is
 * keyed by the CAD-normalized prop id the ingest parsers wrote:
 * `stripLeadingZeros(propertyid)` (see lib/cad-ingest/src/normalize.ts and
 * the `normalizeCadPropId` mirror in ./parcelNodeId), i.e. a bare-numeric,
 * leading-zeros-stripped id ("000010001" -> "10001", "9").
 *
 * DATA-INTEGRITY GATE (structural commitment #1 — honest absence over a
 * fabricated match). For most counties the TxGIO `prop_id` and the CAD roll
 * `prop_id` are the SAME bare-numeric appraisal account, so a leading-zero
 * strip joins them correctly (owner-name spot checks: Bexar 99.1%, Bell
 * 97.3%, Bastrop 95.9%, Travis 91.9%). But two counties DO NOT share a
 * numbering system with their CAD roll, and joining them produces silent
 * FABRICATION — a numeric collision that stamps a DIFFERENT property's
 * land-use onto the parcel:
 *
 *   - Williamson (48491): TxGIO `prop_id` is the appraisal "R-account" form
 *     ("R062578"); its CAD roll is a DIFFERENT numbering system (six-digit
 *     "505806"). Stripping the leading "R" then the zeros yields a bare
 *     number ("62578") that COLLIDES with an unrelated CAD account for a
 *     different owner. Verified: of ~97k such "matches", 5 had a matching
 *     owner name (~0.005%). The R-strip that used to live here existed ONLY
 *     to make this join fire, and every parcel it "recovered" was fabricated.
 *   - Hays (48209): both sides are bare-numeric, but they are DIFFERENT
 *     numbering systems that coincidentally collide. Verified: of ~78k
 *     "matches", 10 had a matching owner name (~0.013%).
 *
 * So `landUseJoinKey` returns `null` for BLOCKED counties, and the bakes store
 * an honest `landUse: null` (absence) rather than a fabricated code. The
 * blocked set is DRIVEN BY THE OWNER-MATCH INTEGRITY GATE, not a hand-edited
 * constant: the per-county scorer (`countyCoverageScoreCli.ts`) runs the gate
 * (`joinIntegrityGate.ts`), and any county whose owner-match rate falls below
 * threshold gets a `block` verdict written to the coverage LEDGER
 * (`county_facet_coverage`). The bakes load the ledger's blocked FIPS at
 * startup (`loadLedgerBlockedFips`) and pass them to `landUseJoinKey`, so
 * county #100 is checked automatically. `LANDUSE_JOIN_DISABLED_FIPS_SEED` is
 * only the gate's bootstrap output (48491 + 48209) used when the ledger has
 * not yet been scored. The gate lifts per county once an external
 * CAD-account <-> TxGIO-prop_id crosswalk raises its owner-match rate above
 * threshold. Removing the R-strip drops NO other county's correct join, so
 * the R-strip is gone entirely and `normalizeForJoin` is now a plain
 * leading-zero strip.
 *
 * CORRECTION (P-124 CTX-HAYS-REBIND, 2026-09-10). This header used to end
 * "Only Williamson carries R-prefixed TxGIO ids in the whole corpus". That is
 * true of the PREFIX and FALSE of the NUMBERING, and the false half is the
 * sentence that stopped anyone looking for a crosswalk. Hays 48209's TxGIO
 * `prop_id` values ARE the county's R-account (QuickRefID) numbers with the
 * "R" already stripped AT THE SOURCE, which is exactly why removing the
 * R-strip cost Hays nothing and why its collision reads as "different
 * numbering systems that coincidentally collide" rather than as what it is:
 * two DIFFERENT PUBLISHED IDENTIFIERS sharing one bare-numeric column.
 * Verified live 2026-09-10 against the county's own export and the parcel
 * store: Hays CAD account 40138 carries QuickRefID R26199 and PropertyNumber
 * 11-2520-0000-03100-2, and `txgio_parcel` 48209 `prop_id` 26199 carries
 * `geo_id` 11-2520-0000-03100-2. They are the same parcel.
 *
 * The consequence is `parcelCrosswalkJoinKey` at the bottom of this file: a
 * gate-blocked county whose CAD roll publishes a Geographic ID binds its
 * geometry by PUBLISHED IDENTIFIER instead of by recovered address. Williamson
 * still cannot, and not for want of a key: `txgio_parcel` 48491 carries ZERO
 * non-blank `geo_id` across 304,298 rows, so the index a crosswalk key would
 * look into is empty for that county.
 *
 * Dependency-free by design (no @workspace/db), mirroring parcelNodeId.ts
 * and ptadLandUse.ts, so the offline bake and its unit test can import it
 * without dragging a DB connection into module load.
 */

/**
 * GATE-OUTPUT SEED (fallback), NOT a hand-maintained blocklist.
 *
 * This set is the OUTPUT of the owner-match integrity gate's last run
 * (`artifacts/api-server/src/lib/joinIntegrityGate.ts` +
 * `countyCoverageScoreCli.ts`), recorded here as a bootstrap seed so a bake
 * still blocks the two known fabrications even before the coverage LEDGER
 * (`county_facet_coverage`) has been scored on a fresh database. The
 * AUTHORITATIVE source of the block decision is the ledger's computed verdict,
 * loaded at bake start via `loadLedgerBlockedFips` and passed to
 * `landUseJoinKey` — so county #100 gets checked automatically without anyone
 * editing this constant. This seed is only consulted when the ledger is empty
 * (a never-scored DB); once the scorer has run, the ledger's `block` verdicts
 * (owner-match rate < threshold) drive the bakes.
 *
 * 48491 Williamson — R-account TxGIO ids vs six-digit CAD roll (~0% owner
 *                     match); 48209 Hays — divergent bare-numeric systems
 *                     (~1.1% owner match). Both computed by the gate, not
 *                     asserted by hand. See the module header for detail.
 */
export const LANDUSE_JOIN_DISABLED_FIPS_SEED: ReadonlySet<string> = new Set([
  "48491",
  "48209",
]);

/**
 * @deprecated Use the ledger-driven `blockedFips` argument to
 * `landUseJoinKey` (loaded via `loadLedgerBlockedFips`). Retained as an alias
 * of the gate-output seed for any caller not yet threading the ledger set.
 */
export const LANDUSE_JOIN_DISABLED_FIPS = LANDUSE_JOIN_DISABLED_FIPS_SEED;

/**
 * Normalize a TxGIO `prop_id` to the STORED `cad_property` join key form.
 *
 * "000123" -> "123", "10001" -> "10001", "9" -> "9". A value with no digits
 * (e.g. "PRIVATE ROAD") is returned unchanged and will not collide with any
 * numeric cad key. NOTE: this no longer strips an "R" prefix — the only
 * county with R-prefixed ids (Williamson) is a fabricating collision that is
 * gated off by `landUseJoinKey`, and no other county has an R-prefixed id.
 */
export function normalizeForJoin(propId: string): string {
  const stripped = propId.trim();
  // Non-numeric (junk like "PRIVATE ROAD") stays as-is and never matches a
  // bare-numeric cad key.
  if (!/^\d+$/.test(stripped)) return stripped;
  return stripped.replace(/^0+(?=\d)/, "");
}

/**
 * The land-use join key for a parcel, honoring the per-county data-integrity
 * gate. Returns `null` when the county is BLOCKED so the caller stores honest
 * land-use absence instead of a fabricated match. Otherwise returns
 * `normalizeForJoin(propId)`.
 *
 * The blocked set is a PARAMETER, not a hardcoded constant: the bakes load it
 * from the coverage LEDGER at startup (the gate's computed `block` verdicts)
 * via `loadLedgerBlockedFips`, so the block decision generalizes to every
 * county the gate scores — no hand-edited blocklist. When a caller omits
 * `blockedFips` (e.g. a never-scored DB), it falls back to
 * `LANDUSE_JOIN_DISABLED_FIPS_SEED`, the gate's bootstrap output for the two
 * known fabrications, so a fresh DB is never left un-gated.
 *
 * Callers MUST route the land-use join through this function (not
 * `normalizeForJoin` directly) so the gate is enforced at every join site.
 */
export function landUseJoinKey(
  countyFips: string,
  propId: string | null | undefined,
  blockedFips: ReadonlySet<string> = LANDUSE_JOIN_DISABLED_FIPS_SEED,
): string | null {
  if (propId == null || propId.trim() === "") return null;
  if (blockedFips.has(countyFips)) return null;
  return normalizeForJoin(propId);
}

/**
 * SITUS-ADDRESS RECOVERY JOIN KEY (the fallback for prop_id-gated counties).
 *
 * When a county's prop_id land-use join is gate-BLOCKED (a numeric-key
 * collision, e.g. Williamson 48491 / Hays 48209), the prop_id is a proven
 * fabrication and `landUseJoinKey` returns null. But the SAME parcel can still
 * be recovered by a DIFFERENT, independent key: its situs street address. A
 * TxGIO parcel and its CAD roll row describe the same physical property, so
 * their situs addresses agree, and the situs address does NOT collide the way
 * the divergent prop_id numbering does. Verified live: Williamson situs
 * address-match 99.2% / owner-agree ~89%; Hays 97.4% / owner-agree ~86% (both
 * on ~100%-situs corpora). See `parcelsPmtilesBakeCli` / `nodeFacetBakeTier1Cli`.
 *
 * `normalizeSitusAddress` is the join key on BOTH sides: uppercase, then strip
 * every non-alphanumeric character. So "123 Main St." and "123 MAIN ST" and
 * "123  main   st" all key to "123MAINST". A blank/whitespace/null address
 * returns "" — which the caller treats as no key (never matches), so a parcel
 * with no situs is honest-absence, not a false match.
 *
 * INTEGRITY: this key alone is NOT sufficient to promote a land-use. The
 * address join must ALSO pass the per-match owner gate (`ownersAgree` in
 * joinIntegrityGate) exactly like the prop_id join is gate-scored — a parcel
 * whose address matches but whose TxGIO and CAD owners DISAGREE gets honest
 * null, never the mismatched code. `normalizeSitusAddress` produces the key;
 * the owner gate decides whether the matched code may promote.
 */
export function normalizeSitusAddress(
  address: string | null | undefined,
): string {
  if (address == null) return "";
  return String(address).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * The situs-address recovery key for a parcel, honoring the per-county gate in
 * MIRROR of `landUseJoinKey` — but INVERTED: the address join is the RECOVERY
 * path that fires ONLY for counties whose prop_id join is BLOCKED. For a
 * non-blocked county the address join returns null (that county already joins
 * correctly on prop_id; there is nothing to recover, and running an unnecessary
 * second join would only add a way to be wrong). For a blocked county it
 * returns the normalized situs address (or null when the parcel has no situs).
 *
 * This keeps the recovery strictly scoped: address-join land-use is emitted for
 * exactly the counties the prop_id gate took away, and only there.
 */
export function addressJoinKey(
  countyFips: string,
  situsAddress: string | null | undefined,
  blockedFips: ReadonlySet<string> = LANDUSE_JOIN_DISABLED_FIPS_SEED,
): string | null {
  // Recovery fires only where the prop_id join is blocked.
  if (!blockedFips.has(countyFips)) return null;
  const key = normalizeSitusAddress(situsAddress);
  return key === "" ? null : key;
}

/**
 * PARCEL CROSSWALK JOIN KEY — bind geometry by PUBLISHED IDENTIFIER
 * (P-124 CTX-HAYS-REBIND, 2026-09-10).
 *
 * The third key in this file, and the only one that is not an inference. Its
 * two siblings both bind a gate-blocked county's geometry indirectly:
 * `landUseJoinKey` refuses the prop_id join outright because the two id spaces
 * collide, and `addressJoinKey` recovers on the situs STRING, which works
 * whenever two publishers happen to format an address the same way.
 *
 * WHY THE ADDRESS RECOVERY IS NOT ENOUGH, MEASURED. For Hays 48209 the address
 * join is CIRCULAR. The 2026-08-25 P-78 StratMap merge upserted TxGIO-keyed
 * rows into `cad_property` on `(county_fips, prop_id, tax_year)` with
 * `situsAddress` under `coalesce(incoming, existing)`, so wherever the two
 * bare-numeric namespaces collided the TxGIO row's address overwrote the CAD
 * account's. All 116,421 Hays `cad_property` tax_year 2025 rows that join
 * `txgio_parcel` on prop_id carry TxGIO's situs byte-identically. The address
 * join then finds the parcel whose address was copied INTO the CAD row: it
 * succeeds perfectly and returns the wrong parcel. Measured against production
 * 2026-09-10, 30,862 Hays parcel nodes draw a different polygon than the
 * county's own crosswalk names, and 19,902 more draw none at all.
 *
 * WHAT THIS KEY IS. `cad_property.property_number` (the county's published
 * Geographic ID, e.g. `11-2520-0000-03100-2`) matched against
 * `txgio_parcel.geo_id`. Both sides published by their own authority. No
 * string similarity, no normalization beyond a trim, no tuned threshold.
 *
 * SCOPED THE SAME WAY `addressJoinKey` IS, AND FOR THE SAME REASON: it returns
 * null for a county whose prop_id join is NOT gate-blocked. That county already
 * joins correctly on prop_id and a second join would only add a way to be
 * wrong. The blocked set is the ledger-driven PARAMETER, never a county
 * literal, so a county #3 with this structure is covered without editing code.
 *
 * FAIL CLOSED ON BOTH SIDES. A null or blank `property_number` is not a key
 * (the county's export did not publish one, or the row predates the parser
 * that reads it). A county whose parcel table carries no `geo_id` has an empty
 * index and can never match. Williamson 48491 fails both tests today, but the
 * two are NOT equally durable and the difference is worth stating rather than
 * leaving for the next reader to discover. Its `cad_property` rows carry no
 * `property_number` only because nobody has re-ingested Williamson since the
 * parser started reading the column -- and WCAD's Socrata property dataset DOES
 * publish one (measured 2026-09-10: propertyid 63514 carries quickrefid
 * R002338 and propertynumber R-17-W338-401P-0013-0006), so a re-ingest would
 * give that county keys. What actually holds is the OTHER half:
 * `txgio_parcel` 48491 carries ZERO non-blank `geo_id` across 304,298 rows on
 * BOTH the staging and production stores, so the index those keys would be
 * looked up in is empty and the bind cannot happen. If TxGIO ever publishes
 * Williamson geo_ids, this path goes live there -- which would be a bind on
 * two published identifiers rather than on a numeric collision, and therefore
 * the same correction Hays gets, but it is a real behaviour change and not a
 * silent one: the bake prints its crosswalk counts on every gate-blocked run.
 *
 * THIS KEY ALONE DOES NOT AUTHORISE A BIND. See `crosswalkBindCorroborated`.
 */
export function parcelCrosswalkJoinKey(
  countyFips: string,
  propertyNumber: string | null | undefined,
  blockedFips: ReadonlySet<string> = LANDUSE_JOIN_DISABLED_FIPS_SEED,
): string | null {
  // Crosswalk binding fires only where the prop_id join is blocked, mirroring
  // addressJoinKey. A county that joins correctly on prop_id gets null.
  if (!blockedFips.has(countyFips)) return null;
  if (propertyNumber == null) return null;
  const key = String(propertyNumber).trim();
  return key === "" ? null : key;
}

/**
 * The numeric stem of a CAD account number ("R26199" -> "26199"), or null.
 *
 * The SECOND published identifier, used ONLY as the corroborator for
 * `parcelCrosswalkJoinKey` and never as a binder in its own right. That
 * restriction is deliberate and measured: used as a binder the bare-numeric
 * stem selects 116,106 Hays features of which 5,042 are claimed by more than
 * one account (5,214 surplus accounts), every collision being a
 * personal-property or mobile-home account whose stem happens to equal a
 * real-property account's. Restricting it to R accounts is collision-free and
 * would add 1,042 further binds, and that trade is DECLINED: it buys 0.9
 * percent coverage by reintroducing a bare-numeric key whose safety depends on
 * a vendor-specific account-class letter. Those 1,042 parcels stay honest
 * geometry absences.
 *
 * Returns null for anything that is not `<letters><digits>`, so a bare-numeric
 * value can never be mistaken for an account number and corroborate itself.
 */
export function cadAccountNumberStem(
  quickRefId: string | null | undefined,
): string | null {
  if (quickRefId == null) return null;
  const m = /^([A-Za-z]+)([0-9]+)$/.exec(String(quickRefId).trim());
  if (!m) return null;
  const digits = (m[2] ?? "").replace(/^0+(?=[0-9])/, "");
  return digits === "" ? null : digits;
}

/**
 * THE MEANING-SHAPED HALF OF THE CROSSWALK BIND.
 *
 * `geoIdFeature` is the feature the county's Geographic ID selected in
 * `txgio_parcel.geo_id`. `accountStemFeature` is the feature the county's
 * account number selected in `txgio_parcel.prop_id`. Two identifiers published
 * by the CAD in two different columns, matched against two different columns
 * of the parcel store. No single upstream can satisfy both sides, which is what
 * makes this a consistency check between independent derivations rather than an
 * internal-consistency check one bad source could pass alone.
 *
 * Returns true when the geo_id bind exists and the account-number bind either
 * AGREES with it or found nothing. An absent, unparsable, or unmatched account
 * number is not evidence AGAINST the geo_id bind, and treating it as such would
 * withdraw 1,042 correct Hays binds to no purpose.
 *
 * Returns false when both resolve and name DIFFERENT features: that is positive
 * evidence the crosswalk is wrong for this row, and the caller must refuse the
 * bind rather than pick a winner.
 *
 * Measured on Hays 48209, 2026-09-10: 115,035 binds offered, 115,035
 * corroborated, ZERO refused. Zero refusals is reported as zero and is NOT
 * presented as proof the check works; the refusal branch is proven reachable by
 * unit test, in both directions.
 */
export function crosswalkBindCorroborated(
  geoIdFeature: number | null | undefined,
  accountStemFeature: number | null | undefined,
): boolean {
  if (geoIdFeature == null) return false;
  if (accountStemFeature == null) return true;
  return accountStemFeature === geoIdFeature;
}
