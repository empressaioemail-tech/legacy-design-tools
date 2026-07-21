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
 * threshold. Only Williamson carries R-prefixed TxGIO ids in the whole corpus,
 * and removing the R-strip drops NO other county's correct join, so the
 * R-strip is gone entirely — `normalizeForJoin` is now a plain leading-zero
 * strip.
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
