/**
 * N nearest parcels to a subject parcel in the txgio_parcel store (map geometry).
 *
 * Distance is PostGIS ST_Distance on geography (minimum boundary-to-boundary
 * separation in feet), not centroid-only ranking. Candidate discovery uses
 * the GiST index `txgio_parcel_geom_gist_idx` via the KNN operator `<->`.
 *
 * Tile-key duplication (one parcel row per grid cell) is collapsed by normalized
 * prop id before ranking.
 */

import pg from "pg";
import { parseParcelNodeId, parcelNodeId } from "./parcelNodeId";

/** Same six counties as `CONSTRAINT_SEARCH_COUNTIES` (parcelConstraintSearch.ts). */
export const NEAREST_PARCELS_SERVING_COUNTIES = [
  "48021",
  "48055",
  "48209",
  "48309",
  "48453",
  "48491",
] as const;

function isNearestParcelsCounty(fips: string): boolean {
  return (NEAREST_PARCELS_SERVING_COUNTIES as readonly string[]).includes(fips);
}

/** Default comparables cap — keeps stub fan-out bounded on MCP round-trips. */
export const NEAREST_PARCELS_DEFAULT_CAP = 20;
/** Hard ceiling; matches radius-search's cap philosophy. */
export const NEAREST_PARCELS_MAX_CAP = 50;
/**
 * KNN rows fetched before dedupe. Tile duplication is small; this headroom
 * avoids returning fewer than cap distinct parcels in dense grids.
 */
export const NEAREST_PARCELS_KNN_PREFETCH = 120;

export const NEAREST_PARCELS_SPATIAL_INDEX = "txgio_parcel_geom_gist_idx";

export type NearestParcelsQueryable = Pick<pg.Pool, "query">;

export type NearestParcelGeometryHit = {
  parcelNodeId: string;
  countyFips: string;
  propId: string;
  distanceFt: number;
};

export type NearestParcelsOk = {
  subjectParcelNodeId: string;
  cap: number;
  received: number;
  truncated: boolean;
  distanceMethod: "postgis_geography_st_distance";
  spatialIndex: typeof NEAREST_PARCELS_SPATIAL_INDEX;
  neighbors: NearestParcelGeometryHit[];
};

export type NearestParcelsRefuse = {
  refused: true;
  code:
    | "nearest_invalid_node"
    | "nearest_county_out_of_scope"
    | "nearest_subject_not_in_store"
    | "nearest_store_not_configured";
  reason: string;
};

export type NearestParcelsResult = NearestParcelsOk | NearestParcelsRefuse;

export function clampNearestCap(raw: number | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return NEAREST_PARCELS_DEFAULT_CAP;
  return Math.min(Math.max(Math.floor(raw), 1), NEAREST_PARCELS_MAX_CAP);
}

type RawKnnRow = {
  county_fips: string;
  prop_id: string;
  distance_ft: number | string;
};

/**
 * Collapse tile copies and exclude the subject; preserve ascending distance.
 */
export function dedupeNearestKnnRows(input: {
  rows: ReadonlyArray<{ countyFips: string; propId: string; distanceFt: number }>;
  subjectParcelNodeId: string;
  cap: number;
}): { neighbors: NearestParcelGeometryHit[]; truncated: boolean } {
  const subject = input.subjectParcelNodeId.trim();
  const seen = new Set<string>();
  const neighbors: NearestParcelGeometryHit[] = [];
  for (const row of input.rows) {
    const nodeId = parcelNodeId(row.countyFips, row.propId);
    if (!nodeId || nodeId === subject) continue;
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    neighbors.push({
      parcelNodeId: nodeId,
      countyFips: row.countyFips,
      propId: row.propId,
      distanceFt: row.distanceFt,
    });
    if (neighbors.length > input.cap) break;
  }
  const truncated = neighbors.length > input.cap;
  return {
    neighbors: neighbors.slice(0, input.cap),
    truncated,
  };
}

export async function searchNearestParcels(input: {
  parcelNodeId: string;
  cap?: number;
  db: NearestParcelsQueryable | null;
}): Promise<NearestParcelsResult> {
  const parsed = parseParcelNodeId(input.parcelNodeId.trim());
  if (!parsed) {
    return {
      refused: true,
      code: "nearest_invalid_node",
      reason: "parcelNodeId must be a canonical countyFips:propId node id.",
    };
  }
  if (!isNearestParcelsCounty(parsed.countyFips)) {
    return {
      refused: true,
      code: "nearest_county_out_of_scope",
      reason: `County ${parsed.countyFips} is outside Smart Site parcel coverage for nearest search. Refusing rather than returning an empty list.`,
    };
  }
  if (!input.db) {
    return {
      refused: true,
      code: "nearest_store_not_configured",
      reason: "The parcel geometry store is not configured on this deployment.",
    };
  }

  const cap = clampNearestCap(input.cap);
  const prefetch = Math.max(NEAREST_PARCELS_KNN_PREFETCH, cap * 4);

  const knn = await input.db.query<RawKnnRow>(
    `with subject as (
       select geom
         from txgio_parcel
        where county_fips = $1
          and (prop_id = $2 or ltrim(prop_id, '0') = $2)
          and geom is not null
        limit 1
     )
     select p.county_fips,
            p.prop_id,
            ST_Distance(
              s.geom::geography,
              p.geom::geography
            ) * 3.280839895013123 as distance_ft
       from txgio_parcel p
       cross join subject s
      where p.county_fips = $1
        and p.geom is not null
      order by p.geom <-> s.geom
      limit $3`,
    [parsed.countyFips, parsed.propId, prefetch],
  );

  if (knn.rows.length === 0) {
    return {
      refused: true,
      code: "nearest_subject_not_in_store",
      reason: `Subject parcel ${input.parcelNodeId.trim()} has no geometry in the parcel store.`,
    };
  }

  const ranked = knn.rows
    .map((r) => ({
      countyFips: r.county_fips?.trim() ?? "",
      propId: r.prop_id?.trim() ?? "",
      distanceFt: Number(r.distance_ft),
    }))
    .filter(
      (r) =>
        r.countyFips &&
        r.propId &&
        Number.isFinite(r.distanceFt) &&
        r.distanceFt >= 0,
    )
    .sort((a, b) => a.distanceFt - b.distanceFt);

  const { neighbors, truncated } = dedupeNearestKnnRows({
    rows: ranked,
    subjectParcelNodeId: input.parcelNodeId.trim(),
    cap,
  });

  return {
    subjectParcelNodeId: input.parcelNodeId.trim(),
    cap,
    received: neighbors.length,
    truncated,
    distanceMethod: "postgis_geography_st_distance",
    spatialIndex: NEAREST_PARCELS_SPATIAL_INDEX,
    neighbors,
  };
}
