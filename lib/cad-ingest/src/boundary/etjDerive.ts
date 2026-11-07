/**
 * P-359 — the ETJ derivation / validity pass, run by the ETJ ingest for exactly
 * the publishers it is (re-)acquiring.
 *
 * THE DEFECT THIS ANSWERS. An ETJ is by definition OUTSIDE city limits. P-332
 * measured that in six Phase 0 counties 77,459 of 611,116 in-city parcels read
 * incorporated PLUS ETJ-present, and that 74,785 of those sit in a ring from one
 * of three single-polygon publishers (`georgetown-tx:9644`, `leander-tx:1`,
 * `dripping-springs-tx:1`) whose published polygon CONTAINS its own city's
 * representative point. Those publishers drew one shape for "city plus ETJ", and
 * the serve path read it as a blanket `present` for the city's own parcels.
 * Separately, 24 of 355 rings fail `ST_IsValid`, and `ST_Contains` against an
 * invalid polygon is undefined in GEOS.
 *
 * WHAT THIS PASS DOES, in one SQL statement per ingest run, per publisher set:
 *
 *   1. keeps the publisher's geometry verbatim (it never writes `geometry`);
 *   2. decides validity from `ST_IsValid` and reads the reason from
 *      `ST_IsValidReason`, so the record says what Postgres said;
 *   3. tests self-containment with ONE decisive test —
 *      `ST_Contains(ST_MakeValid(ring), ST_PointOnSurface(ST_MakeValid(city)))`
 *      — the same test P-332 reported and the same one the re-count's
 *      independent query uses, so the instrument and the derivation cannot
 *      agree merely because they share a bug;
 *   4. writes `served_geometry` = the ring minus its own city's limits, or the
 *      `ST_MakeValid` repair, and the `derivation` record (what was subtracted,
 *      which city boundary and its vintage, `ST_IsValidReason`, validity after,
 *      areas before and after, area removed, the tolerance applied);
 *   5. FAILS CLOSED. `served_status` is only ever written to `verbatim`,
 *      `derived`, `repaired`, `excluded` or `withheld`; a row that does not go
 *      through this pass keeps the column default `underived`, and the reader
 *      refuses and declares it.
 *
 * WHY THE AREA MEASURE IS PLANAR (EPSG:3081), measured rather than assumed:
 * `ST_Area(g::geography)` RAISES on a hole-outside-shell polygon
 * (`lwgeom_area_spher(oid) returned area < 0.0`), which would abort the whole
 * pass for that publisher. `ST_Area(ST_Transform(g, 3081))` — Texas Centric
 * Albers, metres — evaluates on every invalid shape tested, so published and
 * served areas are always comparable and the pass never dies on its own input.
 *
 * WHY A NON-POSITIVE PUBLISHED AREA IS EXCLUDED, not repaired: measured on the
 * same fixtures, a self-intersecting ring's own shoelace area is 0 (the crossed
 * lobes cancel) and a misplaced hole can drive it negative. A relative tolerance
 * against a non-positive denominator is not a test, so such a ring is excluded
 * and declared rather than served on the strength of an unbounded repair.
 *
 * THE JOIN is the ring's own `city_name` (lowercased, non-alphanumerics
 * stripped), per the dispatch and P-332's validated method. `city_key` is
 * deliberately NOT the join key: normalizing it silently drops Bastrop
 * (`bastrop-city-tx` normalizes to `bastropcity`, its parcels' city name to
 * `bastrop`). `city_geo_id` is nullable and informational by the table's own
 * doc, so it is not the join key either.
 */

import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { txCityBoundary, txEtjBoundary } from "@workspace/db/schema";
import type { EtjRingDerivation, EtjServedStatus } from "@workspace/db/schema";

/**
 * The declared relative-area tolerance for a `ST_MakeValid` repair: 0.1 percent
 * of the published area. Chosen, not derived — far below the area a mis-repair
 * of a real ring moves (the two fixtures that move area at all move it by 14
 * percent and 450 percent) and far above floating-point noise at these
 * coordinate magnitudes (the two fixtures that repair cleanly move it by 0.000
 * percent). A repair outside it is EXCLUDED and declared, never served.
 */
export const REPAIR_RELATIVE_AREA_TOLERANCE = 0.001;

