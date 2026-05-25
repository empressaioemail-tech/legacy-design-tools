/**
 * Site-topography contour GeoJSON → SiteMap polyline overlays (Phase 2D.1.5).
 *
 * Consumes the `propertySet.contoursGeoJson` FeatureCollection emitted by
 * the site-topography ingest worker. Supports LineString and MultiLineString
 * features with WGS84 [lng, lat] coordinates.
 */

import type { SiteMapOverlay } from "./overlays";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function lineStringToLatLng(
  coordinates: unknown,
): Array<[number, number]> {
  if (!Array.isArray(coordinates)) return [];
  const out: Array<[number, number]> = [];
  for (const pair of coordinates) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const lng = pair[0];
    const lat = pair[1];
    if (!isFiniteNumber(lng) || !isFiniteNumber(lat)) continue;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
    out.push([lat, lng]);
  }
  return out;
}

const TOPO_CONTOUR_BASE = {
  sourceId: "site-topography",
  layerKind: "elevation-contour",
  provider: "USGS 3DEP",
  tier: "topography" as const,
};

/**
 * Convert a site-topography contours FeatureCollection into map polylines.
 * Malformed features are skipped; returns an empty array for non-collections.
 */
export function extractContoursGeoJsonOverlays(
  geoJson: unknown,
): SiteMapOverlay[] {
  if (!isRecord(geoJson) || geoJson.type !== "FeatureCollection") {
    return [];
  }
  const features = geoJson.features;
  if (!Array.isArray(features)) return [];

  const out: SiteMapOverlay[] = [];
  for (const feat of features) {
    if (!isRecord(feat)) continue;
    const geom = feat.geometry;
    if (!isRecord(geom)) continue;

    if (geom.type === "LineString") {
      const line = lineStringToLatLng(geom.coordinates);
      if (line.length >= 2) {
        out.push({
          kind: "polyline",
          ...TOPO_CONTOUR_BASE,
          positions: [line],
        });
      }
      continue;
    }

    if (geom.type === "MultiLineString" && Array.isArray(geom.coordinates)) {
      for (const part of geom.coordinates) {
        const line = lineStringToLatLng(part);
        if (line.length >= 2) {
          out.push({
            kind: "polyline",
            ...TOPO_CONTOUR_BASE,
            positions: [line],
          });
        }
      }
    }
  }
  return out;
}

/** True when propertySet carries a non-empty contours FeatureCollection. */
export function hasContoursGeoJson(propertySet: unknown): boolean {
  if (!isRecord(propertySet)) return false;
  const geoJson = propertySet.contoursGeoJson;
  if (!isRecord(geoJson) || geoJson.type !== "FeatureCollection") return false;
  return Array.isArray(geoJson.features) && geoJson.features.length > 0;
}
