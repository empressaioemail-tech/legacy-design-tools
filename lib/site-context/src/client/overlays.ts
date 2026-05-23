/**
 * Briefing-source → SiteMap overlay extraction.
 *
 * Recognized payload shapes (catalogued from `lib/adapters/src/**`):
 *   - `payload.parcel.geometry`, `payload.zoning.geometry` — ArcGIS
 *     polygon rings.
 *   - `payload.features[].geometry` — ArcGIS features carrying polygon
 *     `rings` (e.g. `ugrc:dem` elevation bands) or polyline `paths`
 *     (e.g. county-GIS roads).
 *   - `payload.elements[].geometry` — OpenStreetMap Overpass ways
 *     (`{lat, lon}` vertex arrays — the `grand-county-ut:roads` OSM
 *     fallback).
 *   - `payload.location.{x, y}` — WGS84 point (e.g. USGS NED).
 *
 * Coordinates are wkid 4326 or 102100/3857 (the latter unprojected to
 * WGS84). Anything malformed, missing, or of an unknown shape is
 * skipped so the map falls back to the parcel pin instead of throwing.
 */

// Local structural type so site-context does not depend on
// api-client-react. The real `EngagementBriefingSource` assigns to
// this without a cast.
export interface BriefingSourceForOverlays {
  id: string;
  layerKind: string;
  sourceKind:
    | "federal-adapter"
    | "state-adapter"
    | "local-adapter"
    | "manual-upload"
    | (string & {});
  provider: string | null;
  payload: { [key: string]: unknown } | unknown;
  supersededAt: Date | string | null;
}

export type SiteMapOverlayTier = "federal" | "state" | "local" | "manual";

export type SiteMapOverlay =
  | {
      kind: "polygon";
      sourceId: string;
      layerKind: string;
      provider: string | null;
      tier: SiteMapOverlayTier;
      positions: Array<Array<[number, number]>>;
    }
  | {
      kind: "polyline";
      sourceId: string;
      layerKind: string;
      provider: string | null;
      tier: SiteMapOverlayTier;
      positions: Array<Array<[number, number]>>;
    }
  | {
      kind: "point";
      sourceId: string;
      layerKind: string;
      provider: string | null;
      tier: SiteMapOverlayTier;
      position: [number, number];
    };

