/**
 * Edge labeling for the buildable envelope — THE CRUX.
 *
 * A parcel polygon is an unlabeled ring. Insetting by setbacks needs to know
 * which edge is the FRONT (street-facing, gets front_ft), which are SIDES
 * (side_ft), and which is the REAR (rear_ft). We resolve the FRONT edge from
 * the best available signal, then derive sides/rear geometrically, and — this
 * is mandatory for a commitment-#1 surface — carry an HONEST confidence for the
 * labeling so a wrong-but-confident envelope is never drawn.
 *
 * Signal tiers (best first):
 *   road   — nearest road centerline (OSM Overpass); the parcel edge most
 *            parallel-and-close to a road is the front. HIGH confidence.
 *   point  — a reference point (the geocoded situs/address point); the edge
 *            nearest that point is treated as the front. MEDIUM confidence
 *            (the geocoded point is usually near the street-facing structure,
 *            but it is not the frontage line).
 *   shape  — pure geometry heuristic: for a roughly-rectangular lot the front
 *            is a SHORT edge (lots are deeper than wide); we pick the shorter
 *            of the two "end" edges. LOW confidence — flagged approximate.
 *
 * Sides/rear, once the front is chosen: the edge "opposite" the front (most
 * anti-parallel, farthest) is the REAR; everything else is a SIDE. Corner-lot
 * side_corner handling is deferred (v1 uses side_ft for all sides) and noted in
 * the disclosure.
 *
 * This module is pure: it consumes an already-fetched nearest-road polyline
 * and/or reference point and returns a per-edge label + a labeling confidence.
 * The network fetch of the road lives in roads.ts.
 */

import { openRing, projectRing, type Ring } from "./geometry";

export type EdgeLabel = "front" | "side" | "rear";

export type LabelSignal = "road" | "point" | "shape";

export interface EdgeInfo {
  /** Index of this edge (vertex i -> i+1) in the opened+CCW ring. */
  index: number;
  label: EdgeLabel;
  /** Edge length in metres. */
  lengthM: number;
}

export interface EdgeLabelingResult {
  /** One label per edge of the opened+CCW ring, aligned to projectRing order. */
  edges: EdgeInfo[];
  /** Which signal produced the front-edge choice. */
  signal: LabelSignal;
  /**
   * Confidence in the LABELING (0..1). This gates the whole envelope's
   * confidence — a low value forces the "approximate" disclosure.
   */
  confidence: number;
  /** Human note describing how the front edge was inferred. */
  note: string;
}

interface XY {
  x: number;
  y: number;
}

/** A road centerline as lng/lat points (from OSM `geometry`), any length. */
export type RoadPolyline = [number, number][];

function midpoint(a: XY, b: XY): XY {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function dist(a: XY, b: XY): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Distance from point p to segment ab (all local metres). */
function pointToSegment(p: XY, a: XY, b: XY): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-9) return dist(p, a);
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  const proj = { x: a.x + t * abx, y: a.y + t * aby };
  return dist(p, proj);
}

/** Absolute cosine of the angle between two direction vectors (1 = parallel). */
function absCosBetween(ax: number, ay: number, bx: number, by: number): number {
  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(bx, by);
  if (la < 1e-9 || lb < 1e-9) return 0;
  return Math.abs((ax * bx + ay * by) / (la * lb));
}

interface ProjEdges {
  points: XY[];
  edgeMid: XY[];
  edgeLen: number[];
  edgeDir: XY[];
  proj: ReturnType<typeof projectRing>;
}

function buildEdges(ring: Ring): ProjEdges | null {
  const proj = projectRing(ring);
  if (!proj) return null;
  const pts = proj.points;
  const n = pts.length;
  const edgeMid: XY[] = [];
  const edgeLen: number[] = [];
  const edgeDir: XY[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    edgeMid.push(midpoint(a, b));
    edgeLen.push(dist(a, b));
    edgeDir.push({ x: b.x - a.x, y: b.y - a.y });
  }
  return { points: pts, edgeMid, edgeLen, edgeDir, proj };
}

/** Project a lng/lat point into the same local frame as the ring. */
function projectPoint(
  lng: number,
  lat: number,
  proj: NonNullable<ReturnType<typeof projectRing>>,
): XY {
  return {
    x: (lng - proj.originLng) * proj.mPerDegLng,
    y: (lat - proj.originLat) * proj.mPerDegLat,
  };
}

/**
 * Choose the FRONT edge from the nearest road polyline. The front edge is the
 * one whose midpoint is closest to the road AND is reasonably parallel to it.
 * Returns null when no road segment is close enough to be trustworthy.
 */
