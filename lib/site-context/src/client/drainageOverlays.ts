/**
 * Site-drainage GeoJSON → SiteMap overlays (Phase 2D.2/2D.3).
 */

import type { SiteMapOverlay } from "./overlays";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ringToLatLng(coordinates: unknown): Array<[number, number]> {
  if (!Array.isArray(coordinates)) return [];
  const out: Array<[number, number]> = [];
  for (const pair of coordinates) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const lng = pair[0];
    const lat = pair[1];
    if (typeof lng !== "number" || typeof lat !== "number") continue;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    out.push([lat, lng]);
  }
  return out;
}

const DRAINAGE_BASE = {
  sourceId: "site-drainage",
  provider: "Hydrology engine",
  tier: "hydrology" as const,
};

function polygonsFromGeoJson(
  geoJson: unknown,
  layerKind: string,
): SiteMapOverlay[] {
  if (!isRecord(geoJson) || geoJson.type !== "FeatureCollection") return [];
  const features = geoJson.features;
  if (!Array.isArray(features)) return [];
  const out: SiteMapOverlay[] = [];
  for (const feat of features) {
    if (!isRecord(feat)) continue;
    const geom = feat.geometry;
    if (!isRecord(geom)) continue;
    if (geom.type === "Polygon" && Array.isArray(geom.coordinates)) {
      const ring = ringToLatLng((geom.coordinates as unknown[])[0]);
      if (ring.length >= 3) {
        out.push({
          kind: "polygon",
          ...DRAINAGE_BASE,
          layerKind,
          positions: [ring],
        });
      }
    }
    if (geom.type === "MultiPolygon" && Array.isArray(geom.coordinates)) {
      for (const poly of geom.coordinates) {
        const ring = ringToLatLng((poly as unknown[])[0]);
        if (ring.length >= 3) {
          out.push({
            kind: "polygon",
            ...DRAINAGE_BASE,
            layerKind,
            positions: [ring],
          });
        }
      }
    }
    if (geom.type === "LineString") {
      const line = ringToLatLng(geom.coordinates);
      if (line.length >= 2) {
        out.push({
          kind: "polyline",
          ...DRAINAGE_BASE,
          layerKind,
          positions: [line],
        });
      }
    }
  }
  return out;
}

export function extractDrainageGeoJsonOverlays(propertySet: unknown): SiteMapOverlay[] {
  if (!isRecord(propertySet)) return [];
  const zones = polygonsFromGeoJson(
    propertySet.drainageZonesGeoJson,
    "drainage-zone",
  );
  const lines = polygonsFromGeoJson(propertySet.flowLinesGeoJson, "flow-line");
  const rainfall = polygonsFromGeoJson(
    propertySet.rainfallResultGeoJson,
    "rainfall-simulation",
  );
  return [...zones, ...lines, ...rainfall];
}

export function hasDrainageGeoJson(propertySet: unknown): boolean {
  if (!isRecord(propertySet)) return false;
  for (const key of [
    "drainageZonesGeoJson",
    "flowLinesGeoJson",
    "rainfallResultGeoJson",
  ]) {
    const geo = propertySet[key];
    if (isRecord(geo) && geo.type === "FeatureCollection") {
      if (Array.isArray(geo.features) && geo.features.length > 0) return true;
    }
  }
  return false;
}
