/**
 * Point + radius parcel set search over txgio_parcel.
 *
 * Geometry is jsonb GeoJSON with bbox columns, not PostGIS. Candidates
 * are bbox-overlap with the search circle's bbox, constrained first to
 * the one or two counties whose tx_county_boundary bbox overlaps, then
 * to the covering tile_key cells (the pk). A statewide county IN list
 * seq-scans 16M rows; that is the hang this file used to ship.
 * A parcel is in the set when the point is inside the polygon or the
 * point-to-bbox distance is <= radiusFt.
 *
 * Truncation is a field. A silent first-N is the defect this route
 * exists to not repeat. A candidate ceiling that fires is a refuse,
 * not a short answer that looks complete.
 */

import { and, gte, inArray, lte } from "drizzle-orm";
import { db as defaultDb, txCountyBoundary, txgioParcel } from "@workspace/db";
import {
  cellKeysForBbox,
  pointInGeometry,
  type GeoJsonGeometry,
} from "@workspace/cad-ingest/txgio-geo";
import { parcelNodeId } from "./parcelNodeId";

export const RADIUS_SEARCH_CAP = 50;
export const RADIUS_SEARCH_MAX_FT = 5280;
export const RADIUS_SEARCH_CANDIDATE_CEILING = 2000;
/** Same cell ceiling as txgioParcelStore. A 5280 ft box is a handful of cells. */
export const RADIUS_SEARCH_MAX_TILE_CELLS = 256;

export type RadiusSearchHit = {
  parcelNodeId: string;
  situsAddress: string | null;
  countyFips: string;
  distanceFt: number;
};

export type RadiusSearchOk = {
  hits: RadiusSearchHit[];
  cap: number;
  received: number;
  truncated: boolean;
  radiusFt: number;
};

export type RadiusSearchRefuse = {
  refused: true;
  code:
    | "radius_invalid"
    | "radius_exceeds_max"
    | "radius_unbounded"
    | "radius_county_unresolved";
  reason: string;
};

export type RadiusSearchResult = RadiusSearchOk | RadiusSearchRefuse;

/** Structural so tests can stub select/from/where without a live drizzle session. */
export type RadiusSearchDb = {
  select: (fields?: unknown) => {
    from: (table: unknown) => {
      where: (
        cond: unknown,
      ) => Promise<unknown[]> | { limit: (n: number) => Promise<unknown[]> };
    };
  };
};

const FT_PER_DEG_LAT = 364000;
const EARTH_RADIUS_FT = 20_902_231;