function frontFromRoad(
  edges: ProjEdges,
  road: RoadPolyline,
): { index: number; confidence: number } | null {
  const proj = edges.proj!;
  const roadXY = road.map(([lng, lat]) => projectPoint(lng, lat, proj));
  if (roadXY.length < 2) return null;

  let best = -1;
  let bestScore = Infinity;
  let bestDist = Infinity;
  for (let i = 0; i < edges.edgeMid.length; i++) {
    const mid = edges.edgeMid[i]!;
    // Nearest distance from this edge midpoint to any road segment.
    let minD = Infinity;
    let bestPar = 0;
    for (let r = 0; r + 1 < roadXY.length; r++) {
      const ra = roadXY[r]!;
      const rb = roadXY[r + 1]!;
      const d = pointToSegment(mid, ra, rb);
      if (d < minD) {
        minD = d;
        const dir = edges.edgeDir[i]!;
        bestPar = absCosBetween(dir.x, dir.y, rb.x - ra.x, rb.y - ra.y);
      }
    }
    // Score prefers close AND parallel. Weight distance heavily.
    const score = minD * (1.4 - 0.4 * bestPar);
    if (score < bestScore) {
      bestScore = score;
      best = i;
      bestDist = minD;
    }
  }
  if (best < 0) return null;
  // Trust gate: the road must be within a plausible frontage distance of the
  // chosen edge (a parcel's frontage is within ~40 m of the street centerline
  // for typical residential lots; beyond that the "nearest road" is ambiguous).
  if (bestDist > 45) return null;
  // Confidence scales down as the road gets farther / less parallel.
  const proximity = Math.max(0, 1 - bestDist / 45);
  const confidence = 0.7 + 0.2 * proximity; // 0.70..0.90
  return { index: best, confidence: Math.min(0.9, confidence) };
}

/** Choose the FRONT edge as the one nearest a reference (geocoded) point. */
function frontFromPoint(
  edges: ProjEdges,
  refLng: number,
  refLat: number,
): { index: number; confidence: number } {
  const proj = edges.proj!;
  const ref = projectPoint(refLng, refLat, proj);
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < edges.edgeMid.length; i++) {
    const d = dist(ref, edges.edgeMid[i]!);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  // Medium confidence: the geocoded point trends toward the street-facing
  // structure but is not the frontage line.
  return { index: best, confidence: 0.55 };
}

/**
 * Pure-shape fallback: for a roughly-rectangular lot the front is a SHORT edge
 * (residential lots are deeper than wide). Pick the shorter of the two shortest
 * edges as the front. LOW confidence.
 */
function frontFromShape(edges: ProjEdges): { index: number; confidence: number } {
  let best = 0;
  let bestLen = Infinity;
  for (let i = 0; i < edges.edgeLen.length; i++) {
    if (edges.edgeLen[i]! < bestLen) {
      bestLen = edges.edgeLen[i]!;
      best = i;
    }
  }
  return { index: best, confidence: 0.35 };
}

/**
 * Given the chosen front edge, label the rest: the edge most ANTI-parallel to
 * the front and farthest from it is the REAR; all others are SIDES.
 */
function labelFromFront(edges: ProjEdges, frontIdx: number): EdgeInfo[] {
  const n = edges.edgeLen.length;
  const front = edges.edgeDir[frontIdx]!;
  const frontMid = edges.edgeMid[frontIdx]!;

  // Rear: maximize (anti-parallel-ness * distance-from-front).
  let rearIdx = -1;
  let rearScore = -Infinity;
  for (let i = 0; i < n; i++) {
    if (i === frontIdx) continue;
    const dir = edges.edgeDir[i]!;
    const par = absCosBetween(front.x, front.y, dir.x, dir.y); // parallel-ness
    const d = dist(frontMid, edges.edgeMid[i]!);
    const score = par * d;
    if (score > rearScore) {
      rearScore = score;
      rearIdx = i;
    }
  }

  const out: EdgeInfo[] = [];
  for (let i = 0; i < n; i++) {
    let label: EdgeLabel = "side";
    if (i === frontIdx) label = "front";
    else if (i === rearIdx) label = "rear";
    out.push({ index: i, label, lengthM: edges.edgeLen[i]! });
  }
  return out;
}

export interface LabelInputs {
  ring: Ring;
  /** Nearest road centerline (lng/lat points), when available. */
  road?: RoadPolyline | null;
  /** Reference point (geocoded situs/address point), when available. */
  refPoint?: { lng: number; lat: number } | null;
}

/**
 * Label every edge of the parcel ring, choosing the best available signal for
 * the front edge and deriving sides/rear. Always returns a labeling (never
 * throws) — the confidence + note carry the honesty.
 */
export function labelEdges(input: LabelInputs): EdgeLabelingResult | null {
  const edges = buildEdges(input.ring);
  if (!edges) return null;
  if (openRing(input.ring).length < 3) return null;

  let front: { index: number; confidence: number } | null = null;
  let signal: LabelSignal = "shape";
  let note = "";

  if (input.road && input.road.length >= 2) {
    front = frontFromRoad(edges, input.road);
    if (front) {
      signal = "road";
      note =
        "Front edge inferred from the nearest street centerline (OpenStreetMap).";
    }
  }

  if (!front && input.refPoint) {
    front = frontFromPoint(edges, input.refPoint.lng, input.refPoint.lat);
    signal = "point";
    note =
      "Front edge inferred from the geocoded address point (approximate — not the surveyed frontage).";
  }

  if (!front) {
    front = frontFromShape(edges);
    signal = "shape";
    note =
      "Front edge inferred from lot shape only (no street or address reference) — orientation is approximate.";
  }

  const labeled = labelFromFront(edges, front.index);
  return {
    edges: labeled,
    signal,
    confidence: front.confidence,
    note,
  };
}

/**
 * Compose the per-edge setback (feet) array the geometry core consumes, from a
 * labeling and the district's front/side/rear feet. Aligned to the same
 * opened+CCW ring order (projectRing) as insetPerEdge expects.
 */
export function insetFeetForLabeling(
  labeling: EdgeLabelingResult,
  setbacks: { front_ft: number; side_ft: number; rear_ft: number },
): number[] {
  return labeling.edges.map((e) => {
    if (e.label === "front") return setbacks.front_ft;
    if (e.label === "rear") return setbacks.rear_ft;
    return setbacks.side_ft;
  });
}
