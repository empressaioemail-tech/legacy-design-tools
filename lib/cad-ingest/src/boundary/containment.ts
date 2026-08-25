/**
 * Spatial containment helpers for Texas city and county boundary polygons.
 *
 * Pure logic (no db, no network): given an in-memory index of boundary
 * polygons and a query point or parcel geometry, resolve the containing
 * city (or an explicit honest unincorporated absence) and/or county.
 *
 * Reuses the dependency-free geometry math from `../txgio/geo.ts` (bbox
 * pre-filter + even-odd ray-cast `pointInGeometry`), same pattern as
 * `zoning-stamp.ts`.
 *
 * Unincorporated territory is the CORRECT answer for most of Texas by
 * area when the incorporated-place index is populated — returned as
 * `{ status: 'unincorporated', basis: ... }`, never as null, blank, or
 * a guessed city name. An empty index is a different state: unmeasured.
 * This helper never derives an ETJ ring or offset buffer.
 */

import {
  bboxOfGeometry,
  bboxesIntersect,
  pointInGeometry,
  type GeoBbox,
  type GeoJsonGeometry,
} from "../txgio/geo";

export interface CityBoundaryIndexEntry {
  geoId: string;
  cityName: string;
  gnis: string | null;
  geometry: GeoJsonGeometry;
  bbox: GeoBbox;
}

export interface CountyBoundaryIndexEntry {
  countyFips: string;
  countyName: string;
  geometry: GeoJsonGeometry;
  bbox: GeoBbox;
}

/** v1 never claims ETJ. Typed absence, not a dest column. */
export type EtjStatus = "unresolved";

export type CityContainmentResult =
  | {
      status: "incorporated";
      cityName: string;
      geoId: string;
      gnis: string | null;
      etjStatus: EtjStatus;
      basis: string;
    }
  | {
      status: "unincorporated";
      etjStatus: EtjStatus;
      basis: string;
    }
  | {
      status: "unmeasured";
      etjStatus: EtjStatus;
      basis: string;
    };

export type CountyContainmentResult =
  | {
      status: "resolved";
      countyFips: string;
      countyName: string;
      basis: string;
    }
  | {
      status: "unresolved";
      basis: string;
    };

/** Build a city index from normalized records or DB rows. */
export function buildCityBoundaryIndex(
  entries: Array<{
    geoId: string;
    cityName: string;
    gnis?: string | null;
    geometry: GeoJsonGeometry;
    bbox?: GeoBbox;
  }>,
): CityBoundaryIndexEntry[] {
  const out: CityBoundaryIndexEntry[] = [];
  for (const e of entries) {
    const bbox = e.bbox ?? bboxOfGeometry(e.geometry);
    if (!bbox) continue;
    out.push({
      geoId: e.geoId,
      cityName: e.cityName,
      gnis: e.gnis ?? null,
      geometry: e.geometry,
      bbox,
    });
  }
  return out;
}

export function buildCountyBoundaryIndex(
  entries: Array<{
    countyFips: string;
    countyName: string;
    geometry: GeoJsonGeometry;
    bbox?: GeoBbox;
  }>,
): CountyBoundaryIndexEntry[] {
  const out: CountyBoundaryIndexEntry[] = [];
  for (const e of entries) {
    const bbox = e.bbox ?? bboxOfGeometry(e.geometry);
    if (!bbox) continue;
    out.push({
      countyFips: e.countyFips,
      countyName: e.countyName,
      geometry: e.geometry,
      bbox,
    });
  }
  return out;
}

function isPosition(v: unknown): v is [number, number] {
  return (
    Array.isArray(v) &&
    v.length >= 2 &&
    typeof v[0] === "number" &&
    typeof v[1] === "number"
  );
}

