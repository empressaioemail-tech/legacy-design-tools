/**
 * The Tier-1 bake's PARCEL JOIN: which `txgio_parcel*` table serves a county,
 * which optional columns it carries, and the SELECT that reads a parcel row
 * by `(county_fips, prop_id)`.
 *
 * Extracted 2026-08-28 (OPS-19 A-025, CTX card E) from
 * `../nodeFacetBakeTier1Cli.ts` so the conformant-v1 publish bake performs
 * the SAME zoning-stamp join the old bake performed, keyed by parcel node id
 * (`county_fips` + normalized `prop_id`), by import rather than by a fork.
 *
 * Imports no `pg` (the caller passes its open pool) and no `@workspace/db`,
 * matching the bake CLIs' DB-free module-load discipline.
 */

import type { QueryablePool } from "./joinIntegrityGate";

export type { QueryablePool };

/** Tables read, prod winning over staging for a county (same as PMTiles bake). */
export const PARCEL_TABLES = ["txgio_parcel", "txgio_parcel_staging"] as const;

export interface ParcelTableSource {
  table: string;
  /**
   * Whether the chosen table carries the `zoning_district` column. The prod
   * `txgio_parcel` table has it; the older `txgio_parcel_staging` bulk-load
   * table does NOT (it predates the zoning stamp). A county served from a
   * table without the column bakes zoning-absent HONESTLY (NULL) rather than
   * crashing the SELECT — never a fabricated district.
   */
  hasZoning: boolean;
  /**
   * Whether `zoning_jurisdiction` (PIP cityKey provenance) is present.
   * Absent on staging / pre-0062 tables — resolve falls back to situs only.
   */
  hasZoningJurisdiction: boolean;
}

/**
 * A parcel row as the bakes select it. `txgio_owner_for_gate` is selected
 * ONLY for counties whose land-use is recovered via the situs-address join
 * (the per-match owner gate); it is never copied into a baked payload.
 */
export interface ParcelJoinRow {
  feature_index: number;
  prop_id: string | null;
  /**
   * The GEOMETRY publisher's own parcel identifier (P-124 CTX-HAYS-REBIND).
   *
   * Selected so the crosswalk bind can record WHICH published identifier it
   * matched on, rather than asserting it. Both parcel tables carry the column
   * (production `information_schema.columns`, read 2026-09-10), but its
   * POPULATION varies by county and the difference is decisive: Hays 48209 has
   * 130,246 of 131,734 rows populated (115,533 distinct) while Williamson
   * 48491 has ZERO of 304,298. A county with no `geo_id` cannot be crosswalk
   * bound at all, which is why the same code change moves Hays and provably
   * does not touch Williamson.
   */
  geo_id: string | null;
  situs_address: string | null;
  situs_city: string | null;
  situs_state: string | null;
  /**
   * Both parcel tables carry `situs_zip` (production information_schema read
   * 2026-08-28 19:56Z: txgio_parcel and txgio_parcel_staging), so it is
   * selected unconditionally (CTX card F).
   */
  situs_zip: string | null;
  zoning_district: string | null;
  zoning_jurisdiction: string | null;
  source_vintage: string | null;
  geometry: unknown;
  txgio_owner_for_gate: string | null;
}

export async function tableExists(
  pool: QueryablePool,
  table: string,
): Promise<boolean> {
  const r = await pool.query<{ r: string | null }>(
    "SELECT to_regclass($1) AS r",
    [table],
  );
  return r.rows[0]?.r != null;
}

export async function columnExists(
  pool: QueryablePool,
  table: string,
  column: string,
): Promise<boolean> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*) AS n
       FROM information_schema.columns
      WHERE table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return Number(r.rows[0]?.n ?? 0) > 0;
}

/** The optional-column facts for a parcel table. */
export async function describeParcelTable(
  pool: QueryablePool,
  table: string,
): Promise<Pick<ParcelTableSource, "hasZoning" | "hasZoningJurisdiction">> {
  const hasZoning = await columnExists(pool, table, "zoning_district");
  const hasZoningJurisdiction = await columnExists(
    pool,
    table,
    "zoning_jurisdiction",
  );
  return { hasZoning, hasZoningJurisdiction };
}

/**
 * The first parcel table (prod before staging) that holds at least one row
 * for the county, with its column facts. An existence probe (`LIMIT 1` on the
 * `(county_fips, prop_id)` index), not the old CLI's whole-county DISTINCT
 * count, because the publish bake runs once per prop-id page. Null when no
 * table holds the county.
 */
export async function resolveParcelTableForCounty(
  pool: QueryablePool,
  fips: string,
): Promise<ParcelTableSource | null> {
  for (const table of PARCEL_TABLES) {
    if (!(await tableExists(pool, table))) continue;
    const r = await pool.query<{ one: number }>(
      `SELECT 1 AS one FROM ${table} WHERE county_fips = $1 LIMIT 1`,
      [fips],
    );
    if (r.rows.length === 0) continue;
    const cols = await describeParcelTable(pool, table);
    return { table, ...cols };
  }
  return null;
}

/**
 * The SELECT list both bakes read: honest NULL projections for columns the
 * table lacks, and the owner column ONLY when the address-recovery gate
 * needs it.
 */