export function haversineFeet(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_FT * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function pointToBboxDistanceFt(
  lat: number,
  lng: number,
  bbox: { westLng: number; southLat: number; eastLng: number; northLat: number },
): number {
  const clampLng = Math.min(Math.max(lng, bbox.westLng), bbox.eastLng);
  const clampLat = Math.min(Math.max(lat, bbox.southLat), bbox.northLat);
  if (clampLng === lng && clampLat === lat) return 0;
  return haversineFeet(lat, lng, clampLat, clampLng);
}

export function circleBbox(
  lat: number,
  lng: number,
  radiusFt: number,
): { westLng: number; southLat: number; eastLng: number; northLat: number } {
  const dLat = radiusFt / FT_PER_DEG_LAT;
  const cos = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const dLng = radiusFt / (FT_PER_DEG_LAT * cos);
  return {
    westLng: lng - dLng,
    southLat: lat - dLat,
    eastLng: lng + dLng,
    northLat: lat + dLat,
  };
}

export function parcelDistanceFt(input: {
  lat: number;
  lng: number;
  geometry: unknown;
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
}): number {
  const bbox = {
    westLng: input.westLng,
    southLat: input.southLat,
    eastLng: input.eastLng,
    northLat: input.northLat,
  };
  if (
    input.geometry &&
    typeof input.geometry === "object" &&
    pointInGeometry(input.lng, input.lat, input.geometry as GeoJsonGeometry)
  ) {
    return 0;
  }
  return pointToBboxDistanceFt(input.lat, input.lng, bbox);
}

export function rankRadiusHits(
  rows: ReadonlyArray<{
    countyFips: string | null;
    propId: string | null;
    situsAddress: string | null;
    geometry: unknown;
    westLng: number;
    southLat: number;
    eastLng: number;
    northLat: number;
  }>,
  lat: number,
  lng: number,
  radiusFt: number,
): RadiusSearchHit[] {
  const byParcel = new Map<string, RadiusSearchHit>();
  for (const r of rows) {
    const fips = r.countyFips?.trim();
    const propId = r.propId?.trim();
    if (!fips || !propId) continue;
    const nodeId = parcelNodeId(fips, propId);
    if (!nodeId) continue;
    const distanceFt = parcelDistanceFt({
      lat,
      lng,
      geometry: r.geometry,
      westLng: r.westLng,
      southLat: r.southLat,
      eastLng: r.eastLng,
      northLat: r.northLat,
    });
    if (distanceFt > radiusFt) continue;
    const prev = byParcel.get(nodeId);
    if (!prev || distanceFt < prev.distanceFt) {
      byParcel.set(nodeId, {
        parcelNodeId: nodeId,
        situsAddress: r.situsAddress?.trim() ?? null,
        countyFips: fips,
        distanceFt,
      });
    }
  }
  return [...byParcel.values()].sort((a, b) => a.distanceFt - b.distanceFt);
}

export function sliceRadiusHits(
  ranked: RadiusSearchHit[],
  cap: number,
): { hits: RadiusSearchHit[]; truncated: boolean } {
  const truncated = ranked.length > cap;
  return { hits: ranked.slice(0, cap), truncated };
}

function clampCap(raw: number | undefined): number {
  return Math.min(
    Math.max(Math.floor(raw ?? RADIUS_SEARCH_CAP), 1),
    RADIUS_SEARCH_CAP,
  );
}

/**
 * Counties whose stored bbox overlaps the search box. tx_county_boundary
 * is 254 rows; a 50-foot circle in Bastrop must not consider Amarillo.
 * Bbox overlap is conservative (Lee's rectangle can cover a Bastrop
 * interior point) and is the one-or-two-county bound, not a PIP claim.
 */
export async function countiesOverlappingBbox(
  box: { westLng: number; southLat: number; eastLng: number; northLat: number },
  database: RadiusSearchDb,
): Promise<string[]> {
  const rows = (await database
    .select({ countyFips: txCountyBoundary.countyFips })
    .from(txCountyBoundary)
    .where(
      and(
        lte(txCountyBoundary.westLng, box.eastLng),
        gte(txCountyBoundary.eastLng, box.westLng),
        lte(txCountyBoundary.southLat, box.northLat),
        gte(txCountyBoundary.northLat, box.southLat),
      ),
    )) as { countyFips: string | null }[];
  const out: string[] = [];
  for (const r of rows) {
    const fips = r.countyFips?.trim();
    if (fips && !out.includes(fips)) out.push(fips);
  }
  return out;
}

export async function searchParcelsByRadius(input: {
  lat: number;
  lng: number;
  radiusFt: number;
  cap?: number;
  database?: RadiusSearchDb;
}): Promise<RadiusSearchResult> {
  if (!Number.isFinite(input.lat) || !Number.isFinite(input.lng)) {
    return {
      refused: true,
      code: "radius_invalid",
      reason: "lat and lng must be finite numbers",
    };
  }
  if (!Number.isFinite(input.radiusFt) || input.radiusFt <= 0) {
    return {
      refused: true,
      code: "radius_invalid",
      reason: "radiusFt must be a positive number",
    };
  }
  if (input.radiusFt > RADIUS_SEARCH_MAX_FT) {
    return {
      refused: true,
      code: "radius_exceeds_max",
      reason: `radiusFt ${input.radiusFt} exceeds the stated max ${RADIUS_SEARCH_MAX_FT}`,
    };
  }

  const cap = clampCap(input.cap);
  const box = circleBbox(input.lat, input.lng, input.radiusFt);
  const database = input.database ?? defaultDb;

  const counties = await countiesOverlappingBbox(box, database);
  if (counties.length === 0) {
    return {
      refused: true,
      code: "radius_county_unresolved",
      reason:
        "No Texas county boundary overlaps the search box. Refusing rather than scanning every county.",
    };
  }

  const cells = cellKeysForBbox(box, undefined, RADIUS_SEARCH_MAX_TILE_CELLS);
  const parcelColumns = {
    countyFips: txgioParcel.countyFips,
    propId: txgioParcel.propId,
    situsAddress: txgioParcel.situsAddress,
    geometry: txgioParcel.geometry,
    westLng: txgioParcel.westLng,
    southLat: txgioParcel.southLat,
    eastLng: txgioParcel.eastLng,
    northLat: txgioParcel.northLat,
  };
  const bboxPred = and(
    inArray(txgioParcel.countyFips, counties),
    lte(txgioParcel.westLng, box.eastLng),
    gte(txgioParcel.eastLng, box.westLng),
    lte(txgioParcel.southLat, box.northLat),
    gte(txgioParcel.northLat, box.southLat),
  );
  const parcelWhere =
    cells !== null && cells.length > 0
      ? and(bboxPred, inArray(txgioParcel.tileKey, cells))
      : bboxPred;

  const rows = (await database
    .select(parcelColumns)
    .from(txgioParcel)
    .where(parcelWhere)
    .limit(RADIUS_SEARCH_CANDIDATE_CEILING + 1)) as {
    countyFips: string | null;
    propId: string | null;
    situsAddress: string | null;
    geometry: unknown;
    westLng: number;
    southLat: number;
    eastLng: number;
    northLat: number;
  }[];

  if (rows.length > RADIUS_SEARCH_CANDIDATE_CEILING) {
    return {
      refused: true,
      code: "radius_unbounded",
      reason:
        `Candidate set exceeded ${RADIUS_SEARCH_CANDIDATE_CEILING}. ` +
        "Refusing rather than returning a silently short neighbourhood.",
    };
  }

  const ranked = rankRadiusHits(rows, input.lat, input.lng, input.radiusFt);
  const { hits, truncated } = sliceRadiusHits(ranked, cap);
  return {
    hits,
    cap,
    received: hits.length,
    truncated,
    radiusFt: input.radiusFt,
  };
}
