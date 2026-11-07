/**
 * THE INCORPORATED-CITY DENOMINATOR — "of the parcels that SHOULD have
 * zoning, how many do".
 *
 * WHY THIS EXISTS, measured before a line of it was written (lane SS-W15,
 * 2026-08-19, read-only against the deployment store):
 *
 *   Bastrop 48021 has 63,357 parcel features and 9,642 of them carry a
 *   `zoning_district`. Over the county that is 15.22%, and 15.22% reads as a
 *   near-total coverage failure. It is not one. Only 11,968 of those 63,357
 *   parcels sit inside an incorporated city boundary — 18.89% of the county.
 *   The other 51,389 are unincorporated, where no municipality holds zoning
 *   authority and there is nothing to stamp. Charging the county for them
 *   measures Texas geography, not our coverage.
 *
 *   On the corrected denominator Bastrop is 9,526 / 11,968 = 79.60%.
 *
 * AND THE CORRECTION DID NOT MAKE THE PROBLEM DISAPPEAR, which is the point.
 * The planner's hypothesis was that the number would land near 100% and the
 * remediation would be nothing. It landed at 79.60%, and the missing 20.40%
 * is one named city: Smithville, 2,397 incorporated parcels, zero stamped,
 * 20.03% of the denominator on its own. A denominator fix that had hidden
 * that would have been a worse instrument, not a better one. The right
 * denominator did not erase the gap; it named it.
 *
 * THE TRAP THIS DELIBERATELY AVOIDS, measured on six counties by lane SS-W13
 * and re-measured on Bastrop here. The obvious shortcut is
 * `stamped / parcels-carrying-a-zoning_jurisdiction`. On Bastrop that is
 * 9,642 / 9,642 = 100.00%, and it is 100.00% for every wired county, because
 * `zoning_jurisdiction` is written by the same stamp that sets
 * `zoning_district`. A denominator derived from the thing it measures is a
 * tautology wearing a percentage sign. THE DENOMINATOR COMES FROM
 * `tx_city_boundary` AND NEVER FROM ANY COLUMN THE STAMP WRITES.
 *
 * NUMERATOR AND DENOMINATOR ARE ONE QUERY, NOT TWO COUNTS. Measured on
 * Bastrop: 116 stamped parcels (1.20% of the numerator) fall outside every
 * incorporated boundary, and 65 of them do not touch one at all — mostly
 * `elgin-tx` R-1, consistent with a city zoning layer published over its ETJ,
 * plus annexation drift against the `txgio_city_boundaries_202508` boundary
 * vintage. Counted independently, Bastrop would read 9,642 / 11,968 = 80.56%
 * instead of 79.60%. On Travis the same escape is 16,308 parcels, 5.9% of the
 * numerator. That is the shape lane SS-W8 hit as `mud 209/186`: a ratio above
 * 100% produced by a numerator that left its denominator. Here the numerator
 * is a FILTER ON THE DENOMINATOR SET, so `num <= den` holds by construction.
 *
 * COST, stated rather than discovered later. This is a PostGIS point-in-
 * polygon join and it is not cheap: Travis 48453 (828,773 features, Austin's
 * multipolygon) takes ~4m30s. Two things keep that bounded. `ST_Subdivide`
 * on the city geometry is load-bearing — without it the same Travis query did
 * not return inside a 2-minute budget, and with it the parcel GiST index does
 * the work. And measurability is resolved BEFORE the spatial work runs, so
 * the cost is paid only for counties with a wired zoning layer: 10 counties
 * today, not 254.
 */

import type { RailScoreQueryable } from "./measure";

/** The boundary table. Named once; the SQL below is the only place it appears. */
export const CITY_BOUNDARY_TABLE = "tx_city_boundary";

/**
 * Vertex budget for `ST_Subdivide`. Not a tuning knob to be nudged: at 128 the
 * Travis join completes in ~4m30s, and without subdivision at all it did not
 * complete inside 2 minutes. Recorded so a future edit knows what it is
 * trading.
 */
export const CITY_GEOMETRY_SUBDIVIDE_VERTICES = 128;

export interface IncorporatedStampCounts {
  /** Parcels whose representative point falls inside an incorporated city boundary. */
  incorporated: number;
  /** Of THOSE, the ones carrying a non-null stamp column. Always <= `incorporated`. */
  stamped: number;
  /** Every parcel feature in the county, for the reconciliation the report prints. */
  countyFeatures: number;
  /**
   * Features carrying a non-null PostGIS `geom`. A parcel without one cannot be
   * located against any boundary, so it is in NEITHER the numerator nor the
   * denominator, and that exclusion is MEASURED here rather than inferred by
   * subtraction (DEV_PROCESS 1.3).
   *
   * TRACED TO AN INCIDENT, found by this lane: Caldwell 48055 has 26,155 parcel
   * features and ZERO with `geom` — every other wired county is at 100.00%.
   * Its jsonb `geometry` is populated and its bbox columns are populated, so
   * nothing about the county looks empty; only the PostGIS column was never
   * backfilled. A denominator that did not count this would have reported
   * Caldwell as 0 incorporated parcels while the store holds 6,527 stamped
   * ones, and a scorer would have published that as coverage.
   */
  countyFeaturesWithGeom: number;
  /** Stamped parcels anywhere in the county, including outside any boundary. */
  countyStamped: number;
  /** `countyStamped - stamped`: the numerator that escaped the denominator. */
  stampedOutsideBoundary: number;
}