/**
 * The planar CRS every area in this pass is measured in: Texas Centric Albers
 * (metres). Not `::geography`, which raises on invalid geometry — see the
 * module doc.
 *
 * It is bound as a PARAMETER and must be cast (`::int`) at every use: with an
 * untyped parameter Postgres resolves `ST_Transform(geom, $1)` to the
 * proj-STRING overload and fails with `could not parse proj string '3081'`.
 * Measured, not guessed — the first run of the integration suite died on it.
 */
export const ETJ_AREA_SRID = 3081;

/** The statuses this pass may write. `underived` is the column default, never written. */
export const ETJ_DERIVED_STATUSES = [
  "verbatim",
  "derived",
  "repaired",
  "excluded",
  "withheld",
] as const satisfies readonly EtjServedStatus[];

export type EtjDeriveDb = Pick<
  NodePgDatabase<Record<string, unknown>>,
  "execute"
>;

/** One ring's outcome, returned so the caller can print and the close can paste. */
export interface EtjRingDerivationOutcome {
  etjId: string;
  cityKey: string;
  cityName: string;
  ringLabel: string;
  servedStatus: EtjServedStatus;
  /** Planar square metres (EPSG:3081), as published. */
  areaPublished: number | null;
  /** Planar square metres (EPSG:3081) of the served geometry. */
  areaServed: number | null;
  /** What the pass decided. */
  kind: EtjRingDerivation["kind"];
  /** The honest sentence, when there is one. */
  note: string | null;
}

export interface EtjDeriveSummary {
  /** Rings the pass wrote a status for. Equal to `outcomes.length`. */
  ringsDerived: number;
  /** Count per served status. Every derived status appears, zero included. */
  byStatus: Record<(typeof ETJ_DERIVED_STATUSES)[number], number>;
  outcomes: EtjRingDerivationOutcome[];
}

/**
 * Derive the served geometry, the validity repair and the derivation record for
 * every ring of the named publishers. Idempotent: running it twice writes the
 * same values (the record's `at` timestamp is the only thing that moves).
 *
 * The caller is the ETJ ingest, for exactly the publishers it just wrote.
 */
