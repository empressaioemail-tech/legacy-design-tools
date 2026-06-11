/**
 * Pure geometry helpers for site-topography parcel extraction — no DB
 * imports so unit tests can run without a Postgres fixture.
 */

import type { BboxWgs84 } from "@workspace/site-context/server";
import { logger as defaultLogger } from "./logger";

/** GeoJSON-ish geometry shapes the resolver accepts. */
export interface GeoJsonGeometry {
  type: "Polygon" | "MultiPolygon" | string;
  coordinates: unknown;
}

/** Semi-major axis × π — Web Mercator forward/inverse constant (EPSG:3857). */
const WEB_MERCATOR_SCALE = 20037508.34;

const WEB_MERCATOR_WKIDS = new Set([3857, 102100, 900913]);

function isWebMercatorWkid(wkid: number): boolean {
  return WEB_MERCATOR_WKIDS.has(wkid);
}

function resolveArcGisWkid(spatialReference: unknown): number {
  if (!spatialReference || typeof spatialReference !== "object") return 4326;
  const sr = spatialReference as { wkid?: unknown; latestWkid?: unknown };
  if (typeof sr.wkid === "number" && Number.isFinite(sr.wkid)) return sr.wkid;
  if (typeof sr.latestWkid === "number" && Number.isFinite(sr.latestWkid)) {
    return sr.latestWkid;
  }
  return 4326;
}

/**
 * Inverse spherical Mercator — Web Mercator meters → WGS84 degrees.
 * Used when ArcGIS rings arrive in EPSG:3857 / 102100 / 900913.
 */
export function webMercatorToWgs84(x: number, y: number): [number, number] {
  const lng = (x / WEB_MERCATOR_SCALE) * 180;
  const lat =
    (Math.atan(Math.exp((y / WEB_MERCATOR_SCALE) * Math.PI)) * 360) / Math.PI -
    90;
  return [lng, lat];
}

function reprojectArcGisRingPoint(
  pair: unknown,
  wkid: number,
): [number, number] | null {
  if (!Array.isArray(pair) || pair.length < 2) return null;
  const x = pair[0];
  const y = pair[1];
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  ) {
    return null;
  }
  if (isWebMercatorWkid(wkid)) {
    const [lng, lat] = webMercatorToWgs84(x, y);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    return [lng, lat];
  }
  // WGS84 — ArcGIS rings are [lng, lat].
  return [x, y];
}

function reprojectArcGisRingsToGeoJsonCoordinates(
  rings: unknown[],
  wkid: number,
): number[][][] | null {
  const out: number[][][] = [];
  for (const ring of rings) {
    if (!Array.isArray(ring)) return null;
    const projected: number[][] = [];
    for (const pt of ring) {
      const lngLat = reprojectArcGisRingPoint(pt, wkid);
      if (!lngLat) return null;
      projected.push(lngLat);
    }
    out.push(projected);
  }
  return out.length > 0 ? out : null;
}

/**
 * Recursively walk a GeoJSON coordinate tree and accumulate the WGS84
 * lng/lat extrema. Returns null when coordinates fall outside WGS84
 * degree range (defense in depth against un-reprojected projected coords).
 */
export function geometryToBboxWgs84(
  geometry: GeoJsonGeometry,
): BboxWgs84 | null {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  function visit(coords: unknown): void {
    if (Array.isArray(coords) && coords.length >= 2 && typeof coords[0] === "number") {
      const lng = coords[0] as number;
      const lat = coords[1] as number;
      if (Number.isFinite(lng) && Number.isFinite(lat)) {
        if (lng < west) west = lng;
        if (lng > east) east = lng;
        if (lat < south) south = lat;
        if (lat > north) north = lat;
      }
      return;
    }
    if (Array.isArray(coords)) {
      for (const c of coords) visit(c);
    }
  }
  visit(geometry.coordinates);
  if (!Number.isFinite(west) || !Number.isFinite(south)) return null;
  if (
    Math.abs(west) > 180 ||
    Math.abs(east) > 180 ||
    Math.abs(south) > 90 ||
    Math.abs(north) > 90
  ) {
    defaultLogger.warn(
      {
        westLng: west,
        eastLng: east,
        southLat: south,
        northLat: north,
      },
      "geometryToBboxWgs84: coordinates outside WGS84 range — skipping",
    );
    return null;
  }
  return { westLng: west, southLat: south, eastLng: east, northLat: north };
}

/**
 * Inspect a `briefing_sources.payload` for parcel geometry. ArcGIS rings
 * in Web Mercator are reprojected to WGS84 GeoJSON coordinates.
 */
export function extractParcelGeometryFromPayload(
  payload: unknown,
): GeoJsonGeometry | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { parcel?: unknown };
  if (!p.parcel || typeof p.parcel !== "object") return null;
  const parcel = p.parcel as {
    type?: unknown;
    geometry?: unknown;
  };
  if (parcel.type === "Feature" && parcel.geometry && typeof parcel.geometry === "object") {
    const g = parcel.geometry as GeoJsonGeometry;
    if (
      (g.type === "Polygon" || g.type === "MultiPolygon") &&
      Array.isArray(g.coordinates)
    ) {
      return g;
    }
  }
  if (parcel.geometry && typeof parcel.geometry === "object") {
    const g = parcel.geometry as {
      rings?: unknown;
      spatialReference?: unknown;
    };
    if (Array.isArray(g.rings) && g.rings.length > 0) {
      const wkid = resolveArcGisWkid(g.spatialReference);
      const coordinates = reprojectArcGisRingsToGeoJsonCoordinates(
        g.rings,
        wkid,
      );
      if (!coordinates) return null;
      return {
        type: "Polygon",
        coordinates,
      };
    }
  }
  return null;
}