/**
 * Is ANY parcel in this county locatable? The refusal only needs the boolean.
 *
 * COST, and it is the reason this is a separate function from the count below.
 * The refusal path runs for EVERY county in the target set — 245 of 254 on the
 * zoning rail — and the first version asked it with
 * `count(DISTINCT feature_index) FILTER (WHERE geom IS NOT NULL)`, a full
 * per-county scan, before deciding whether the county was measurable at all.
 * That made the CHEAP path expensive and contradicted this module's own claim
 * that measurability is settled before any spatial work. `EXISTS` short-
 * circuits on the first row. The exact count is still reported, but only for a
 * county that survived the refusal and is going to be measured anyway.
 */
export async function countyHasAnyGeometry(
  q: RailScoreQueryable,
  parcelTable: string,
  countyFips: string,
): Promise<boolean> {
  const r = await q.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM ${parcelTable} WHERE county_fips = $1 AND geom IS NOT NULL
     ) AS present`,
    [countyFips],
  );
  return Boolean(r.rows[0]?.present);
}

/**
 * Features, and features that can actually be located, MEASURED rather than
 * inferred (DEV_PROCESS 1.3). Called only on the measured path, because it is
 * a full per-county scan and a refused county has no use for it.
 */
export async function readLocatableFeatureCounts(
  q: RailScoreQueryable,
  parcelTable: string,
  countyFips: string,
): Promise<{ features: number; featuresWithGeom: number }> {
  const r = await q.query<{ features: string; with_geom: string }>(
    `SELECT count(DISTINCT feature_index)::text AS features,
            count(DISTINCT feature_index) FILTER (WHERE geom IS NOT NULL)::text AS with_geom
       FROM ${parcelTable} WHERE county_fips = $1`,
    [countyFips],
  );
  return {
    features: Number(r.rows[0]?.features ?? 0),
    featuresWithGeom: Number(r.rows[0]?.with_geom ?? 0),
  };
}

/**
 * The counting rule, in prose, carried into the ledger row next to the number
 * (DEV_PROCESS 1.2). Written as a function of the column so it cannot drift
 * from the SQL below.
 */
export function incorporatedDenominatorBasis(column: string): string {
  return (
    `denominator = DISTINCT feature_index in txgio_parcel for the county whose ` +
    `ST_PointOnSurface(geom) is contained by an incorporated municipal boundary in ` +
    `${CITY_BOUNDARY_TABLE}; numerator = that same set filtered to ${column} IS NOT NULL. ` +
    `Parcels outside every municipal boundary are excluded as an established absence with ` +
    `basis "unincorporated, no municipal zoning authority", counted beside the fraction and ` +
    `never inside it. The denominator is never derived from zoning_jurisdiction or any other ` +
    `column the stamp itself writes: that ratio is a tautology returning 100.00% for every ` +
    `wired county.`
  );
}

/**
 * Is the boundary table present and non-empty?
 *
 * Both halves matter. A missing table and a table that loaded zero rows
 * produce the same zero denominator and mean completely different things, and
 * neither may be scored as coverage — an empty result is not an absence
 * (DEV_PROCESS 4.3).
 */
const BOUNDARY_AVAILABILITY_MEMO = new WeakMap<
  object,
  Promise<{ present: boolean; rows: number }>
>();

export async function readCityBoundaryAvailability(
  q: RailScoreQueryable,
): Promise<{ present: boolean; rows: number }> {
  // ONE ANSWER PER DATABASE, not one per county. The first version asked this
  // 254 times in a statewide run for a fact that cannot vary between counties.
  // Keyed on the handle rather than module-global, so a run against a
  // different store is never served another store's answer, and a WeakMap so a
  // closed pool is not retained.
  const cached = BOUNDARY_AVAILABILITY_MEMO.get(q as object);
  if (cached) return await cached;
  const pending = (async () => {
    const t = await q.query<{ r: string | null }>("SELECT to_regclass($1) AS r", [
      CITY_BOUNDARY_TABLE,
    ]);
    if (t.rows[0]?.r == null) return { present: false, rows: 0 };
    const c = await q.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${CITY_BOUNDARY_TABLE}`,
    );
    return { present: true, rows: Number(c.rows[0]?.n ?? 0) };
  })();
  BOUNDARY_AVAILABILITY_MEMO.set(q as object, pending);
  return await pending;
}

