/**
 * P-465 residue guard (OPS-16 A-329).
 *
 * A drawn envelope that fails the census checks is not drawn. The customer
 * sentence is fixed. The machine reasons are the census codes, and they travel
 * on the honesty coverage (the route's source block) and on the draw overlay's
 * provenance, not in the sentence.
 *
 * The checks are the CP4 census checks, with the same thresholds
 * (`_scratch/p465-tools/envelope-census.mjs` and `envelope-census-cp3.mjs`):
 * stubs and the area band are scored on the cleaned ring the inset used;
 * the envelope is outside the lot when it stands more than a foot outside the
 * original ring, or more than one square foot outside the cleaned ring.
 * A clip that cannot run does not fail the outside check: the census treated
 * that as unmeasured, and a throw must not blank a parcel the census passed.
 */

import polygonClipping from "polygon-clipping";
import {
  openRing,
  projectRing,
  ringAreaSqFt,
  type Ring,
} from "./geometry";

type XY = { x: number; y: number };

export const ENVELOPE_SHAPE_UNRESOLVED =
  "Envelope not drawn: the parcel's shape could not be resolved";

/** Census thresholds. Stated so a later change cannot drift silently. */
export const SANITY_STUB_MAX_FT = 2;
export const SANITY_OUTSIDE_MAX_SQFT = 1;
export const SANITY_OUTSIDE_MAX_FT = 1;
export const SANITY_AREA_BAND = 0.35;

const FT_PER_M = 3.280839895;
const CELL_M = 20;

export type SanityEdgeSignal = "road" | "point" | "shape" | null;

export function envelopeSanityReasons(input: {
  cleanedRing: Ring;
  originalRing: Ring;
  envelopeRing: Ring;
  insetFeet: number[] | null;
  edgeSignal: SanityEdgeSignal;
}): string[] {
  const reasons: string[] = [];
  const cleaned = projectRing(input.cleanedRing);
  if (cleaned) {
    const stubEdges = edgeLengthsFt(cleaned.points).filter((l) => l < SANITY_STUB_MAX_FT).length;
    if (stubEdges > 0) reasons.push("ring-stub-edge");
  }

  const outsideCleaned = outsideAreaSqFt(input.envelopeRing, input.cleanedRing);
  const outsideOriginalFt = outsideMaxFt(input.envelopeRing, input.originalRing);
  if (
    (outsideCleaned != null && outsideCleaned > SANITY_OUTSIDE_MAX_SQFT) ||
    (outsideOriginalFt != null && outsideOriginalFt > SANITY_OUTSIDE_MAX_FT)
  ) {
    reasons.push("envelope-outside-ring");
  }

  const signal = input.edgeSignal;
  if (signal !== "road") {
    reasons.push(
      signal === "point"
        ? "front-from-point"
        : signal === "shape"
          ? "front-from-shape"
          : "front-signal-absent",
    );
  }

  const drawn = ringAreaSqFt(input.envelopeRing);
  const feet = input.insetFeet;
  if (cleaned && feet && feet.length === cleaned.points.length) {
    const estimate = estimateSqFt(cleaned.points, feet);
    if (estimate != null && (estimate <= 1 || Math.abs(drawn - estimate) / estimate > SANITY_AREA_BAND)) {
      reasons.push("envelope-area-outside-band");
    }
  }

  return reasons;
}

function edgeLengthsFt(points: XY[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    out.push(Math.hypot(b.x - a.x, b.y - a.y) * FT_PER_M);
  }
  return out;
}