export function parcelSelectList(
  src: Pick<ParcelTableSource, "hasZoning" | "hasZoningJurisdiction">,
  needsOwnerForGate: boolean,
): string {
  const zoningSelect = src.hasZoning
    ? "zoning_district"
    : "NULL::text AS zoning_district";
  const zoningJurisdictionSelect = src.hasZoningJurisdiction
    ? "zoning_jurisdiction"
    : "NULL::text AS zoning_jurisdiction";
  const ownerSelect = needsOwnerForGate
    ? "owner_name AS txgio_owner_for_gate"
    : "NULL::text AS txgio_owner_for_gate";
  return `feature_index, prop_id, geo_id, situs_address, situs_city, situs_state, situs_zip,
          ${zoningSelect}, ${zoningJurisdictionSelect}, ${ownerSelect},
          source_vintage, geometry`;
}

/**
 * Parcel rows for a list of prop ids in one county: the old CLI's scoped
 * (`--prop-ids-file`) SELECT, `DISTINCT ON (feature_index)` to collapse the
 * one-row-per-cell duplication, ordered by feature_index. A prop id with
 * several features returns several rows; the caller decides which it keeps.
 */
export async function fetchParcelRowsByPropIds(
  pool: QueryablePool,
  fips: string,
  src: ParcelTableSource,
  propIds: readonly string[],
  needsOwnerForGate: boolean,
): Promise<ParcelJoinRow[]> {
  if (propIds.length === 0) return [];
  const r = await pool.query<ParcelJoinRow>(
    `SELECT DISTINCT ON (feature_index)
            ${parcelSelectList(src, needsOwnerForGate)}
       FROM ${src.table}
      WHERE county_fips = $1
        AND prop_id = ANY($2::text[])
      ORDER BY feature_index`,
    [fips, [...propIds]],
  );
  return r.rows;
}

/**
 * Parcel rows for a list of NORMALIZED situs keys (`normalizeSitusAddress`)
 * in one county. The situs-address recovery path uses this when the
 * county's prop_id join is gate-blocked. Owner is selected (the per-match
 * gate needs it); it is never copied into a payload. DISTINCT ON
 * feature_index, ordered by feature_index. A situs with several features
 * returns several rows; the caller keeps the first.
 */
export async function fetchParcelRowsBySitusKeys(
  pool: QueryablePool,
  fips: string,
  src: ParcelTableSource,
  situsKeys: readonly string[],
): Promise<ParcelJoinRow[]> {
  if (situsKeys.length === 0) return [];
  const r = await pool.query<ParcelJoinRow>(
    `SELECT DISTINCT ON (feature_index)
            ${parcelSelectList(src, true)}
       FROM ${src.table}
      WHERE county_fips = $1
        AND upper(regexp_replace(situs_address, '[^A-Za-z0-9]', '', 'g')) = ANY($2::text[])
      ORDER BY feature_index`,
    [fips, [...situsKeys]],
  );
  return r.rows;
}

/**
 * Parcel rows for a list of the CAD's published Geographic IDs
 * (`cad_property.property_number`) matched against `txgio_parcel.geo_id`, in
 * one county. The CROSSWALK bind (P-124 CTX-HAYS-REBIND).
 *
 * The third sibling of `fetchParcelRowsByPropIds` and `fetchParcelRowsBySitusKeys`
 * and the only one whose key is published on both sides. Used when a
 * gate-blocked county's CAD roll carries a Geographic ID, in preference to the
 * situs-address recovery, because that recovery is circular for a county whose
 * `cad_property.situs_address` was itself overwritten by the parcel store (see
 * `parcelCrosswalkJoinKey`).
 *
 * The owner column is selected for the same reason the situs fetcher selects
 * it: the caller's land-use recovery still runs its per-match owner gate, and
 * a crosswalk-bound row must be able to feed that gate rather than bypass it.
 * It is never copied into a payload.
 *
 * `DISTINCT ON (feature_index)` collapses the one-row-per-cell duplication;
 * blank geo_ids never reach here because `parcelCrosswalkJoinKey` refuses an
 * empty key, and the `btrim(geo_id) <> ''` guard makes that structural rather
 * than a caller convention. A geo_id carried by several features returns
 * several rows; the caller keeps the first, matching both siblings.
 *
 * THE COMPARISON IS ON THE RAW COLUMN, not on `btrim(geo_id)`. Measured on
 * staging 2026-09-10: zero of Hays 48209's 130,246 non-null geo_ids carry
 * surrounding whitespace, so trimming the comparand changes no result today
 * and would permanently prevent a plain `(county_fips, geo_id)` index from
 * being used -- the same trap the situs join already pays for, which needed a
 * 34-call functional index to escape. If a publisher ever pads a geo_id the
 * failure is a MISS, which is an honest geometry absence, never a wrong bind.
 */
export async function fetchParcelRowsByGeoIds(
  pool: QueryablePool,
  fips: string,
  src: ParcelTableSource,
  geoIds: readonly string[],
): Promise<ParcelJoinRow[]> {
  if (geoIds.length === 0) return [];
  const r = await pool.query<ParcelJoinRow>(
    `SELECT DISTINCT ON (feature_index)
            ${parcelSelectList(src, true)}
       FROM ${src.table}
      WHERE county_fips = $1
        AND geo_id IS NOT NULL
        AND btrim(geo_id) <> ''
        AND geo_id = ANY($2::text[])
      ORDER BY feature_index`,
    [fips, [...geoIds]],
  );
  return r.rows;
}
