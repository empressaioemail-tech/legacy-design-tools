/**
 * Pure geometry helpers for the self-hosted TxGIO parcel store —
 * shared by the txgio-ingest CLI (tile bucketing at write time) and
 * the api-server readers (bbox tile fetch + point-in-polygon lookup,
 * `artifacts/api-server/src/lib/txgioParcelStore.ts`).
 *
 * The grid math intentionally mirrors the #242 `tileKey()` helper in
 * `brokerageGisCache.ts` (0.02-degree cells, `Math.floor` snap, five
 * fixed decimals so keys are byte-stable across float drift). Rows in
 * `txgio_parcel` are keyed by single-CELL keys (`g0.02:<w>,<s>`)
 * rather than #242's four-corner bbox keys, because the store buckets
 * individual parcels into every cell their bbox intersects — reads
 * are then pk-prefix equality scans over the covering cells.
 *
 * No PostGIS, no turf: parcel polygons are small and the two reads we
 * need (bbox intersection + point containment) are a few dozen lines
 * of dependency-free math. Point containment is an even-odd ray cast
 * over every ring, which handles holes for free (a point inside a
 * hole crosses both the outer ring and the hole ring — even count,
 * outside).
 */

/** Grid size in degrees — matches #242's DEFAULT_TILE_GRID_DEG (~2.2 km). */
export const TXGIO_TILE_GRID_DEG = 0.02;

export interface GeoBbox {
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
}

/**
 * GeoJSON position-array geometry as the shapefile parser emits it.
 * Only Polygon and MultiPolygon appear in the TxGIO land-parcel
 * layers; the helpers below walk coordinates generically so a stray
 * other type degrades to "no match" rather than a throw.
 */
export interface GeoJsonGeometry {
  type: string;
  coordinates: unknown;
}

/** Single-cell key for the cell whose lower-left corner is (w, s). */
function cellKeyFromIndices(
  wIdx: number,
  sIdx: number,
  gridDeg: number,
): string {
  const w = (wIdx * gridDeg).toFixed(5);
  const s = (sIdx * gridDeg).toFixed(5);
  return `g${gridDeg}:${w},${s}`;
}

/** Cell key containing a WGS84 point. */
export function cellKeyForPoint(
  longitude: number,
  latitude: number,
  gridDeg: number = TXGIO_TILE_GRID_DEG,
): string {
  return cellKeyFromIndices(
    Math.floor(longitude / gridDeg),
    Math.floor(latitude / gridDeg),
    gridDeg,
  );
}

/**
 * Every cell key a bbox intersects, iterated by integer cell index so
 * repeated `+= gridDeg` float drift can never skip or duplicate a
 * cell. `maxCells` caps the result (returns `null` when the bbox
 * would cover more) so a zoomed-out viewport can fall back to a
 * bbox-column scan instead of an enormous IN list.
 */
export function cellKeysForBbox(
  bbox: GeoBbox,
  gridDeg: number = TXGIO_TILE_GRID_DEG,
  maxCells?: number,
): string[] | null {
  const wIdx = Math.floor(bbox.westLng / gridDeg);
  const eIdx = Math.floor(bbox.eastLng / gridDeg);
  const sIdx = Math.floor(bbox.southLat / gridDeg);
  const nIdx = Math.floor(bbox.northLat / gridDeg);
  const count = (eIdx - wIdx + 1) * (nIdx - sIdx + 1);
  if (count <= 0) return [];
  if (maxCells !== undefined && count > maxCells) return null;
  const keys: string[] = [];
  for (let x = wIdx; x <= eIdx; x++) {
    for (let y = sIdx; y <= nIdx; y++) {
      keys.push(cellKeyFromIndices(x, y, gridDeg));
    }
  }
  return keys;
}

function isPosition(v: unknown): v is [number, number] {
  return (
    Array.isArray(v) &&
    v.length >= 2 &&
    typeof v[0] === "number" &&
    typeof v[1] === "number"
  );
}

/**
 * Bbox of a GeoJSON geometry by walking the coordinate nesting
 * generically. Returns null when the geometry holds no finite
 * positions (empty or malformed).
 */
export function bboxOfGeometry(geometry: GeoJsonGeometry): GeoBbox | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  let found = false;

  function walk(node: unknown): void {
    if (isPosition(node)) {
      const [lng, lat] = node;
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
      found = true;
      if (lng < west) west = lng;
      if (lng > east) east = lng;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
    }
  }

  walk(geometry?.coordinates);
  if (!found) return null;
  return { westLng: west, southLat: south, eastLng: east, northLat: north };
}

export function bboxesIntersect(a: GeoBbox, b: GeoBbox): boolean {
  return (
    a.westLng <= b.eastLng &&
    a.eastLng >= b.westLng &&
    a.southLat <= b.northLat &&
    a.northLat >= b.southLat
  );
}

/**
 * Even-odd ray cast over one ring. Counts crossings of a horizontal
 * ray extending east from the point.
 */
function ringCrossings(
  ring: unknown[],
  longitude: number,
  latitude: number,
): number {
  let crossings = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!isPosition(a) || !isPosition(b)) continue;
    const [ax, ay] = a;
    const [bx, by] = b;
    // Edge straddles the ray's latitude (half-open so a vertex hit is
    // counted exactly once) and the intersection is east of the point.
    if (ay > latitude !== by > latitude) {
      const t = (latitude - ay) / (by - ay);
      const xCross = ax + t * (bx - ax);
      if (xCross > longitude) crossings++;
    }
  }
  return crossings;
}

function pointInPolygonRings(
  rings: unknown,
  longitude: number,
  latitude: number,
): boolean {
  if (!Array.isArray(rings)) return false;
  let crossings = 0;
  for (const ring of rings) {
    if (Array.isArray(ring)) {
      crossings += ringCrossings(ring, longitude, latitude);
    }
  }
  // Even-odd across outer ring + holes: odd = inside the polygon and
  // not inside a hole.
  return crossings % 2 === 1;
}

/**
 * Point containment for GeoJSON Polygon / MultiPolygon (even-odd
 * rule, holes handled). Any other geometry type returns false.
 */
export function pointInGeometry(
  longitude: number,
  latitude: number,
  geometry: GeoJsonGeometry,
): boolean {
  if (!geometry || typeof geometry !== "object") return false;
  if (geometry.type === "Polygon") {
    return pointInPolygonRings(geometry.coordinates, longitude, latitude);
  }
  if (geometry.type === "MultiPolygon") {
    if (!Array.isArray(geometry.coordinates)) return false;
    return geometry.coordinates.some((polygon) =>
      pointInPolygonRings(polygon, longitude, latitude),
    );
  }
  return false;
}
