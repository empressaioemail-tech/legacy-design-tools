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
 * So `landUseJoinKey` returns `null` for these two FIPS, and the bakes store
 * an honest `landUse: null` (absence) rather than a fabricated code. The gate
 * lifts per county once an external CAD-account <-> TxGIO-prop_id crosswalk
 * exists to join them truthfully. Only Williamson carries R-prefixed TxGIO
 * ids in the whole corpus, and removing the R-strip drops NO other county's
 * correct join (no other county has an R-prefixed id), so the R-strip is
 * gone entirely — `normalizeForJoin` is now a plain leading-zero strip.
 *
 * Dependency-free by design (no @workspace/db), mirroring parcelNodeId.ts
 * and ptadLandUse.ts, so the offline bake and its unit test can import it
 * without dragging a DB connection into module load.
 */

/**
 * County FIPS whose TxGIO `prop_id` numbering does NOT correspond to their
 * loaded `cad_property` roll, so a numeric land-use join fabricates (stamps
 * an unrelated property's land-use). The bakes must store honest land-use
 * absence for these until an external account crosswalk is available.
 *
 * 48491 Williamson — R-account TxGIO ids vs six-digit CAD roll (~0.005% owner
 *                     match); 48209 Hays — divergent bare-numeric systems
 *                     (~0.013% owner match). See the module header for the
 *                     owner-match verification.
 */
export const LANDUSE_JOIN_DISABLED_FIPS: ReadonlySet<string> = new Set([
  "48491",
  "48209",
]);

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
 * gate. Returns `null` when the county's numbering is known-unreliable
 * (`LANDUSE_JOIN_DISABLED_FIPS`) so the caller stores honest land-use absence
 * instead of a fabricated match. Otherwise returns `normalizeForJoin(propId)`.
 *
 * Callers MUST route the land-use join through this function (not
 * `normalizeForJoin` directly) so the gate is enforced at every join site.
 */
export function landUseJoinKey(
  countyFips: string,
  propId: string | null | undefined,
): string | null {
  if (propId == null || propId.trim() === "") return null;
  if (LANDUSE_JOIN_DISABLED_FIPS.has(countyFips)) return null;
  return normalizeForJoin(propId);
}
