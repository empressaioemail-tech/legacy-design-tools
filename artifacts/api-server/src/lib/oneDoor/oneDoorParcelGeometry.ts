/**
 * ONE DOOR placement from the reader (`_design/2026-10-15_burnet_publish_without_bake.md`
 * items 3 and 4).
 *
 * The reader serves `facts.parcelGeometry` as
 *
 *   { state: "value", value: { geometry: <GeoJSON Polygon | MultiPolygon, EPSG:4326>,
 *                              placementPoint: { lng, lat }, partCount, areaSqM }, ... }
 *
 * for a county whose geometry rail is slated (Burnet 48053 first). In `on`
 * mode that is the parcel's map position and its outline. The bake coordinate
 * and the boundary-edge atoms are only a FALLBACK, used when the reader has no
 * geometry value for the parcel.
 *
 * Fail closed. A value that does not parse as a finite Texas-plausible point,
 * or a ring with fewer than three distinct vertices, is treated as "no reader
 * geometry" and the caller falls back. No point is invented: no polygon
 * centroid is computed here when the reader sent no `placementPoint`.
 */

import type { OneDoorRecord } from "./oneDoorReaderClient";
import { envelopeRingToLocalFeet, type DrawFrameAnchor } from "../parcelDrawStub";

/** The reader's geometry rail key. */
export const ONE_DOOR_PARCEL_GEOMETRY_RAIL = "parcelGeometry";

/** Where a one-door placement came from. Placement only; never a fact. */
export type OneDoorPlacementSource = "reader-parcel-geometry" | "bake-latlng-index";

export type LngLat = [number, number];

export type OneDoorParcelGeometry = {
  /** Outer rings of every part (holes are not drawn), WGS84 [lng, lat]. */
  partsOuterRings: LngLat[][];
  placementPoint: { longitude: number; latitude: number };
  partCount: number | null;
  areaSqM: number | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Generous Texas envelope. A coordinate outside it (or a 0 sentinel) is not
 * a placement this consumer can trust, e.g. a projected-metre value.
 */
function plausibleLngLat(lng: number, lat: number): boolean {
  return lng !== 0 && lat !== 0 && lng >= -107.5 && lng <= -93 && lat >= 25.5 && lat <= 37;
}

function parsePosition(value: unknown): LngLat | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const lng = finite(value[0]);
  const lat = finite(value[1]);
  if (lng === null || lat === null || !plausibleLngLat(lng, lat)) return null;
  return [lng, lat];
}

function parseRing(value: unknown): LngLat[] | null {
  if (!Array.isArray(value)) return null;
  const ring: LngLat[] = [];
  for (const raw of value) {
    const pos = parsePosition(raw);
    if (!pos) return null;
    ring.push(pos);
  }
  const distinct = new Set(ring.map(([x, y]) => `${x},${y}`));
  return distinct.size >= 3 ? ring : null;
}

/** Outer ring of each polygon part, or null when the geometry is not a usable Polygon/MultiPolygon. */
function outerRings(geometry: unknown): LngLat[][] | null {
  const geom = asRecord(geometry);
  if (!geom) return null;
  const polygons: unknown[] =
    geom.type === "Polygon"
      ? [geom.coordinates]
      : geom.type === "MultiPolygon" && Array.isArray(geom.coordinates)
        ? geom.coordinates
        : [];
  const out: LngLat[][] = [];
  for (const poly of polygons) {
    if (!Array.isArray(poly) || poly.length === 0) return null;
    const ring = parseRing(poly[0]);
    if (!ring) return null;
    out.push(ring);
  }
  return out.length ? out : null;
}

/**
 * The reader's parcel geometry for this record, or null when the reader has no
 * usable geometry value (absent rail, any non-`value` state, or a malformed
 * value). Null means "fall back"; it is never turned into a fabricated shape.
 */
export function oneDoorParcelGeometry(record: OneDoorRecord | null | undefined): OneDoorParcelGeometry | null {
  const fact = record?.facts[ONE_DOOR_PARCEL_GEOMETRY_RAIL];
  if (!fact || fact.state !== "value") return null;
  const value = asRecord(fact.value);
  if (!value) return null;
  const point = asRecord(value.placementPoint);
  const lng = finite(point?.lng ?? point?.longitude);
  const lat = finite(point?.lat ?? point?.latitude);
  if (lng === null || lat === null || !plausibleLngLat(lng, lat)) return null;
  const partsOuterRings = outerRings(value.geometry);
  if (!partsOuterRings) return null;
  return {
    partsOuterRings,
    placementPoint: { longitude: lng, latitude: lat },
    partCount: finite(value.partCount),
    areaSqM: finite(value.areaSqM),
  };
}

/** Shoelace area in the ring's own units (signed: > 0 is counter-clockwise). */
function signedArea(ring: readonly [number, number][]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[(i + 1) % ring.length]!;
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The parcel outline in the draw frame the MCP card already uses: local US
 * survey feet, origin at the frame `anchor`, true-north y-axis, open
 * (no repeated closing vertex), counter-clockwise.
 *
 * The draw carries ONE ring. For a multi-part parcel it is the largest part's
 * outer ring; the other parts are not drawn (the card has no multi-ring slot),
 * never merged into one invented polygon.
 */
export function oneDoorRingInDrawFrame(
  geometry: OneDoorParcelGeometry,
  anchor: DrawFrameAnchor,
): [number, number][] | null {
  let best: [number, number][] | null = null;
  let bestArea = -1;
  for (const lngLat of geometry.partsOuterRings) {
    const feet = envelopeRingToLocalFeet(lngLat, anchor);
    // envelopeRingToLocalFeet closes the ring; the draw ring is open.
    if (feet.length > 1) {
      const [fx, fy] = feet[0]!;
      const [lx, ly] = feet[feet.length - 1]!;
      if (fx === lx && fy === ly) feet.pop();
    }
    if (feet.length < 3) continue;
    const area = Math.abs(signedArea(feet));
    if (area > bestArea) {
      best = feet;
      bestArea = area;
    }
  }
  if (!best || bestArea <= 0) return null;
  const ccw = signedArea(best) > 0 ? best : [...best].reverse();
  return ccw.map(([x, y]) => [round2(x), round2(y)]);
}