/** Analytic inset area. feet[i] is the setback on the CCW edge i -> i+1. */
function estimateSqFt(points: XY[], feet: number[]): number | null {
  if (points.length < 3 || feet.length !== points.length) return null;
  if (feet.some((d) => !Number.isFinite(d) || d < 0)) return null;
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const c = points[i]!;
    const n = points[(i + 1) % points.length]!;
    area += c.x * n.y - n.x * c.y;
  }
  area = (Math.abs(area) / 2) * FT_PER_M * FT_PER_M;
  let strip = 0;
  let corners = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const lenFt = Math.hypot(
      points[(i + 1) % n]!.x - points[i]!.x,
      points[(i + 1) % n]!.y - points[i]!.y,
    ) * FT_PER_M;
    strip += lenFt * feet[i]!;
    const prev = points[(i - 1 + n) % n]!;
    const cur = points[i]!;
    const next = points[(i + 1) % n]!;
    const ax = cur.x - prev.x;
    const ay = cur.y - prev.y;
    const bx = next.x - cur.x;
    const by = next.y - cur.y;
    const ext = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
    const deg = Math.abs(ext) * (180 / Math.PI);
    if (ext > 0 && deg < 150) {
      corners += feet[(i - 1 + n) % n]! * feet[i]! * Math.tan(ext / 2);
    }
  }
  return area - strip + corners;
}

function asPoly(ring: Ring): [number, number][][] {
  const open = openRing(ring);
  if (open.length < 3) return [];
  return [[...open, open[0]!]];
}

function outsideAreaSqFt(subject: Ring, boundary: Ring): number | null {
  try {
    const diff = polygonClipping.difference(asPoly(subject), asPoly(boundary));
    let area = 0;
    for (const poly of diff) {
      const ring = poly[0];
      if (ring && ring.length >= 4) area += ringAreaSqFt(ring as Ring);
    }
    return Math.max(0, area);
  } catch {
    return null;
  }
}

/**
 * Maximum feet the subject stands outside the boundary. Null when the clip
 * cannot run. A sliver under 0.05 sq ft is treated as on the ring.
 */
export function outsideMaxFt(subject: Ring, boundary: Ring): number | null {
  const area = outsideAreaSqFt(subject, boundary);
  if (area == null) return null;
  if (area <= 0.05) return 0;
  const frame = projectRing(boundary);
  if (!frame) return null;
  const origin = frame;
  const env = openRing(subject).map(([lng, lat]) => ({
    x: (lng - origin.originLng) * origin.mPerDegLng,
    y: (lat - origin.originLat) * origin.mPerDegLat,
  }));
  const boundaryPts = frame.points;
  const grid = buildEdgeGrid(boundaryPts);
  let maxM = 0;
  for (let i = 0; i < env.length; i++) {
    const a = env[i]!;
    const b = env[(i + 1) % env.length]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(len / 0.3));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      if (pointInRing(p, boundaryPts)) continue;
      const d = nearestEdgeM(p, boundaryPts, grid);
      if (d > maxM) maxM = d;
    }
  }
  return Math.round(maxM * FT_PER_M * 100) / 100;
}

function pointInRing(p: XY, pts: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!;
    const b = pts[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function segDistM(a: XY, b: XY, p: XY): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-8) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
}

function cellKey(ix: number, iy: number): number {
  return ix * 73856093 + iy;
}

function buildEdgeGrid(pts: XY[]): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const ix0 = Math.floor(Math.min(a.x, b.x) / CELL_M);
    const ix1 = Math.floor(Math.max(a.x, b.x) / CELL_M);
    const iy0 = Math.floor(Math.min(a.y, b.y) / CELL_M);
    const iy1 = Math.floor(Math.max(a.y, b.y) / CELL_M);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        const k = cellKey(ix, iy);
        const bucket = map.get(k);
        if (bucket) bucket.push(i);
        else map.set(k, [i]);
      }
    }
  }
  return map;
}

function nearestEdgeM(p: XY, pts: XY[], grid: Map<number, number[]>): number {
  const ix = Math.floor(p.x / CELL_M);
  const iy = Math.floor(p.y / CELL_M);
  let best = Infinity;
  for (let r = 0; r < 40; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (r > 0 && Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const bucket = grid.get(cellKey(ix + dx, iy + dy));
        if (!bucket) continue;
        for (const i of bucket) {
          const d = segDistM(pts[i]!, pts[(i + 1) % pts.length]!, p);
          if (d < best) best = d;
        }
      }
    }
    if (best <= r * CELL_M) return best;
  }
  return Number.isFinite(best) ? best : CELL_M * 40;
}
