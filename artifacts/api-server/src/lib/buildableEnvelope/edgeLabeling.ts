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
 * GROUPING (WDLL P-60b item 3): GIS parcel rings digitize a curved street
 * frontage as many short chords (observed: 7 segments with ~0.6° joints on
 * 48453:280239) and a straight boundary as several collinear pieces. Labeling
 * therefore operates on LOGICAL edges: contiguous runs of near-collinear ring
 * edges grouped by turn angle at the shared vertex. Every member edge of a
 * group receives the group's label, and the output stays aligned 1:1 with the
 * ORIGINAL ring edges — grouping is a labeling-time view only; insetPerEdge
 * still consumes one feet value per original edge.
 *
 * Sides/rear, once the front is chosen: the logical edge "opposite" the front
 * (most anti-parallel, farthest) is the REAR; everything else is a SIDE.
 * Corner lots (parcel touches 2+ distinct NAMED street frontages) label a
 * second street edge as side_corner and apply the street-side setback there —
 * and the second street must actually ADJOIN the parcel (CORNER_ADJOIN_MAX_M),
 * not merely sit within the primary trust gate. Unresolved corners are
 * disclosed honestly — never fabricate a second frontage.
 *
 * This module is pure: it consumes an already-fetched nearest-road polyline
 * and/or reference point and returns a per-edge label + a labeling confidence.
 * The network fetch of the road lives in roads.ts.
 */

import { openRing, projectRing, SURVEY_NOISE_THRESHOLD_M, type Ring } from "./geometry";
import type { V1RoadClassification } from "./roadClassify";
import {
  roadClassSetbackFt,
  type RoadClassSetbackDistrictRow,
} from "./roadClassSetbacks";

export type EdgeLabel = "front" | "side" | "rear" | "side_corner";

export type LabelSignal = "road" | "point" | "shape";

export interface EdgeInfo {
  /** Index of this edge (vertex i -> i+1) in the opened+CCW ring. */
  index: number;
  label: EdgeLabel;
  /** Edge length in metres. */
  lengthM: number;
  /** v1 road classification of the nearest classified road (when known). */
  roadClass?: V1RoadClassification;
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
  /** True when two distinct named street frontages were resolved. */
  cornerLot?: boolean;
  /**
   * True when nearby roads suggest a corner but a second named frontage could
   * not be resolved — caller must not invent side_corner geometry.
   */
  cornerUnresolved?: boolean;
}

interface XY {
  x: number;
  y: number;
}

/** A road centerline as lng/lat points (from OSM `geometry`), any length. */
export type RoadPolyline = [number, number][];

/**
 * A road candidate with its OSM `name` (when tagged). Passing MANY of these
 * (not just the single longest way) lets frontFromRoad pick the best-matching
 * edge across candidates — and, when a situs street name is known, prefer the
 * road whose name matches the situs (the cul-de-sac defense: a lot's true
 * frontage is often a short named cul-de-sac, not the nearby longer through
 * street).
 */
export interface RoadCandidate {
  name: string | null;
  polyline: RoadPolyline;
  /** OSM highway tag when known (residential, service, …). */
  highway?: string | null;
  /** v1 classification derived from highway tag or road-node spine. */
  classification?: V1RoadClassification;
}

/**
 * Normalize a street name for tolerant comparison: lowercase, strip
 * punctuation, collapse whitespace, and canonicalize the common street-type
 * suffixes (dr/drive, st/street, …) and directionals so "NOLAN DR" matches OSM
 * "Nolan Drive". Returns "" when nothing usable remains.
 */