/**
 * Measure numerator and denominator for one county IN ONE QUERY.
 *
 * `parcelTable` and `column` are identifiers, not parameters — both are
 * asserted by the caller against the registry's own identifier guard before
 * they reach here. `countyFips` is bound.
 *
 * SHAPE NOTES, each of which cost real time:
 *
 *   - ZONE-MAJOR, not point-major. The city geometries are built once in a
 *     MATERIALIZED CTE, so each mega-polygon is detoasted once per query
 *     rather than once per candidate parcel.
 *   - The bbox prefilter selects candidate cities from the county's own parcel
 *     extent. Cities the prefilter admits and the geometry then rejects are
 *     normal and are visible in the per-city breakdown, not hidden: on Bastrop
 *     the prefilter admits Austin and Mustang Ridge, which contain zero of the
 *     county's parcels.
 *   - `DISTINCT ON (feature_index)` because txgio_parcel carries multiple tile
 *     rows per feature (Bastrop: 74,729 rows over 63,357 features). The FEATURE
 *     is the real-world parcel.
 *   - `ST_PointOnSurface`, not `ST_Centroid`: a centroid can fall outside a
 *     concave parcel, and a representative point cannot.
 *   - `DISTINCT p.feature_index` in the join, because a parcel can match more
 *     than one subdivided city piece. Without it the denominator inflates and
 *     the ratio is quietly wrong in the safe-looking direction.
 */
export async function measureIncorporatedStampCounts(
  q: RailScoreQueryable,
  parcelTable: string,
  column: string,
  countyFips: string,
  locatable: { features: number; featuresWithGeom: number },
): Promise<IncorporatedStampCounts> {
  const r = await q.query<{
    incorporated: string;
    stamped: string;
    county_features: string;
    county_stamped: string;
  }>(
    `WITH cb AS (
       SELECT min(west_lng) AS w, min(south_lat) AS s,
              max(east_lng) AS e, max(north_lat) AS n
         FROM ${parcelTable} WHERE county_fips = $1
     ),
     cities AS MATERIALIZED (
       SELECT ST_Subdivide(
                ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(c.geometry::text), 4326)),
                ${CITY_GEOMETRY_SUBDIVIDE_VERTICES}
              ) AS g
         FROM ${CITY_BOUNDARY_TABLE} c, cb
        WHERE c.west_lng <= cb.e AND c.east_lng >= cb.w
          AND c.south_lat <= cb.n AND c.north_lat >= cb.s
     ),
     p AS (
       SELECT DISTINCT ON (feature_index) feature_index, geom, ${column} AS v
         FROM ${parcelTable}
        WHERE county_fips = $1
        ORDER BY feature_index
     ),
     j AS (
       SELECT DISTINCT p.feature_index, p.v
         FROM cities ci
         JOIN p ON p.geom && ci.g AND ST_Contains(ci.g, ST_PointOnSurface(p.geom))
     )
     SELECT (SELECT count(*) FROM j)::text                          AS incorporated,
            (SELECT count(*) FROM j WHERE v IS NOT NULL)::text      AS stamped,
            (SELECT count(*) FROM p)::text                          AS county_features,
            (SELECT count(*) FROM p WHERE v IS NOT NULL)::text      AS county_stamped`,
    [countyFips],
  );
  const row = r.rows[0];
  const incorporated = Number(row?.incorporated ?? 0);
  const stamped = Number(row?.stamped ?? 0);
  const countyFeatures = Number(row?.county_features ?? 0);
  const countyStamped = Number(row?.county_stamped ?? 0);
  return {
    incorporated,
    stamped,
    countyFeatures,
    countyFeaturesWithGeom: locatable.featuresWithGeom,
    countyStamped,
    stampedOutsideBoundary: countyStamped - stamped,
  };
}

/**
 * The provenance `detail` for one measured cell.
 *
 * It carries the ESCAPE COUNT deliberately. A reader who sees only
 * `9526/11968` cannot tell whether the numerator was filtered onto the
 * denominator or merely happened to fit; `outside=116` says the filter ran and
 * says what it removed. `formatRailScoreProvenance` forbids `;` in this field,
 * so the separators are commas.
 */
export function incorporatedStampDetail(
  counts: IncorporatedStampCounts,
  parcelTable: string,
  column: string,
): string {
  return (
    `column=${column},table=${parcelTable},boundary=${CITY_BOUNDARY_TABLE},` +
    `countyFeatures=${counts.countyFeatures},geomFeatures=${counts.countyFeaturesWithGeom},` +
    `countyStamped=${counts.countyStamped},outside=${counts.stampedOutsideBoundary}`
  );
}