function tierForSource(
  kind: BriefingSourceForOverlays["sourceKind"],
): SiteMapOverlayTier {
  if (kind === "federal-adapter") return "federal";
  if (kind === "state-adapter") return "state";
  if (kind === "local-adapter") return "local";
  // Cortex prop-intel SCOPE B (2026-05-23) — `national-aggregator` is
  // the source kind written by the Regrid baseline adapter. UI-side
  // we render it in the same "federal"-style pill as the other
  // nationwide-scope sources (USGS / FEMA / FCC / EPA), since a real
  // `"national"` overlay tier would require a cross-cutting TIER_*
  // map update in SiteMap.tsx — deferred until UX flags it.
  if (kind === "national-aggregator") return "federal";
  return "manual";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function webMercatorToLatLng(x: number, y: number): [number, number] {
  const R = 6378137;
  const lng = (x / R) * (180 / Math.PI);
  const lat = (Math.atan(Math.exp(y / R)) * 360) / Math.PI - 90;
  return [lat, lng];
}

function projectRingPoint(
  pair: unknown,
  wkid: number,
): [number, number] | null {
  if (!Array.isArray(pair) || pair.length < 2) return null;
  const x = pair[0];
  const y = pair[1];
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
  if (wkid === 102100 || wkid === 3857) {
    const [lat, lng] = webMercatorToLatLng(x, y);
    if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return [lat, lng];
  }
  // WGS84 (wkid 4326) — ArcGIS rings are `[lng, lat]`.
  if (y < -90 || y > 90 || x < -180 || x > 180) return null;
  return [y, x];
}

function resolveWkid(geometry: Record<string, unknown>): number {
  const sr = geometry.spatialReference;
  if (isRecord(sr) && isFiniteNumber(sr.wkid)) return sr.wkid;
  if (isRecord(sr) && isFiniteNumber(sr.latestWkid)) return sr.latestWkid;
  return 4326;
}

/**
 * Extract WGS84 line-strings from an ArcGIS geometry's `rings` (polygon)
 * or `paths` (polyline) member. `minPoints` is 3 for a polygon ring,
 * 2 for a polyline path.
 */
function extractArcGisLineStrings(
  geometry: unknown,
  key: "rings" | "paths",
  minPoints: number,
): Array<Array<[number, number]>> {
  if (!isRecord(geometry)) return [];
  const lineStrings = geometry[key];
  if (!Array.isArray(lineStrings)) return [];
  const wkid = resolveWkid(geometry);
  const out: Array<Array<[number, number]>> = [];
  for (const lineString of lineStrings) {
    if (!Array.isArray(lineString)) continue;
    const projected: Array<[number, number]> = [];
    for (const pair of lineString) {
      const point = projectRingPoint(pair, wkid);
      if (point) projected.push(point);
    }
    if (projected.length >= minPoints) out.push(projected);
  }
  return out;
}

function extractRingsFromArcGisGeometry(
  geometry: unknown,
): Array<Array<[number, number]>> {
  return extractArcGisLineStrings(geometry, "rings", 3);
}

function extractPathsFromArcGisGeometry(
  geometry: unknown,
): Array<Array<[number, number]>> {
  return extractArcGisLineStrings(geometry, "paths", 2);
}

/**
 * Project a single GeoJSON coordinate pair `[lng, lat]` (WGS84 — the
 * only CRS GeoJSON permits per RFC 7946) into the Leaflet
 * `[lat, lng]` order. Returns null on out-of-range or malformed
 * coordinates so a single bad vertex skips rather than rejecting
 * the whole polygon.
 */
function projectGeoJsonPoint(pair: unknown): [number, number] | null {
  if (!Array.isArray(pair) || pair.length < 2) return null;
  const lng = pair[0];
  const lat = pair[1];
  if (!isFiniteNumber(lng) || !isFiniteNumber(lat)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return [lat, lng];
}

/**
 * Extract Leaflet-shaped polygon rings (`Array<Array<[lat, lng]>>`)
 * from a GeoJSON `Polygon` or `MultiPolygon` geometry. Cortex
 * prop-intel SCOPE B (2026-05-23) adds this because the Regrid
 * national parcel + zoning baseline returns GeoJSON Polygon /
 * MultiPolygon on every `/parcels/point` response — the existing
 * ArcGIS-rings path only covers the per-jurisdiction county-GIS
 * adapters. Future federal/national adapters are likely to follow
 * Regrid's lead so this branch covers them too.
 *
 * `Polygon` coordinates: `[ ring, ring, ... ]` where each ring is
 * `[ [lng,lat], [lng,lat], ... ]`. First ring is the outer
 * boundary; subsequent rings are holes — Leaflet handles them by
 * convention if we pass the array as-is, so we just project every
 * ring.
 *
 * `MultiPolygon` coordinates: `[ polygon, polygon, ... ]` where
 * each polygon is `[ ring, ring, ... ]`. Each polygon's rings get
 * flattened into the output (Leaflet renders multiple polygons by
 * passing multiple ring arrays alongside each other).
 *
 * `minPoints` is 3 for a polygon ring (a triangle is the minimum
 * valid polygon).
 */
function extractRingsFromGeoJsonGeometry(
  geometry: unknown,
): Array<Array<[number, number]>> {
  if (!isRecord(geometry)) return [];
  const type = geometry.type;
  const coordinates = geometry.coordinates;
  if (!Array.isArray(coordinates)) return [];
  const out: Array<Array<[number, number]>> = [];
  if (type === "Polygon") {
    for (const ring of coordinates) {
      if (!Array.isArray(ring)) continue;
      const projected: Array<[number, number]> = [];
      for (const pair of ring) {
        const point = projectGeoJsonPoint(pair);
        if (point) projected.push(point);
      }
      if (projected.length >= 3) out.push(projected);
    }
    return out;
  }
  if (type === "MultiPolygon") {
    for (const polygon of coordinates) {
      if (!Array.isArray(polygon)) continue;
      for (const ring of polygon) {
        if (!Array.isArray(ring)) continue;
        const projected: Array<[number, number]> = [];
        for (const pair of ring) {
          const point = projectGeoJsonPoint(pair);
          if (point) projected.push(point);
        }
        if (projected.length >= 3) out.push(projected);
      }
    }
    return out;
  }
  return [];
}

/**
 * Detect whether a `payload.parcel` / `payload.zoning` value is a
 * GeoJSON Feature wrapper (`{ type: "Feature", geometry: {...} }`) and
 * return its geometry, or null if the value is some other shape (e.g.
 * an ArcGIS feature with `attributes` + `geometry.rings`).
 *
 * Regrid emits `payload.parcel` as a full GeoJSON Feature; the
 * county-GIS adapters emit `payload.parcel = ArcGisFeature` with
 * `{ attributes, geometry: { rings } }`. The two shapes coexist on
 * the wire after Cortex prop-intel SCOPE B.
 */
function geoJsonGeometryFromFeature(value: unknown): unknown | null {
  if (!isRecord(value)) return null;
  if (value.type !== "Feature") return null;
  return value.geometry ?? null;
}

/**
 * Extract WGS84 polylines from an OpenStreetMap Overpass `elements`
 * array. `out body geom` ways carry an inline `geometry` array of
 * `{lat, lon}` vertices.
 */
function extractPolylinesFromOsmElements(
  elements: unknown,
): Array<Array<[number, number]>> {
  if (!Array.isArray(elements)) return [];
  const out: Array<Array<[number, number]>> = [];
  for (const el of elements) {
    if (!isRecord(el)) continue;
    const geom = el.geometry;
    if (!Array.isArray(geom)) continue;
    const line: Array<[number, number]> = [];
    for (const pt of geom) {
      if (!isRecord(pt)) continue;
      const lat = pt.lat;
      const lon = pt.lon;
      if (
        isFiniteNumber(lat) &&
        isFiniteNumber(lon) &&
        lat >= -90 &&
        lat <= 90 &&
        lon >= -180 &&
        lon <= 180
      ) {
        line.push([lat, lon]);
      }
    }
    if (line.length >= 2) out.push(line);
  }
  return out;
}

function overlaysFromSource(
  source: BriefingSourceForOverlays,
): SiteMapOverlay[] {
  const payload = source.payload as unknown;
  if (!isRecord(payload)) return [];
  const tier = tierForSource(source.sourceKind);
  const base = {
    sourceId: source.id,
    layerKind: source.layerKind,
    provider: source.provider,
    tier,
  } as const;
  const out: SiteMapOverlay[] = [];

  if (isRecord(payload.parcel)) {
    const parcel = payload.parcel as Record<string, unknown>;
    // Cortex prop-intel SCOPE B (2026-05-23) — Regrid emits parcel
    // as a full GeoJSON Feature wrapper; the county-GIS adapters
    // emit parcel as an ArcGIS feature with `{ attributes,
    // geometry: { rings } }`. Try the GeoJSON branch first (the
    // wrapper is unambiguous via `type: "Feature"`); fall back to
    // the ArcGIS-rings extractor.
    const geoJsonGeometry = geoJsonGeometryFromFeature(parcel);
    let rings: Array<Array<[number, number]>> = [];
    if (geoJsonGeometry) {
      rings = extractRingsFromGeoJsonGeometry(geoJsonGeometry);
    }
    if (rings.length === 0) {
      rings = extractRingsFromArcGisGeometry(parcel.geometry);
    }
    if (rings.length > 0) {
      out.push({ kind: "polygon", ...base, positions: rings });
    }
  }

  if (isRecord(payload.zoning)) {
    const zoning = payload.zoning as Record<string, unknown>;
    // Same dual-shape handling as `payload.parcel` above — Regrid's
    // zoning is a GeoJSON Feature; county-GIS zoning is ArcGIS.
    const geoJsonGeometry = geoJsonGeometryFromFeature(zoning);
    let rings: Array<Array<[number, number]>> = [];
    if (geoJsonGeometry) {
      rings = extractRingsFromGeoJsonGeometry(geoJsonGeometry);
    }
    if (rings.length === 0) {
      rings = extractRingsFromArcGisGeometry(zoning.geometry);
    }
    if (rings.length > 0) {
      out.push({ kind: "polygon", ...base, positions: rings });
    }
  }

  // ArcGIS feature arrays — `ugrc:dem` bands carry polygon `rings`;
  // county-GIS roads carry polyline `paths`. A feature may carry
  // either; emit whichever it has.
  if (Array.isArray(payload.features)) {
    for (const feat of payload.features) {
      if (!isRecord(feat)) continue;
      const rings = extractRingsFromArcGisGeometry(feat.geometry);
      if (rings.length > 0) {
        out.push({ kind: "polygon", ...base, positions: rings });
      }
      const paths = extractPathsFromArcGisGeometry(feat.geometry);
      if (paths.length > 0) {
        out.push({ kind: "polyline", ...base, positions: paths });
      }
    }
  }

  // OpenStreetMap Overpass ways — the `grand-county-ut:roads` OSM
  // fallback. All ways collapse into one polyline overlay.
  if (Array.isArray(payload.elements)) {
    const lines = extractPolylinesFromOsmElements(payload.elements);
    if (lines.length > 0) {
      out.push({ kind: "polyline", ...base, positions: lines });
    }
  }

  if (isRecord(payload.location)) {
    const loc = payload.location as Record<string, unknown>;
    const x = loc.x;
    const y = loc.y;
    if (
      isFiniteNumber(x) &&
      isFiniteNumber(y) &&
      y >= -90 &&
      y <= 90 &&
      x >= -180 &&
      x <= 180
    ) {
      out.push({ kind: "point", ...base, position: [y, x] });
    }
  }

  return out;
}

export function extractBriefingSourceOverlays(
  sources: ReadonlyArray<BriefingSourceForOverlays>,
): SiteMapOverlay[] {
  const out: SiteMapOverlay[] = [];
  for (const source of sources) {
    if (source.supersededAt) continue;
    out.push(...overlaysFromSource(source));
  }
  return out;
}