/** Representative interior point for a parcel polygon (centroid with vertex fallback). */
export function representativePoint(
  geometry: GeoJsonGeometry,
): [number, number] | null {
  const rings: [number, number][][] = [];
  function collectPolygon(poly: unknown): void {
    if (!Array.isArray(poly) || poly.length === 0) return;
    const outer = poly[0];
    if (Array.isArray(outer) && outer.length >= 3) {
      const ring: [number, number][] = [];
      for (const pt of outer) {
        if (isPosition(pt)) ring.push(pt);
      }
      if (ring.length >= 3) rings.push(ring);
    }
  }
  if (geometry.type === "Polygon") {
    collectPolygon(geometry.coordinates);
  } else if (geometry.type === "MultiPolygon" && Array.isArray(geometry.coordinates)) {
    for (const poly of geometry.coordinates) collectPolygon(poly);
  }
  if (rings.length === 0) return null;

  let best: [number, number][] | null = null;
  let bestArea = -1;
  for (const ring of rings) {
    let area = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    }
    const abs = Math.abs(area);
    if (abs > bestArea) {
      bestArea = abs;
      best = ring;
    }
  }
  if (!best || best.length === 0) return null;

  let cx = 0;
  let cy = 0;
  let signedArea = 0;
  for (let i = 0, j = best.length - 1; i < best.length; j = i++) {
    const [x0, y0] = best[j];
    const [x1, y1] = best[i];
    const cross = x0 * y1 - x1 * y0;
    signedArea += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(signedArea) > 1e-12) {
    const f = 1 / (3 * signedArea);
    const lng = cx * f;
    const lat = cy * f;
    if (pointInGeometry(lng, lat, geometry)) return [lng, lat];
  }
  return best[0] ?? null;
}

function etjUnresolved(): EtjStatus {
  return "unresolved";
}

/** Resolve city containment for a WGS84 point against an in-memory index. */
export function resolveCityContainmentAtPoint(
  longitude: number,
  latitude: number,
  index: CityBoundaryIndexEntry[],
): CityContainmentResult {
  if (index.length === 0) {
    return {
      status: "unmeasured",
      etjStatus: etjUnresolved(),
      basis:
        "tx_city_boundary index is empty; city limits are unmeasured, not unincorporated",
    };
  }
  const queryBbox: GeoBbox = {
    westLng: longitude,
    southLat: latitude,
    eastLng: longitude,
    northLat: latitude,
  };
  for (const entry of index) {
    if (!bboxesIntersect(queryBbox, entry.bbox)) continue;
    if (pointInGeometry(longitude, latitude, entry.geometry)) {
      return {
        status: "incorporated",
        cityName: entry.cityName,
        geoId: entry.geoId,
        gnis: entry.gnis,
        etjStatus: etjUnresolved(),
        basis: `point-in-polygon against tx_city_boundary geo_id=${entry.geoId}`,
      };
    }
  }
  return {
    status: "unincorporated",
    etjStatus: etjUnresolved(),
    basis:
      "no incorporated-place polygon contains the query point " +
      "(tx_city_boundary statewide index; unincorporated is the honest answer)",
  };
}

/** Resolve city containment for a parcel geometry or point. */
export function resolveCityContainment(
  query: { longitude: number; latitude: number } | GeoJsonGeometry,
  index: CityBoundaryIndexEntry[],
): CityContainmentResult {
  if ("type" in query && "coordinates" in query) {
    const pt = representativePoint(query);
    if (pt === null) {
      return {
        status: "unmeasured",
        etjStatus: etjUnresolved(),
        basis:
          "parcel geometry yielded no representative point; city limits are unmeasured",
      };
    }
    return resolveCityContainmentAtPoint(pt[0], pt[1], index);
  }
  return resolveCityContainmentAtPoint(query.longitude, query.latitude, index);
}

/** Resolve county containment for a WGS84 point. Every TX point should resolve. */
export function resolveCountyContainmentAtPoint(
  longitude: number,
  latitude: number,
  index: CountyBoundaryIndexEntry[],
): CountyContainmentResult {
  const queryBbox: GeoBbox = {
    westLng: longitude,
    southLat: latitude,
    eastLng: longitude,
    northLat: latitude,
  };
  for (const entry of index) {
    if (!bboxesIntersect(queryBbox, entry.bbox)) continue;
    if (pointInGeometry(longitude, latitude, entry.geometry)) {
      return {
        status: "resolved",
        countyFips: entry.countyFips,
        countyName: entry.countyName,
        basis: `point-in-polygon against tx_county_boundary fips=${entry.countyFips}`,
      };
    }
  }
  return {
    status: "unresolved",
    basis:
      "no county polygon contains the query point " +
      "(outside Texas or index incomplete)",
  };
}

export function resolveCountyContainment(
  query: { longitude: number; latitude: number } | GeoJsonGeometry,
  index: CountyBoundaryIndexEntry[],
): CountyContainmentResult {
  if ("type" in query && "coordinates" in query) {
    const pt = representativePoint(query);
    if (pt === null) {
      return {
        status: "unresolved",
        basis: "parcel geometry yielded no representative point",
      };
    }
    return resolveCountyContainmentAtPoint(pt[0], pt[1], index);
  }
  return resolveCountyContainmentAtPoint(query.longitude, query.latitude, index);
}