export function normalizeStreetName(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = raw.toLowerCase();
  // Drop a leading house number ("120 nolan dr" -> "nolan dr").
  s = s.replace(/^\s*\d+[a-z]?\s+/, "");
  // Strip unit designators ("apt 3", "#4", "ste b") — keep it simple.
  s = s.replace(/\b(apt|apartment|unit|ste|suite|#)\s*\S+/g, " ");
  s = s.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return "";
  const suffixMap: Record<string, string> = {
    dr: "drive",
    drive: "drive",
    st: "street",
    street: "street",
    rd: "road",
    road: "road",
    ln: "lane",
    lane: "lane",
    ave: "avenue",
    av: "avenue",
    avenue: "avenue",
    blvd: "boulevard",
    boulevard: "boulevard",
    ct: "court",
    court: "court",
    cir: "circle",
    circle: "circle",
    pl: "place",
    place: "place",
    ter: "terrace",
    terrace: "terrace",
    trl: "trail",
    trail: "trail",
    pkwy: "parkway",
    parkway: "parkway",
    hwy: "highway",
    highway: "highway",
    way: "way",
    cv: "cove",
    cove: "cove",
    psge: "passage",
    pass: "pass",
    run: "run",
    bnd: "bend",
    bend: "bend",
    xing: "crossing",
    crossing: "crossing",
    loop: "loop",
    path: "path",
  };
  const dirMap: Record<string, string> = {
    n: "north",
    s: "south",
    e: "east",
    w: "west",
    ne: "northeast",
    nw: "northwest",
    se: "southeast",
    sw: "southwest",
  };
  const tokens = s.split(" ").map((t) => {
    if (suffixMap[t]) return suffixMap[t];
    if (dirMap[t]) return dirMap[t];
    return t;
  });
  return tokens.join(" ").trim();
}

/**
 * Extract the street name from a situs address ("120 NOLAN DR, KYLE, TX 78640"
 * -> "nolan drive"), normalized for comparison. Returns "" when the situs has
 * no parseable street token (falls back to nearest-road behavior upstream).
 */
export function streetNameFromSitus(situs: string | null | undefined): string {
  if (!situs) return "";
  // The street is the first comma-delimited component ("120 NOLAN DR").
  const firstPart = situs.split(",")[0] ?? "";
  return normalizeStreetName(firstPart);
}

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

// === Logical-edge grouping (WDLL P-60b item 3) ===

/**
 * Max |turn| in DEGREES at a shared vertex for two adjacent ring edges to be
 * treated as one logical edge for labeling.
 *
 * Choice of 20°, from the 48453:280239 forensics: joints along a digitized
 * frontage curve measure ~0.6° each, while the real lot corners on the same
 * ring turn 89.8–92.7°. Even a chamfered (cut) 90° corner splits into two
 * ~45° joints. 20° sits more than an order of magnitude above observed
 * digitization curvature and comfortably below the smallest semantically
 * distinct corner, the same "ignore artifacts, keep meaning" posture as
 * SURVEY_NOISE_THRESHOLD_M in geometry.ts (which handles sliver LENGTHS; this
 * handles joint ANGLES).
 */
export const COLLINEAR_TURN_MAX_DEG = 20;

/**
 * Cap on the ACCUMULATED |turn| across one group. A smoothly digitized 90°
 * corner arc (e.g. nine 12° joints) passes the per-joint test at every vertex
 * but is a corner, not a frontage; without a cumulative cap it would merge two
 * semantically distinct boundaries. 45° is the smallest total turn at which
 * two runs plausibly face different streets. The Simsbrook frontage curve
 * accumulates only ~3.6° across six joints — far under the cap.
 */
export const GROUP_TOTAL_TURN_MAX_DEG = 45;

/** |turn| between two direction vectors, in degrees (0..180). */
function turnAngleDeg(a: XY, b: XY): number {
  const cross = a.x * b.y - a.y * b.x;
  const dot = a.x * b.x + a.y * b.y;
  return Math.abs((Math.atan2(cross, dot) * 180) / Math.PI);
}

interface EdgeGroups {
  /** groups[g] = contiguous (circularly) original edge indices, in ring order. */
  groups: number[][];
  /** groupOf[i] = group index for original edge i. */
  groupOf: number[];
}

function identityGroups(n: number): EdgeGroups {
  const groups: number[][] = [];
  const groupOf: number[] = [];
  for (let i = 0; i < n; i++) {
    groups.push([i]);
    groupOf.push(i);
  }
  return { groups, groupOf };
}

/**
 * Partition ring edges into contiguous near-collinear groups. Joint j sits at
 * the shared vertex between edge j and edge (j+1)%n; it BREAKS a group when
 * its |turn| ≥ COLLINEAR_TURN_MAX_DEG, or when the group's accumulated turn
 * would exceed GROUP_TOTAL_TURN_MAX_DEG. The walk starts just after the first
 * breaking joint so the circular wrap needs no merge pass.
 *
 * Fallbacks to identity (no grouping): a ring with no breaking joint at all
 * (a smooth blob — one "logical edge" is meaningless), or one that groups to
 * fewer than 3 logical edges (front/rear/side needs at least 3).
 */
function groupCollinearEdges(edges: ProjEdges): EdgeGroups {
  const n = edges.edgeLen.length;
  const jointTurn: number[] = [];
  for (let j = 0; j < n; j++) {
    jointTurn.push(
      turnAngleDeg(edges.edgeDir[j]!, edges.edgeDir[(j + 1) % n]!),
    );
  }
  const firstBreak = jointTurn.findIndex((t) => t >= COLLINEAR_TURN_MAX_DEG);
  if (firstBreak < 0) return identityGroups(n);

  const groups: number[][] = [];
  let current: number[] = [];
  let accTurn = 0;
  for (let k = 1; k <= n; k++) {
    const i = (firstBreak + k) % n;
    current.push(i);
    const t = jointTurn[i]!;
    if (t >= COLLINEAR_TURN_MAX_DEG || accTurn + t >= GROUP_TOTAL_TURN_MAX_DEG) {
      groups.push(current);
      current = [];
      accTurn = 0;
    } else {
      accTurn += t;
    }
  }
  // The walk ends exactly at the first breaking joint, which closes the last
  // group; anything else is a broken invariant, not a state to paper over.
  if (current.length) {
    throw new Error(
      "groupCollinearEdges: walk ended with an unclosed group (invariant violated)",
    );
  }
  if (groups.length < 3) return identityGroups(n);

  const groupOf = new Array<number>(n).fill(-1);
  for (let g = 0; g < groups.length; g++) {
    for (const i of groups[g]!) groupOf[i] = g;
  }
  return { groups, groupOf };
}

interface GroupGeom {
  /** Sum of member edge lengths (m). */
  totalLen: number;
  /** Length-weighted centroid of member edge midpoints. */
  mid: XY;
  /** Chord: start vertex of first member -> end vertex of last member. */
  chordDir: XY;
}

function groupGeometry(edges: ProjEdges, members: number[]): GroupGeom {
  const n = edges.edgeLen.length;
  let totalLen = 0;
  let mx = 0;
  let my = 0;
  for (const i of members) {
    const len = edges.edgeLen[i]!;
    totalLen += len;
    mx += edges.edgeMid[i]!.x * len;
    my += edges.edgeMid[i]!.y * len;
  }
  const w = totalLen > 1e-9 ? totalLen : members.length;
  const mid =
    totalLen > 1e-9
      ? { x: mx / w, y: my / w }
      : edges.edgeMid[members[0]!]!;
  const first = edges.points[members[0]!]!;
  const last = edges.points[(members[members.length - 1]! + 1) % n]!;
  return { totalLen, mid, chordDir: { x: last.x - first.x, y: last.y - first.y } };
}

/**
 * Expand per-GROUP labels back to per-ORIGINAL-edge labels, enforcing the 1:1
 * alignment contract insetPerEdge depends on: the groups must partition
 * exactly [0..edgeCount) and there must be one label per group. Throws on any
 * violation — an off-by-one here would silently inset the wrong edges by the
 * wrong feet, which is worse than a loud failure. Exported for the violation
 * tests.
 */
export function expandGroupLabelsToEdges(
  groups: number[][],
  groupLabels: EdgeLabel[],
  edgeCount: number,
): EdgeLabel[] {
  if (groups.length !== groupLabels.length) {
    throw new Error(
      `expandGroupLabelsToEdges: ${groups.length} groups but ${groupLabels.length} labels`,
    );
  }
  const out = new Array<EdgeLabel | null>(edgeCount).fill(null);
  let assigned = 0;
  for (let g = 0; g < groups.length; g++) {
    for (const i of groups[g]!) {
      if (!Number.isInteger(i) || i < 0 || i >= edgeCount) {
        throw new Error(
          `expandGroupLabelsToEdges: member index ${i} outside [0..${edgeCount})`,
        );
      }
      if (out[i] !== null) {
        throw new Error(
          `expandGroupLabelsToEdges: edge ${i} assigned by two groups`,
        );
      }
      out[i] = groupLabels[g]!;
      assigned++;
    }
  }
  if (assigned !== edgeCount) {
    throw new Error(
      `expandGroupLabelsToEdges: ${assigned} edges labeled, expected ${edgeCount}`,
    );
  }
  return out as EdgeLabel[];
}

/**
 * PRIMARY trust gate (m): how far a road centerline may sit from a parcel edge
 * midpoint and still count as usable front-edge signal. Deliberately loose —
 * the nearest road really is the frontage for most lots, and tightening it
 * darkens the road tier on deep-setback parcels.
 */
const ROAD_TRUST_MAX_M = 45;

/**
 * SECOND-frontage adjacency bound (m) — WDLL P-60b item 5. Claiming a CORNER
 * lot asserts the parcel adjoins a second street, so the bar is adjacency,
 * not mere proximity: the road centerline must be within roughly one
 * right-of-way half-width of the candidate edge. Local-residential ROW is
 * typically 50–60 ft (15–18 m) full width, i.e. centerline-to-frontage
 * ~7.5–9 m (Simsbrook's own frontage measures 7.5 m here); 25 m adds slack
 * for wide collector ROWs and curved-frontage midpoint offsets while still
 * excluding across-the-block roads (Dashwood Creek at 43.3 m / 142 ft from
 * parcel 48453:280239 passed the 45 m blanket and fabricated a corner).
 * Measured with the same metric as the primary match: bestEdgeForRoad's
 * perpendicular midpoint-to-centerline distance.
 */
export const CORNER_ADJOIN_MAX_M = 25;

/**
 * Best edge for ONE road polyline: the parcel edge whose midpoint is closest to
 * the road AND is reasonably parallel to it, subject to the trust gate. Returns
 * null when no edge is within a plausible frontage distance of this road.
 */
function bestEdgeForRoad(
  edges: ProjEdges,
  road: RoadPolyline,
): { index: number; dist: number; confidence: number } | null {
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
  if (bestDist > ROAD_TRUST_MAX_M) return null;
  // Confidence scales down as the road gets farther / less parallel.
  const proximity = Math.max(0, 1 - bestDist / ROAD_TRUST_MAX_M);
  const confidence = 0.7 + 0.2 * proximity; // 0.70..0.90
  return {
    index: best,
    dist: bestDist,
    confidence: Math.min(0.9, confidence),
  };
}

/**
 * Attach the nearest ADJOINING road classification per LOGICAL edge: a road
 * that matches any member of a group classifies the whole group, so a
 * segmented frontage carries one class across all of its member edges (a
 * road-class setback table must not split feet across one frontage).
 * Adjacency bound (CORNER_ADJOIN_MAX_M), not the 45 m trust gate: road-class
 * setbacks apply to the street an edge actually fronts/abuts, and the blanket
 * gate let a road across the block (Dashwood Creek, 43.3 m) classify a rear
 * edge it never touches.
 */
function attachRoadClasses(
  labeled: EdgeInfo[],
  edges: ProjEdges,
  eg: EdgeGroups,
  roads: RoadCandidate[],
): EdgeInfo[] {
  if (!roads.length) return labeled;
  const classByGroup = new Map<number, V1RoadClassification>();
  const distByGroup = new Map<number, number>();
  for (const road of roads) {
    if (!road.classification) continue;
    const cand = bestEdgeForRoad(edges, road.polyline);
    if (!cand || cand.dist > CORNER_ADJOIN_MAX_M) continue;
    const g = eg.groupOf[cand.index]!;
    if (cand.dist < (distByGroup.get(g) ?? Infinity)) {
      distByGroup.set(g, cand.dist);
      classByGroup.set(g, road.classification);
    }
  }
  return labeled.map((e) => {
    const roadClass = classByGroup.get(eg.groupOf[e.index]!);
    return roadClass ? { ...e, roadClass } : e;
  });
}

/**
 * Choose the FRONT edge across ALL nearby road candidates, not just the single
 * longest one. Two-stage:
 *
 *   1) SITUS-NAMED PREFERENCE (the cul-de-sac defense): if the situs street name
 *      is known and one or more candidates carry a matching OSM `name`, resolve
 *      the front against those roads ONLY — the situs names the true fronting
 *      street even when a longer through-street runs nearby. Pick the best
 *      (closest) matching-named road that passes the trust gate.
 *   2) NEAREST fallback: otherwise (no situs name, no name match, or the named
 *      road failed the trust gate) pick the candidate that yields the closest
 *      trustworthy edge across ALL candidates. This fixes the latent bug where
 *      only roads[0] (longest) was considered, so a lot fronting a shorter side
 *      street matched the wrong road.
 *
 * Returns the chosen front edge + confidence + which strategy fired, or null
 * when no candidate produces a trustworthy edge (caller degrades to point/shape).
 */
function frontFromRoads(
  edges: ProjEdges,
  roads: RoadCandidate[],
  situsStreet: string,
): { index: number; confidence: number; matchedSitus: boolean } | null {
  if (!roads.length) return null;

  // Stage 1: situs-named preference.
  if (situsStreet) {
    let best: { index: number; dist: number; confidence: number } | null = null;
    for (const road of roads) {
      if (normalizeStreetName(road.name) !== situsStreet) continue;
      const cand = bestEdgeForRoad(edges, road.polyline);
      if (cand && (!best || cand.dist < best.dist)) best = cand;
    }
    if (best) {
      // Small confidence bump: a name match is stronger evidence than mere
      // proximity, capped at the road-tier ceiling.
      const confidence = Math.min(0.9, best.confidence + 0.05);
      return { index: best.index, confidence, matchedSitus: true };
    }
  }

  // Stage 2: nearest trustworthy edge across all candidates.
  let best: { index: number; dist: number; confidence: number } | null = null;
  for (const road of roads) {
    const cand = bestEdgeForRoad(edges, road.polyline);
    if (cand && (!best || cand.dist < best.dist)) best = cand;
  }
  if (!best) return null;
  return {
    index: best.index,
    confidence: best.confidence,
    matchedSitus: false,
  };
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

/** |cos| below this => edge is street-facing (perpendicular to lot depth). */
const FRONT_PERP_COS_MAX = 0.5;

/**
 * Pure-shape fallback: for a roughly-rectangular lot the front is a SHORT edge
 * (residential lots are deeper than wide). Survey-artifact slivers shorter than
 * SURVEY_NOISE_THRESHOLD_M are ignored; among eligible edges prefer those
 * perpendicular to the lot's depth axis (longest edge direction). Edges parallel
 * to depth (the long sides of an irregular lot) are excluded from front candidacy
 * so a tiny notch parallel to the depth axis cannot win as "front."
 */
function frontFromShape(edges: ProjEdges): { index: number; confidence: number } {
  const n = edges.edgeLen.length;
  const eligible: number[] = [];
  for (let i = 0; i < n; i++) {
    if (edges.edgeLen[i]! >= SURVEY_NOISE_THRESHOLD_M) {
      eligible.push(i);
    }
  }

  const pickFrom = eligible.length > 0 ? eligible : [...Array(n).keys()];

  let depthIdx = pickFrom[0]!;
  for (const i of pickFrom) {
    if (edges.edgeLen[i]! > edges.edgeLen[depthIdx]!) depthIdx = i;
  }
  const depthDir = edges.edgeDir[depthIdx]!;

  let frontCandidates = pickFrom.filter((i) => {
    const dir = edges.edgeDir[i]!;
    const par = absCosBetween(depthDir.x, depthDir.y, dir.x, dir.y);
    return par < FRONT_PERP_COS_MAX;
  });
  if (frontCandidates.length === 0) {
    frontCandidates = pickFrom.slice();
  }

  let best = frontCandidates[0]!;
  let bestScore = Infinity;
  for (const i of frontCandidates) {
    const dir = edges.edgeDir[i]!;
    const par = absCosBetween(depthDir.x, depthDir.y, dir.x, dir.y);
    const score = edges.edgeLen[i]! * (0.35 + par);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }

  // Irregular ring (≥5 edges): refuse the unique globally-shortest eligible
  // edge when other front candidates exist — jagged survey notches must not
  // become front on shape-only signal.
  if (n >= 5 && eligible.length > 1 && frontCandidates.length > 1) {
    const minLen = Math.min(...eligible.map((i) => edges.edgeLen[i]!));
    const uniqueShortest = eligible.filter(
      (i) => edges.edgeLen[i]! <= minLen + 1e-6,
    );
    if (uniqueShortest.length === 1 && best === uniqueShortest[0]) {
      let altBest = best;
      let altScore = Infinity;
      for (const i of frontCandidates) {
        if (i === best) continue;
        const dir = edges.edgeDir[i]!;
        const par = absCosBetween(depthDir.x, depthDir.y, dir.x, dir.y);
        const score = edges.edgeLen[i]! * (0.35 + par);
        if (score < altScore) {
          altScore = score;
          altBest = i;
        }
      }
      if (altBest !== best) best = altBest;
    }
  }

  const confidence = eligible.length > 0 ? 0.35 : 0.25;
  return { index: best, confidence };
}

/**
 * Given the chosen front GROUP (and optional second street group for a
 * corner), label the rest: the logical edge most ANTI-parallel to the front
 * chord and farthest from it is the REAR; the second street group is
 * side_corner; all others are SIDES. Labels are chosen per group and expanded
 * back to one label per ORIGINAL ring edge through the asserted 1:1 expansion.
 */
function labelFromFront(
  edges: ProjEdges,
  eg: EdgeGroups,
  frontGroup: number,
  cornerGroup: number | null = null,
): EdgeInfo[] {
  const n = edges.edgeLen.length;
  const geoms = eg.groups.map((members) => groupGeometry(edges, members));
  const front = geoms[frontGroup]!;

  // Rear: maximize (anti-parallel-ness * distance-from-front) across groups.
  let rearGroup = -1;
  let rearScore = -Infinity;
  for (let g = 0; g < eg.groups.length; g++) {
    if (g === frontGroup) continue;
    if (cornerGroup != null && g === cornerGroup) continue;
    const geom = geoms[g]!;
    const par = absCosBetween(
      front.chordDir.x,
      front.chordDir.y,
      geom.chordDir.x,
      geom.chordDir.y,
    );
    const score = par * dist(front.mid, geom.mid);
    if (score > rearScore) {
      rearScore = score;
      rearGroup = g;
    }
  }

  const groupLabels: EdgeLabel[] = eg.groups.map((_, g) => {
    if (g === frontGroup) return "front";
    if (cornerGroup != null && g === cornerGroup) return "side_corner";
    if (g === rearGroup) return "rear";
    return "side";
  });
  const perEdge = expandGroupLabelsToEdges(eg.groups, groupLabels, n);
  return perEdge.map((label, i) => ({
    index: i,
    label,
    lengthM: edges.edgeLen[i]!,
  }));
}

/**
 * Detect a second named street frontage for corner lots.
 * Requires a distinct NAMED road (different normalized name from the primary)
 * whose best edge falls in a DIFFERENT logical-edge group AND actually adjoins
 * that edge (within CORNER_ADJOIN_MAX_M — a corner claim asserts adjacency,
 * not 45 m proximity; that blanket admitted Dashwood Creek at 43.3 m against
 * a parcel it never touches). Returns null when unresolved — never fabricates
 * a second frontage.
 */
function secondNamedStreetEdge(
  edges: ProjEdges,
  eg: EdgeGroups,
  roads: RoadCandidate[],
  frontGroup: number,
  primaryRoadName: string | null,
): { groupIdx: number; roadName: string } | null {
  const primaryNorm = normalizeStreetName(primaryRoadName);
  let best: { groupIdx: number; dist: number; roadName: string } | null = null;
  for (const road of roads) {
    const name = normalizeStreetName(road.name);
    if (!name) continue;
    if (primaryNorm && name === primaryNorm) continue;
    const cand = bestEdgeForRoad(edges, road.polyline);
    if (!cand || eg.groupOf[cand.index] === frontGroup) continue;
    if (cand.dist > CORNER_ADJOIN_MAX_M) continue;
    if (!best || cand.dist < best.dist) {
      best = {
        groupIdx: eg.groupOf[cand.index]!,
        dist: cand.dist,
        roadName: name,
      };
    }
  }
  return best ? { groupIdx: best.groupIdx, roadName: best.roadName } : null;
}

/**
 * Count distinct named roads that ADJOIN some parcel edge (adjacency bound,
 * same bar as the corner resolver — a road 43 m across the block must not
 * flip a parcel into "possible corner lot" wording either).
 */
function namedRoadsAdjoiningParcel(
  edges: ProjEdges,
  roads: RoadCandidate[],
): number {
  const names = new Set<string>();
  for (const road of roads) {
    const name = normalizeStreetName(road.name);
    if (!name) continue;
    const cand = bestEdgeForRoad(edges, road.polyline);
    if (cand && cand.dist <= CORNER_ADJOIN_MAX_M) names.add(name);
  }
  return names.size;
}

export interface LabelInputs {
  ring: Ring;
  /**
   * ALL nearby road candidates (preferred). frontFromRoads picks the best-
   * matching edge across candidates, and — when `situsAddress` names the
   * fronting street — prefers the road with the matching OSM name.
   */
  roads?: RoadCandidate[] | null;
  /**
   * Back-compat: a single nearest road centerline. Superseded by `roads`; still
   * honored (wrapped as one unnamed candidate) so existing callers keep working.
   */
  road?: RoadPolyline | null;
  /** Reference point (geocoded situs/address point), when available. */
  refPoint?: { lng: number; lat: number } | null;
  /**
   * Situs address ("120 NOLAN DR, KYLE, TX 78640"), used to extract the fronting
   * street name for the cul-de-sac defense. Ignored when unparseable.
   */
  situsAddress?: string | null;
}

/**
 * Label every edge of the parcel ring, choosing the best available signal for
 * the front edge and deriving sides/rear. Returns a labeling for any valid
 * ring (degenerate rings return null); the confidence + note carry the
 * honesty. The one deliberate exception: a violated group-expansion invariant
 * (labels not 1:1 with original edges) throws loudly rather than letting a
 * misaligned feet array reach insetPerEdge.
 */
export function labelEdges(input: LabelInputs): EdgeLabelingResult | null {
  const edges = buildEdges(input.ring);
  if (!edges) return null;
  if (openRing(input.ring).length < 3) return null;
  const eg = groupCollinearEdges(edges);

  let front: { index: number; confidence: number } | null = null;
  let signal: LabelSignal = "shape";
  let note = "";

  // Assemble road candidates: the preferred `roads` list, plus the back-compat
  // single `road` (wrapped as one unnamed candidate) when no list was given.
  const candidates: RoadCandidate[] =
    input.roads && input.roads.length
      ? input.roads.filter((r) => r.polyline && r.polyline.length >= 2)
      : input.road && input.road.length >= 2
        ? [{ name: null, polyline: input.road }]
        : [];

  let primaryRoadName: string | null = null;
  if (candidates.length) {
    const situsStreet = streetNameFromSitus(input.situsAddress);
    const chosen = frontFromRoads(edges, candidates, situsStreet);
    if (chosen) {
      front = { index: chosen.index, confidence: chosen.confidence };
      signal = "road";
      note = chosen.matchedSitus
        ? "Front edge inferred from the situs-named street centerline (OpenStreetMap)."
        : "Front edge inferred from the nearest street centerline (OpenStreetMap).";
      // Recover the primary road name for corner pairing.
      for (const road of candidates) {
        const cand = bestEdgeForRoad(edges, road.polyline);
        if (cand && cand.index === chosen.index) {
          primaryRoadName = road.name;
          if (chosen.matchedSitus && normalizeStreetName(road.name) === situsStreet) {
            break;
          }
        }
      }
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

  const frontGroup = eg.groupOf[front.index]!;

  let cornerGroup: number | null = null;
  let cornerLot = false;
  let cornerUnresolved = false;
  if (signal === "road" && candidates.length) {
    const second = secondNamedStreetEdge(
      edges,
      eg,
      candidates,
      frontGroup,
      primaryRoadName,
    );
    if (second) {
      cornerGroup = second.groupIdx;
      cornerLot = true;
      note =
        note.replace(/\.$/, "") +
        ". Corner lot: second named street frontage resolved; " +
        "corner-side setback applied";
      front = {
        index: front.index,
        confidence: Math.min(front.confidence, 0.85),
      };
    } else if (namedRoadsAdjoiningParcel(edges, candidates) >= 2) {
      // Suggests a corner but second frontage did not resolve — honest decline
      // of corner geometry (still label as single-front; disclose).
      cornerUnresolved = true;
      note =
        note.replace(/\.$/, "") +
        ". Possible corner lot — second named street frontage unresolved; " +
        "corner-side setback not applied (honest absence, not fabricated).";
      front = {
        index: front.index,
        confidence: Math.min(front.confidence, 0.65),
      };
    }
  }

  const frontSegments = eg.groups[frontGroup]!.length;
  if (frontSegments > 1) {
    note =
      note.replace(/\.?$/, ".") +
      ` Street frontage is digitized as ${frontSegments} contiguous` +
      " near-collinear segments; the front setback applies along the entire frontage.";
  }

  const labeled = attachRoadClasses(
    labelFromFront(edges, eg, frontGroup, cornerGroup),
    edges,
    eg,
    candidates,
  );
  return {
    edges: labeled,
    signal,
    confidence: front.confidence,
    note,
    ...(cornerLot ? { cornerLot: true } : {}),
    ...(cornerUnresolved ? { cornerUnresolved: true } : {}),
  };
}

export type InsetSetbacks = {
  front_ft: number;
  side_ft: number;
  rear_ft: number;
  side_corner_ft?: number;
  /** When true for an axis, that axis insets 0 (silence ≠ zero entitlement). */
  not_specified?: {
    front?: boolean;
    side?: boolean;
    rear?: boolean;
    side_corner?: boolean;
  };
};

/**
 * Compose the per-edge setback (feet) array the geometry core consumes, from a
 * labeling and the district's front/side/rear(/corner) feet. Aligned to the
 * same opened+CCW ring order (projectRing) as insetPerEdge expects.
 * not_specified axes inset 0 and must not be treated as real zero setbacks by
 * callers when grading empty/consume-lot.
 */
export function insetFeetForLabeling(
  labeling: EdgeLabelingResult,
  setbacks: InsetSetbacks,
  options?: {
    districtCode?: string;
    roadClassTable?: RoadClassSetbackDistrictRow | null;
  },
): number[] {
  const ns = setbacks.not_specified;
  const frontFt = ns?.front ? 0 : setbacks.front_ft;
  const sideFt = ns?.side ? 0 : setbacks.side_ft;
  const rearFt = ns?.rear ? 0 : setbacks.rear_ft;
  // Street-side on the corner edge: prefer side_corner when specified; else
  // the primary street-side (front) — never invent a value when both silent.
  let cornerFt = frontFt;
  if (!ns?.side_corner && typeof setbacks.side_corner_ft === "number") {
    cornerFt = setbacks.side_corner_ft;
  } else if (ns?.side_corner && !ns?.front) {
    cornerFt = frontFt;
  } else if (ns?.side_corner && ns?.front) {
    cornerFt = 0;
  }

  const flatForRole = (role: EdgeLabel): number => {
    if (role === "front") return frontFt;
    if (role === "rear") return rearFt;
    if (role === "side_corner") return cornerFt;
    return sideFt;
  };
  const nsForRole = (role: EdgeLabel): boolean => {
    if (role === "front") return !!ns?.front;
    if (role === "rear") return !!ns?.rear;
    if (role === "side_corner") return !!ns?.side_corner;
    return !!ns?.side;
  };

  const districtCode = options?.districtCode ?? "";
  const roadTable = options?.roadClassTable;

  return labeling.edges.map((e) => {
    if (roadTable && districtCode) {
      return roadClassSetbackFt(
        roadTable,
        districtCode,
        e.roadClass,
        e.label,
        flatForRole,
        nsForRole,
      );
    }
    return flatForRole(e.label);
  });
}
