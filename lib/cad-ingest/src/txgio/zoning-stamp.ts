/**
 * Point-in-polygon zoning stamp for self-hosted TxGIO parcels (F11).
 *
 * Pure logic (no db, no network): given a set of zoning polygons (each
 * carrying its district code) and a parcel geometry, find the district
 * whose polygon contains a representative interior point of the parcel.
 * The CLI (`zoning-cli.ts`) fetches the zoning layer + reads parcels and
 * writes the matched code to `txgio_parcel.zoning_district`; the api-server
 * then surfaces it as `feature.properties.zoningCode` (txgioParcelStore
 * `toFeature()`), which the buildable-envelope route maps to the setback
 * district. Reuses the SAME dependency-free geometry math the store reads
 * use (`geo.ts`): a bbox pre-filter (only test polygons whose bbox holds
 * the point) plus the even-odd ray-cast `pointInGeometry`. No PostGIS, no
 * turf — mirrors the store's own design note.
 *
 * Representative point: the shoelace area-centroid of the parcel's largest
 * ring. For the small, mostly-convex residential/commercial lots in the
 * StratMap parcel fabric the centroid is an interior point, so it lands in
 * the parcel's own zoning polygon. On the rare parcel whose centroid falls
 * outside its ring (deeply concave / multipart), the stamp falls back to
 * the ring's first vertex — still a point ON the parcel, still honest. A
 * parcel whose representative point falls in NO zoning polygon (outside the
 * city, or an un-zoned pocket) is left unstamped (null) — the honest
 * conservative-fallback path, never a guessed district.
 */

import {
  bboxOfGeometry,
  bboxesIntersect,
  pointInGeometry,
  type GeoBbox,
  type GeoJsonGeometry,
} from "./geo";

/** One zoning polygon plus its raw district code, ready for indexed PIP. */
export interface ZoningPolygon {
  /** Raw district code (Georgetown `ZONE`, e.g. "RS") — stamped verbatim. */
  code: string;
  /** Human description (Georgetown `FULLZONE`) — provenance/logging only. */
  description?: string | null;
  geometry: GeoJsonGeometry;
  bbox: GeoBbox;
}

/**
 * Build the in-memory zoning index once per stamp run. Drops any feature
 * with no usable code or no bounded geometry (so a malformed zoning row can
 * never stamp a bad code). Returns the polygons in input order; a bbox
 * pre-filter at lookup time keeps PIP to the handful of polygons whose bbox
 * holds the query point.
 */
export function buildZoningIndex(
  features: Array<{ code: string | null | undefined; description?: string | null; geometry: GeoJsonGeometry | null | undefined }>,
): ZoningPolygon[] {
  const out: ZoningPolygon[] = [];
  for (const f of features) {
    const code = typeof f.code === "string" ? f.code.trim() : "";
    if (!code) continue;
    if (!f.geometry) continue;
    const bbox = bboxOfGeometry(f.geometry);
    if (!bbox) continue;
    out.push({ code, description: f.description ?? null, geometry: f.geometry, bbox });
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

/** Largest-|area| linear ring of a Polygon/MultiPolygon (the outer boundary). */
function largestRing(geometry: GeoJsonGeometry): [number, number][] | null {
  const rings: [number, number][][] = [];
  function collectPolygon(poly: unknown): void {
    if (!Array.isArray(poly)) return;
    for (const ring of poly) {
      if (!Array.isArray(ring)) continue;
      const positions = ring.filter(isPosition) as [number, number][];
      if (positions.length >= 3) rings.push(positions);
    }
  }
  if (geometry.type === "Polygon") {
    collectPolygon(geometry.coordinates);
  } else if (geometry.type === "MultiPolygon") {
    if (Array.isArray(geometry.coordinates)) {
      for (const poly of geometry.coordinates) collectPolygon(poly);
    }
  } else {
    return null;
  }
  let best: [number, number][] | null = null;
  let bestArea = -1;
  for (const r of rings) {
    let a = 0;
    for (let i = 0; i < r.length; i++) {
      const [x0, y0] = r[i]!;
      const [x1, y1] = r[(i + 1) % r.length]!;
      a += x0 * y1 - x1 * y0;
    }
    const area = Math.abs(a);
    if (area > bestArea) {
      bestArea = area;
      best = r;
    }
  }
  return best;
}

/**
 * Representative interior point of a parcel geometry: the shoelace
 * area-centroid of its largest ring, with a first-vertex fallback for a
 * degenerate ring. Returns null when the geometry has no usable ring.
 */
export function representativePoint(
  geometry: GeoJsonGeometry,
): { longitude: number; latitude: number } | null {
  const ring = largestRing(geometry);
  if (!ring || ring.length < 3) return null;
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i]!;
    const [x1, y1] = ring[(i + 1) % ring.length]!;
    const cross = x0 * y1 - x1 * y0;
    a += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-15) {
    // Degenerate (collinear) ring — fall back to the first vertex.
    const [x, y] = ring[0]!;
    return { longitude: x, latitude: y };
  }
  return { longitude: cx / (6 * a), latitude: cy / (6 * a) };
}

/**
 * The zoning district code whose polygon contains the point, or null when
 * the point is in no zoning polygon. Bbox pre-filter then even-odd ray-cast
 * (`pointInGeometry`). First containing polygon wins (zoning layers do not
 * overlap; on the rare shared boundary the first is as correct as any).
 */
export function zoningCodeAtPoint(
  index: ZoningPolygon[],
  longitude: number,
  latitude: number,
): { code: string; description?: string | null } | null {
  const pointBbox: GeoBbox = {
    westLng: longitude,
    southLat: latitude,
    eastLng: longitude,
    northLat: latitude,
  };
  for (const poly of index) {
    if (!bboxesIntersect(poly.bbox, pointBbox)) continue;
    if (pointInGeometry(longitude, latitude, poly.geometry)) {
      return { code: poly.code, description: poly.description };
    }
  }
  return null;
}

/**
 * Stamp one parcel: compute its representative point, PIP the zoning index.
 * On a centroid miss (centroid outside its own ring), retry with the ring's
 * first vertex before giving up. Returns the matched code (+ description) or
 * null (leave the parcel unstamped).
 */
export function stampParcelZoning(
  index: ZoningPolygon[],
  parcelGeometry: GeoJsonGeometry,
): { code: string; description?: string | null } | null {
  const centroid = representativePoint(parcelGeometry);
  if (!centroid) return null;
  const hit = zoningCodeAtPoint(index, centroid.longitude, centroid.latitude);
  if (hit) return hit;
  // Centroid landed outside every zoning polygon — retry from a vertex ON
  // the parcel boundary (handles a concave parcel whose centroid sits in a
  // notch outside the parcel, so outside its zoning polygon too).
  const ring = largestRing(parcelGeometry);
  if (ring && ring.length > 0) {
    const [vx, vy] = ring[0]!;
    return zoningCodeAtPoint(index, vx, vy);
  }
  return null;
}
