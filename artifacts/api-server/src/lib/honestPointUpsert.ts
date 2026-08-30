/**
 * CTX W1 honest query point (W1 bake item 6).
 *
 * Defect: `ON CONFLICT` kept a prior non-zero `lat_rounded`/`lng_rounded`
 * when the new write was the 0,0 sentinel (`CASE WHEN EXCLUDED = 0,0 THEN
 * keep prior`). A gate-blocked or no-ring parcel then served another
 * parcel's inherited centroid (~58,461 live).
 *
 * Rule: a gate-blocked or 0,0 write overwrites. The new row is the point.
 * Blast radius: conformant tier-1 bake, the old tier-1 bake
 * (`nodeFacetBakeTier1Cli.ts`, which already writes EXCLUDED), and
 * `parcelsPmtilesBakeCli` (PMTiles features carry geometry, not
 * `place_layer_snapshots` coords; a later PMTiles rebuild must not
 * re-derive a query point from a kept inherited centroid).
 */

export const PLACE_COORD_SENTINEL = 0;

export function isSentinelCoord(lat: number, lng: number): boolean {
  return lat === 0 && lng === 0;
}

/**
 * The coordinate the upsert writes. Prior is never an input: a sentinel
 * or gate-blocked-without-ring write is 0,0 even when a prior non-zero
 * exists in the store.
 */
export function snapshotCoordForWrite(input: {
  newLat: number;
  newLng: number;
  /** True when the new row is gate-blocked and has no recovered ring. */
  gateBlockedNoRing: boolean;
}): { lat: number; lng: number } {
  if (input.gateBlockedNoRing) {
    return { lat: PLACE_COORD_SENTINEL, lng: PLACE_COORD_SENTINEL };
  }
  if (isSentinelCoord(input.newLat, input.newLng)) {
    return { lat: PLACE_COORD_SENTINEL, lng: PLACE_COORD_SENTINEL };
  }
  return { lat: input.newLat, lng: input.newLng };
}

/**
 * The KEEP-PRIOR clause that was the defect. Tests assert the live SQL
 * does not contain this, and that a fixture prior centroid is overwritten.
 */
export const HONEST_POINT_KEEP_PRIOR_CLAUSE_RETIRED =
  "WHEN EXCLUDED.lat_rounded = 0 AND EXCLUDED.lng_rounded = 0";

/** Coord SET clauses: always EXCLUDED. Named so a test can violate the old CASE. */
export const HONEST_POINT_COORD_SET_SQL = `lat_rounded = EXCLUDED.lat_rounded,
               lng_rounded = EXCLUDED.lng_rounded`;