export async function deriveEtjServedGeometry(
  db: EtjDeriveDb,
  cityKeys: readonly string[],
  opts: { tolerance?: number } = {},
): Promise<EtjDeriveSummary> {
  const tolerance = opts.tolerance ?? REPAIR_RELATIVE_AREA_TOLERANCE;
  const byStatus = Object.fromEntries(
    ETJ_DERIVED_STATUSES.map((s) => [s, 0]),
  ) as EtjDeriveSummary["byStatus"];

  if (cityKeys.length === 0) {
    return { ringsDerived: 0, byStatus, outcomes: [] };
  }

  // `sql.param`, not plain interpolation: drizzle spreads a JS array into one
  // placeholder per element ($1, $2, ...) for IN-clause convenience, which is
  // not what `ANY($1)` needs — `sql.param` binds a single parameter and lets
  // node-postgres serialize the array literal. Same reason as `upsertTxgioParcels`.
  const keys = sql.param([...cityKeys]);

  const result = await db.execute(sql`
    WITH cities AS (
      -- The publisher's own city limits, keyed the way P-332's validated run
      -- keyed them: the city's own name, normalized. Distinct-on makes a
      -- duplicate normalized name deterministic (lowest geo_id wins) instead of
      -- joining the same ring to two polygons.
      SELECT DISTINCT ON (nk)
             lower(regexp_replace(c.city_name, '[^a-zA-Z0-9]', '', 'g')) AS nk,
             c.geo_id, c.city_name, c.source_vintage,
             ST_MakeValid(ST_GeomFromGeoJSON(c.geometry::text)) AS cg
        FROM ${txCityBoundary} c
       ORDER BY nk, c.geo_id
    ),
    targets AS (
      SELECT b.etj_id, b.city_key, b.city_name, b.ring_label,
             ST_GeomFromGeoJSON(b.geometry::text) AS g,
             ST_MakeValid(ST_GeomFromGeoJSON(b.geometry::text)) AS gvalid,
             ST_IsValid(ST_GeomFromGeoJSON(b.geometry::text)) AS is_valid,
             ST_IsValidReason(ST_GeomFromGeoJSON(b.geometry::text)) AS invalid_reason,
             ST_Area(ST_Transform(ST_GeomFromGeoJSON(b.geometry::text), ${ETJ_AREA_SRID}::int)) AS area_published
        FROM ${txEtjBoundary} b
       WHERE b.city_key = ANY(${keys}::text[])
    ),
    joined AS (
      SELECT t.*, ci.city_name AS limits_name, ci.geo_id AS limits_geo_id,
             ci.source_vintage AS limits_vintage, ci.cg,
             (ci.cg IS NOT NULL
              AND ST_Contains(t.gvalid, ST_PointOnSurface(ci.cg))) AS contains_own_city
        FROM targets t
        LEFT JOIN cities ci
          ON ci.nk = lower(regexp_replace(t.city_name, '[^a-zA-Z0-9]', '', 'g'))
    ),
    shaped AS (
      -- The repair must be extracted to polygons: ST_MakeValid returns a
      -- GeometryCollection for the two clean-repair shapes measured here (a
      -- duplicated-vertex spike, a self-touching pinch), and a point-in-polygon
      -- reader can only test Polygon/MultiPolygon.
      SELECT j.*,
             ST_CollectionExtract(j.gvalid, 3) AS repaired_geom,
             ST_Area(ST_Transform(ST_CollectionExtract(j.gvalid, 3), ${ETJ_AREA_SRID}::int)) AS area_repaired,
             CASE WHEN j.contains_own_city
                  THEN ST_CollectionExtract(ST_MakeValid(ST_Difference(j.gvalid, j.cg)), 3)
                  WHEN NOT j.is_valid THEN ST_CollectionExtract(j.gvalid, 3)
                  ELSE NULL END AS candidate_geom
        FROM joined j
    ),
    scored AS (
      SELECT s.*,
             CASE WHEN s.candidate_geom IS NULL OR ST_IsEmpty(s.candidate_geom) THEN NULL
                  ELSE ST_Area(ST_Transform(s.candidate_geom, ${ETJ_AREA_SRID}::int)) END AS area_candidate,
             (s.candidate_geom IS NULL OR ST_IsEmpty(s.candidate_geom)
              OR NOT ST_IsValid(s.candidate_geom)) AS candidate_unusable,
             -- The tolerance is measured on the REPAIR alone, before any city
             -- subtraction: for a ring that is both invalid and self-containing
             -- the subtraction is a legitimate removal, and charging it to the
             -- repair would exclude a repair that changed nothing.
             CASE
               WHEN NOT s.is_valid
                AND (s.repaired_geom IS NULL OR ST_IsEmpty(s.repaired_geom)
                     OR NOT ST_IsValid(s.repaired_geom)) THEN TRUE
               WHEN NOT s.is_valid
                AND (s.area_published IS NULL OR s.area_published <= 0) THEN TRUE
               WHEN NOT s.is_valid
                THEN abs(s.area_repaired - s.area_published) / s.area_published > ${tolerance}
               ELSE FALSE
             END AS excluded
        FROM shaped s
    ),
    verdict AS (
      SELECT s.*,
             CASE
               WHEN s.excluded THEN 'excluded'
               WHEN s.contains_own_city AND s.candidate_unusable THEN 'withheld'
               WHEN s.contains_own_city THEN 'derived'
               WHEN NOT s.is_valid THEN 'repaired'
               ELSE 'verbatim'
             END AS status
        FROM scored s
    )
    UPDATE ${txEtjBoundary} b
       SET served_status = v.status,
           served_geometry = CASE WHEN v.status IN ('derived', 'repaired')
                                  THEN ST_AsGeoJSON(v.candidate_geom)::jsonb END,
           area_published = v.area_published,
           area_served = CASE WHEN v.status IN ('derived', 'repaired') THEN v.area_candidate
                              WHEN v.status = 'verbatim' THEN v.area_published END,
           derived_at = now(),
           derivation = jsonb_strip_nulls(jsonb_build_object(
             'kind', CASE WHEN NOT v.is_valid AND v.excluded THEN 'invalid'
                          WHEN NOT v.is_valid THEN 'invalid_repair'
                          WHEN v.contains_own_city THEN 'self_containing'
                          ELSE 'clean' END,
             'at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
             'isValidPublished', v.is_valid,
             'isValidReason', CASE WHEN NOT v.is_valid THEN v.invalid_reason END,
             'isValidServed', CASE WHEN v.candidate_geom IS NOT NULL
                                   THEN ST_IsValid(v.candidate_geom) END,
             'repaired', NOT v.is_valid,
             'subtracted', CASE WHEN v.contains_own_city THEN jsonb_build_object(
               'table', 'tx_city_boundary',
               'matchedBy', 'city_name_normalized',
               'cityGeoId', v.limits_geo_id,
               'cityName', v.limits_name,
               'boundaryVintage', v.limits_vintage) END,
             'areaPublished', v.area_published,
             'areaServed', CASE WHEN v.status IN ('derived', 'repaired') THEN v.area_candidate
                                WHEN v.status = 'verbatim' THEN v.area_published END,
             'areaRemoved', CASE WHEN v.status IN ('derived', 'repaired')
                                 THEN v.area_published - v.area_candidate
                                 WHEN v.status = 'verbatim' THEN 0 END,
             'repairAreaDeltaFraction', CASE WHEN NOT v.is_valid AND v.area_published > 0
                                             THEN abs(v.area_repaired - v.area_published)
                                                  / v.area_published END,
             -- The declared tolerance is data, not SQL text, so it travels as a
             -- parameter — but it needs its type: inside jsonb_build_object
             -- Postgres cannot infer one, and an undetermined parameter is a
             -- parse-time failure that would abort the whole ingest.
             'toleranceFraction', (${tolerance})::double precision,
             'note', CASE
               WHEN v.excluded AND (v.area_published IS NULL OR v.area_published <= 0)
                 THEN 'ST_IsValid false and the published geometry''s planar area is not positive, so ST_MakeValid''s movement cannot be bounded by the declared relative tolerance; nothing is served'
               WHEN v.excluded
                 THEN 'ST_IsValid false and ST_MakeValid moved the area beyond the declared relative tolerance; nothing is served'
             WHEN v.status = 'withheld'
               THEN 'the ring contains its own city''s representative point but the subtraction left no usable polygon; nothing is served'
             -- Both facts, named: Georgetown's ring is the measured member of
             -- this class (invalid published geometry AND its own city inside),
             -- and its note is the sentence the panel shows. A note that named
             -- only the repair would leave the subtraction — the larger of the
             -- two edits to the publisher's drawing — unspoken.
             WHEN NOT v.is_valid AND v.contains_own_city
               THEN 'ST_IsValid false; served geometry is ST_CollectionExtract(ST_MakeValid(...), 3), then minus '
                    || v.limits_name || '''s limits'
             WHEN NOT v.is_valid
               THEN 'ST_IsValid false; served geometry is ST_CollectionExtract(ST_MakeValid(...), 3)'
             WHEN v.limits_name IS NULL
               THEN 'the ring''s own city is not in tx_city_boundary, so containment of its own city is untestable; served verbatim'
             WHEN v.contains_own_city
               THEN 'the ring contains its own city''s representative point; served geometry is the ring minus that city''s limits'
             ELSE NULL END))
      FROM verdict v
     WHERE b.etj_id = v.etj_id
    RETURNING b.etj_id, b.city_key, b.city_name, b.ring_label, b.served_status,
              b.area_published, b.area_served,
              b.derivation ->> 'kind' AS kind,
              b.derivation ->> 'note' AS note
  `);

  const outcomes: EtjRingDerivationOutcome[] = (
    result.rows as Array<{
      etj_id: string;
      city_key: string;
      city_name: string;
      ring_label: string;
      served_status: EtjServedStatus;
      area_published: number | null;
      area_served: number | null;
      kind: EtjRingDerivation["kind"];
      note: string | null;
    }>
  ).map((r) => ({
    etjId: r.etj_id,
    cityKey: r.city_key,
    cityName: r.city_name,
    ringLabel: r.ring_label,
    servedStatus: r.served_status,
    areaPublished: r.area_published,
    areaServed: r.area_served,
    kind: r.kind,
    note: r.note,
  }));

  for (const o of outcomes) {
    if ((ETJ_DERIVED_STATUSES as readonly string[]).includes(o.servedStatus)) {
      byStatus[o.servedStatus as keyof typeof byStatus] += 1;
    }
  }

  return { ringsDerived: outcomes.length, byStatus, outcomes };
}
