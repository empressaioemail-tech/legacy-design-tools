/**
 * Pure geometry core for the buildable-envelope derivation.
 *
 * Given a parcel polygon ring (lng/lat) and a PER-EDGE inset distance (feet),
 * produce the inset ("buildable") ring via per-edge inward setback STRIPS,
 * unioned and differenced from the parcel (variable-distance inset). A uniform
 * negative buffer of the whole polygon is WRONG for setbacks — front/side/rear
 * differ — so each labeled edge is offset independently and composed with
 * boolean ops (polygon-clipping).
 *
 * Projection + validation are implemented with plain math over a local
 * equirectangular frame about the ring centroid. At parcel scale the distortion
 * is negligible and keeps the offset in metres.
 *
 * Kept free of I/O, Express, and road/geocode signals so the offset math is
 * unit-testable in isolation. Edge LABELING lives in edgeLabeling.ts.
 */

import polygonClipping from "polygon-clipping";

const FEET_PER_METER = 3.280839895;
const EARTH_RADIUS_M = 6_378_137;

/** Minimum edge length treated as survey noise when inferring front from shape. */
export const SURVEY_NOISE_THRESHOLD_M = 1.5;

export type LngLat = [number, number];

/** A closed ring: first === last coordinate. lng/lat (WGS84). */
export type Ring = LngLat[];

/** Local planar point in metres, relative to the projection origin. */
interface XY {
  x: number;
  y: number;
}

export interface ProjectedRing {
  /** Open ring (no duplicated closing vertex) in local metres, CCW-oriented. */
  points: XY[];
  originLng: number;
  originLat: number;
  /** metres-per-degree scale used, kept so we can invert exactly. */
  mPerDegLng: number;
  mPerDegLat: number;
}

export interface GeometryCorrectnessResult {
  pass: boolean;
  reasons: string[];
}

export function feetToMeters(ft: number): number {
  return ft / FEET_PER_METER;
}

export function metersToFeet(m: number): number {
  return m * FEET_PER_METER;
}

/**
 * Strip a closed ring's duplicated last vertex (if present) and any exact
 * consecutive duplicates, returning an "open" vertex list. Returns [] when the
 * input cannot form a polygon (fewer than 3 distinct vertices).
 */
export function openRing(ring: Ring): LngLat[] {
  const pts: LngLat[] = [];
  for (const c of ring) {
    if (
      !Array.isArray(c) ||
      c.length < 2 ||
      !Number.isFinite(c[0]) ||
      !Number.isFinite(c[1])
    ) {
      continue;
    }
    const last = pts[pts.length - 1];
    if (last && last[0] === c[0] && last[1] === c[1]) continue;
    pts.push([c[0], c[1]]);
  }
  if (
    pts.length > 1 &&
    pts[0]![0] === pts[pts.length - 1]![0] &&
    pts[0]![1] === pts[pts.length - 1]![1]
  ) {
    pts.pop();
  }
  return pts.length >= 3 ? pts : [];
}

/** Signed area (in local metres^2) of an open XY ring. Positive => CCW. */
function signedArea(points: XY[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const q = points[(i + 1) % points.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/**
 * Project a ring (lng/lat) into local metres about its centroid, orient CCW.
 * Returns null when the ring is degenerate (fewer than 3 distinct vertices).
 */
export function projectRing(ring: Ring): ProjectedRing | null {
  const open = openRing(ring);
  if (!open.length) return null;

  const originLng = open.reduce((s, p) => s + p[0], 0) / open.length;
  const originLat = open.reduce((s, p) => s + p[1], 0) / open.length;

  const latRad = (originLat * Math.PI) / 180;
  const mPerDegLat = (Math.PI / 180) * EARTH_RADIUS_M;
  const mPerDegLng = mPerDegLat * Math.cos(latRad);

  let points: XY[] = open.map(([lng, lat]) => ({
    x: (lng - originLng) * mPerDegLng,
    y: (lat - originLat) * mPerDegLat,
  }));

  if (signedArea(points) < 0) {
    points = points.slice().reverse();
  }

  return { points, originLng, originLat, mPerDegLng, mPerDegLat };
}

/** Invert a local XY point back to lng/lat. */
function unproject(p: XY, proj: ProjectedRing): LngLat {
  return [
    proj.originLng + p.x / proj.mPerDegLng,
    proj.originLat + p.y / proj.mPerDegLat,
  ];
}

/** Area (m^2) of a projected (CCW) ring. */
export function ringAreaM2(points: XY[]): number {
  return Math.abs(signedArea(points));
}

/**
 * Public: area in square feet of a lng/lat ring.
 */
export function ringAreaSqFt(ring: Ring): number {
  const proj = projectRing(ring);
  if (!proj) return 0;
  const m2 = ringAreaM2(proj.points);
  return m2 * FEET_PER_METER * FEET_PER_METER;
}

/** Project ring vertices into an existing parcel frame (metres). */
function projectRingInFrame(ring: Ring, frame: ProjectedRing): XY[] | null {
  const open = openRing(ring);
  if (!open.length) return null;
  return open.map(([lng, lat]) => ({
    x: (lng - frame.originLng) * frame.mPerDegLng,
    y: (lat - frame.originLat) * frame.mPerDegLat,
  }));
}

/** Unit inward normal (left of the CCW edge direction) for edge i -> i+1. */
function inwardNormal(a: XY, b: XY): XY | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  return { x: -dy / len, y: dx / len };
}

function closeClipRing(points: XY[]): polygonClipping.Ring {
  const ring: polygonClipping.Ring = points.map((p) => [p.x, p.y]);
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) {
    ring.push([first[0], first[1]]);
  }
  return ring;
}

function xyFromClipRing(ring: polygonClipping.Ring): XY[] {
  const open =
    ring.length > 1 &&
    ring[0]![0] === ring[ring.length - 1]![0] &&
    ring[0]![1] === ring[ring.length - 1]![1]
      ? ring.slice(0, -1)
      : ring.slice();
  return open.map(([x, y]) => ({ x, y }));
}

/**
 * Inward setback strip for one edge: the band between the boundary segment and
 * its parallel offset at distance d (metres) inside the parcel.
 */
function setbackStrip(a: XY, b: XY, nrm: XY, distM: number): polygonClipping.Polygon | null {
  if (distM <= 1e-9) return null;
  const aOff: XY = { x: a.x + nrm.x * distM, y: a.y + nrm.y * distM };
  const bOff: XY = { x: b.x + nrm.x * distM, y: b.y + nrm.y * distM };
  return [
    [
      [a.x, a.y],
      [b.x, b.y],
      [bOff.x, bOff.y],
      [aOff.x, aOff.y],
      [a.x, a.y],
    ],
  ];
}

/**
 * Union of the per-edge inward setback strips. Returns null when every edge
 * has a zero setback (no forbidden area at all). May throw when the boolean
 * union throws; callers convert that to an explicit clip-error, never to a
 * consume-lot verdict.
 */
function buildForbiddenStrips(
  pts: XY[],
  insetMetersPerEdge: number[],
): polygonClipping.MultiPolygon | null {
  const n = pts.length;
  let forbidden: polygonClipping.MultiPolygon | null = null;
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const nrm = inwardNormal(a, b);
    if (!nrm) continue;
    const strip = setbackStrip(a, b, nrm, insetMetersPerEdge[i]!);
    if (!strip) continue;
    forbidden = forbidden ? polygonClipping.union(forbidden, strip) : [strip];
  }
  return forbidden;
}

/** Deviation-from-straight beyond which a vertex is a reversal, degrees. */
const SPIKE_TURN_MAX_DEG = 160;
/** Max gap (m) between a spike's out-leg start and back-leg end. */
const SPIKE_MOUTH_MAX_M = 0.5;
/** Consecutive vertices closer than this collapse to one (m). */
const SPIKE_DUP_EPS_M = 0.05;

/**
 * Remove zero-width out-and-back excursions from a clip-output ring.
 *
 * On a curved frontage digitized as near-collinear chords, the per-edge strip
 * union leaves a sliver gap at each chord junction; the difference then emits
 * the buildable region with a degenerate spike running the full setback depth
 * back to the parcel boundary (observed live on 48453:280239: 7.61 m spikes at
 * every frontage junction, drawn by PE as perpendicular "ladder" strokes).
 * A spike encloses no area, so stripping it changes neither the area figure
 * nor the conservation gate; a genuinely pointed lot corner has a wide mouth
 * (prev->next distance) and is preserved. Returns the input unchanged when
 * nothing qualifies or when stripping would leave fewer than 3 vertices.
 */
export function stripReversalSpikes(points: XY[]): XY[] {
  if (points.length < 4) return points;
  const pts = points.slice();
  let removed = false;
  let changed = true;
  let guard = 0;
  while (changed && pts.length >= 4 && guard++ <= points.length + 8) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[(i - 1 + pts.length) % pts.length]!;
      const cur = pts[i]!;
      const next = pts[(i + 1) % pts.length]!;
      const ul = Math.hypot(cur.x - prev.x, cur.y - prev.y);
      const vl = Math.hypot(next.x - cur.x, next.y - cur.y);
      if (ul < SPIKE_DUP_EPS_M) {
        pts.splice(i, 1);
        removed = true;
        changed = true;
        break;
      }
      if (vl < 1e-9) continue; // next pass drops `next` as the duplicate.
      const cos =
        ((cur.x - prev.x) * (next.x - cur.x) + (cur.y - prev.y) * (next.y - cur.y)) /
        (ul * vl);
      const devDeg = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
      const mouth = Math.hypot(next.x - prev.x, next.y - prev.y);
      if (devDeg > SPIKE_TURN_MAX_DEG && mouth < SPIKE_MOUTH_MAX_M) {
        pts.splice(i, 1);
        removed = true;
        changed = true;
        break;
      }
    }
  }
  if (!removed || pts.length < 3) return points;
  return pts;
}

/**
 * Outcome of the boolean clip. "empty" is the ONLY outcome that supports a
 * consume-lot claim; "clip-error" is an instrument failure and must surface
 * as a validation decline, never as a measurement.
 */
type ClipOutcome =
  | {
      kind: "ok";
      points: XY[];
      forbidden: polygonClipping.MultiPolygon | null;
    }
  | { kind: "empty" }
  | { kind: "clip-error"; detail: string };

/**
 * Variable-distance inset via strip union + difference (polygon-clipping).
 *
 * `insetMetersPerEdge[i]` is the inward offset for edge i (vertex i -> i+1).
 * When the difference yields several pieces, the largest is kept (a parcel
 * pinched into disjoint buildable regions renders its dominant region).
 */
function insetProjected(
  proj: ProjectedRing,
  insetMetersPerEdge: number[],
): ClipOutcome {
  const pts = proj.points;
  const n = pts.length;
  if (n < 3 || insetMetersPerEdge.length !== n) {
    return { kind: "clip-error", detail: "edge/setback count mismatch" };
  }

  for (const d of insetMetersPerEdge) {
    if (!Number.isFinite(d) || d < 0) {
      return { kind: "clip-error", detail: "invalid setback distance" };
    }
  }

  const parcelPoly: polygonClipping.Polygon = [closeClipRing(pts)];

  let forbidden: polygonClipping.MultiPolygon | null;
  try {
    forbidden = buildForbiddenStrips(pts, insetMetersPerEdge);
  } catch {
    return { kind: "clip-error", detail: "setback strip union threw" };
  }

  if (!forbidden) {
    return {
      kind: "ok",
      points: pts.map((p) => ({ x: p.x, y: p.y })),
      forbidden: null,
    };
  }

  let diff: polygonClipping.MultiPolygon;
  try {
    diff = polygonClipping.difference(parcelPoly, forbidden);
  } catch {
    return { kind: "clip-error", detail: "parcel-minus-strips difference threw" };
  }
  if (!diff.length) return { kind: "empty" };

  let best: XY[] | null = null;
  let bestArea = 0;
  for (const poly of diff) {
    const outer = poly[0];
    if (!outer || outer.length < 4) continue;
    const open = xyFromClipRing(outer);
    if (open.length < 3) continue;
    const area = Math.abs(signedArea(open));
    if (area > bestArea) {
      bestArea = area;
      best = open;
    }
  }

  if (!best) return { kind: "empty" };
  // Clean degenerate zero-width excursions BEFORE the ring reaches callers:
  // the wire geometry, exports, and the conservation gate all see the same
  // spike-free ring (spikes carry no area, so the gate arithmetic is
  // unaffected either way).
  return { kind: "ok", points: stripReversalSpikes(best), forbidden };
}

/** Ray-cast point-in-polygon with an on-edge tolerance (local metres). */
function pointInOrOnPolygon(p: XY, poly: XY[], tol = 0.05): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    if (pointOnSegment(p, a, b, tol)) return true;
  }
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    const intersect =
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointOnSegment(p: XY, a: XY, b: XY, tol: number): boolean {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y) <= tol;
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * abx;
  const cy = a.y + t * aby;
  return Math.hypot(p.x - cx, p.y - cy) <= tol;
}

function segCrossProper(a: XY, b: XY, c: XY, d: XY): boolean {
  const cross = (o: XY, p: XY, q: XY) =>
    (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (
    ((d1 > 1e-12 && d2 < -1e-12) || (d1 < -1e-12 && d2 > 1e-12)) &&
    ((d3 > 1e-12 && d4 < -1e-12) || (d3 < -1e-12 && d4 > 1e-12))
  ) {
    return true;
  }
  return false;
}

function ringSelfIntersects(points: XY[]): boolean {
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) <= 1) continue;
      if (i === 0 && j === n - 1) continue;
      const c = points[j]!;
      const d = points[(j + 1) % n]!;
      if (segCrossProper(a, b, c, d)) return true;
    }
  }
  return false;
}

/** Area (m²) of one polygon-clipping polygon: |outer| minus |holes|. */
function clipPolygonAreaM2(poly: polygonClipping.Polygon): number {
  let area = 0;
  for (let r = 0; r < poly.length; r++) {
    const open = xyFromClipRing(poly[r]!);
    if (open.length < 3) continue;
    const a = Math.abs(signedArea(open));
    area += r === 0 ? a : -a;
  }
  return Math.max(0, area);
}

/** Total area (m²) of a polygon-clipping MultiPolygon. */
function multiPolygonAreaM2(
  mp: polygonClipping.MultiPolygon | null | undefined,
): number {
  if (!mp) return 0;
  let total = 0;
  for (const poly of mp) total += clipPolygonAreaM2(poly);
  return total;
}

/**
 * Epsilon for the conservation checks: max(0.5 m², 0.5% of parcel area).
 *
 * Why 0.5 m² absolute: polygon-clipping boolean ops at parcel scale (tens of
 * metres) leave float/boundary-sliver noise orders of magnitude below 1e-3
 * m², while 0.5 m² (~5.4 sq ft) is far below any buildable-area figure a
 * consumer would act on — so violations above it are real geometry defects,
 * not numerical noise. Why the 0.5% relative term: boundary-artifact area
 * scales with perimeter, so a fixed absolute bound would be too tight on
 * multi-acre parcels and meaninglessly loose is avoided by keeping it
 * proportional rather than unbounded.
 */
function conservationEpsilonM2(parcelAreaM2: number): number {
  return Math.max(0.5, parcelAreaM2 * 0.005);
}

/**
 * Conservation gate (P60b): validates a candidate inset ring against the
 * boolean-clip decomposition of the parcel — two independently derived
 * inputs, per the enforcement doctrine's meaning-shaped-check rule.
 *
 *  (a) exclusion: area(inset ∩ forbidden strips) < ε — no part of the inset
 *      may lie inside a setback strip;
 *  (b) conservation: area(parcel) = area(forbidden ∩ parcel) + Σ area(clip
 *      remainder) within ε, AND area(inset) must match the DOMINANT remainder
 *      piece within ε. (insetProjected intentionally keeps the largest piece
 *      when strips pinch the parcel into several buildable regions, so
 *      secondary pieces are accounted explicitly rather than absorbed into
 *      tolerance — together these imply the plain identity
 *      |area(parcel) − area(forbidden ∩ parcel) − area(inset)| < ε whenever
 *      the remainder is a single piece.)
 *
 * This replaces the retired proximity heuristics (ringHasSelfTouch's 8 cm
 * vertex-to-edge probe and perEdgeOffsetPlausible's midpoint probes), which
 * false-fired on centimetre notch artifacts from offsetting near-collinear
 * digitized edges and on probes landing in a NEIGHBORING edge's legitimate
 * strip (P60b forensics, parcel 48453:280239).
 */
function conservationFailures(
  parcelPts: XY[],
  insetPts: XY[],
  forbidden: polygonClipping.MultiPolygon | null,
): string[] {
  const failures: string[] = [];
  const parcelAreaM2 = ringAreaM2(parcelPts);
  const insetAreaM2 = ringAreaM2(insetPts);
  const eps = conservationEpsilonM2(parcelAreaM2);

  if (!forbidden) {
    if (Math.abs(parcelAreaM2 - insetAreaM2) >= eps) {
      failures.push(
        `zero-setback inset area ${insetAreaM2.toFixed(2)} m² does not match parcel ${parcelAreaM2.toFixed(2)} m²`,
      );
    }
    return failures;
  }

  const parcelPoly: polygonClipping.Polygon = [closeClipRing(parcelPts)];
  const insetPoly: polygonClipping.Polygon = [closeClipRing(insetPts)];

  let overlapM2: number;
  let forbiddenInParcelM2: number;
  let remainder: polygonClipping.MultiPolygon;
  try {
    overlapM2 = multiPolygonAreaM2(
      polygonClipping.intersection(insetPoly, forbidden),
    );
    forbiddenInParcelM2 = multiPolygonAreaM2(
      polygonClipping.intersection(forbidden, parcelPoly),
    );
    remainder = polygonClipping.difference(parcelPoly, forbidden);
  } catch {
    return ["conservation check could not run (boolean op threw)"];
  }

  if (overlapM2 >= eps) {
    failures.push(
      `inset overlaps forbidden setback strips by ${overlapM2.toFixed(2)} m² (ε ${eps.toFixed(2)})`,
    );
  }

  const remainderTotalM2 = multiPolygonAreaM2(remainder);
  let dominantPieceM2 = 0;
  for (const poly of remainder) {
    const a = clipPolygonAreaM2(poly);
    if (a > dominantPieceM2) dominantPieceM2 = a;
  }

  if (Math.abs(parcelAreaM2 - forbiddenInParcelM2 - remainderTotalM2) >= eps) {
    failures.push(
      `area conservation violated: parcel ${parcelAreaM2.toFixed(2)} m² != strips∩parcel ${forbiddenInParcelM2.toFixed(2)} m² + remainder ${remainderTotalM2.toFixed(2)} m² (ε ${eps.toFixed(2)})`,
    );
  }
  if (Math.abs(insetAreaM2 - dominantPieceM2) >= eps) {
    failures.push(
      `inset area ${insetAreaM2.toFixed(2)} m² does not match the clip's dominant remainder piece ${dominantPieceM2.toFixed(2)} m² (ε ${eps.toFixed(2)})`,
    );
  }

  return failures;
}

/** Classified rejection of a clip-produced inset. Null when the inset stands. */
type InsetRejection =
  | { kind: "consumed"; reason: string }
  | { kind: "validation-failed"; reason: string }
  | null;

/**
 * Post-clip validation. Genuine protections kept: orientation/winding, the
 * minimum-area sliver floor, true self-intersection (proper segment crossing,
 * not a proximity heuristic), containment inside the parcel, and the
 * conservation gate above. Only degenerate-by-area maps to "consumed"; every
 * other rejection is a validation failure and must never masquerade as a
 * consume-lot measurement.
 */
function classifyInset(
  orig: XY[],
  inset: XY[],
  forbidden: polygonClipping.MultiPolygon | null,
): InsetRejection {
  const origArea = signedArea(orig);
  const insetArea = signedArea(inset);
  if (insetArea <= 0) {
    return {
      kind: "validation-failed",
      reason: "inset orientation flipped or zero area",
    };
  }
  if (insetArea < origArea * 0.0025) {
    return {
      kind: "consumed",
      reason: "remaining area is a sliver below 0.25% of the parcel",
    };
  }
  if (ringSelfIntersects(inset)) {
    return { kind: "validation-failed", reason: "inset ring self-intersects" };
  }
  for (const p of inset) {
    if (!pointInOrOnPolygon(p, orig)) {
      return {
        kind: "validation-failed",
        reason: "inset vertex lies outside parcel",
      };
    }
  }
  const failures = conservationFailures(orig, inset, forbidden);
  if (failures.length) {
    return { kind: "validation-failed", reason: failures.join("; ") };
  }
  return null;
}

/**
 * Mechanical geometry-correctness gate (27c WDLL 2, reworked P60b). Exported
 * for CI regression tests — fails closed on orientation flip, true
 * self-intersection, containment violations, sliver collapse, and the
 * conservation checks (inset ∩ strips ≈ 0; inset area matches the recomputed
 * clip remainder). The retired 8 cm self-touch and midpoint-probe heuristics
 * are gone: they false-fired on legitimate insets of digitized rings.
 */
export function geometryCorrectnessGate(
  parcelRing: Ring,
  insetRing: Ring | null,
  insetFeetPerEdge: number[],
): GeometryCorrectnessResult {
  const reasons: string[] = [];
  if (!insetRing) {
    return { pass: false, reasons: ["inset ring is null"] };
  }
  const parcelProj = projectRing(parcelRing);
  if (!parcelProj) {
    return { pass: false, reasons: ["parcel or inset is not a valid polygon"] };
  }
  const orig = parcelProj.points;
  const inset = projectRingInFrame(insetRing, parcelProj);
  if (!inset || inset.length < 3) {
    return { pass: false, reasons: ["inset is not a valid polygon"] };
  }
  if (insetFeetPerEdge.length !== orig.length) {
    reasons.push(
      `edge/setback count mismatch (${insetFeetPerEdge.length} vs ${orig.length})`,
    );
  }
  if (signedArea(inset) <= 0) reasons.push("inset orientation flipped or zero area");
  if (ringSelfIntersects(inset)) reasons.push("inset ring self-intersects");
  for (const p of inset) {
    if (!pointInOrOnPolygon(p, orig, 0.12)) {
      reasons.push("inset vertex lies outside parcel");
      break;
    }
  }
  if (insetAreaTooSmall(orig, inset)) {
    reasons.push("inset collapsed to a sliver relative to parcel");
  }
  if (insetFeetPerEdge.length === orig.length) {
    const insetMeters = insetFeetPerEdge.map((ft) =>
      feetToMeters(Math.max(0, ft)),
    );
    let forbidden: polygonClipping.MultiPolygon | null;
    try {
      forbidden = buildForbiddenStrips(orig, insetMeters);
      reasons.push(...conservationFailures(orig, inset, forbidden));
    } catch {
      reasons.push("conservation check could not run (strip union threw)");
    }
  }
  return { pass: reasons.length === 0, reasons };
}

function insetAreaTooSmall(orig: XY[], inset: XY[]): boolean {
  const origArea = signedArea(orig);
  const insetArea = signedArea(inset);
  return insetArea < origArea * 0.0025;
}

/**
 * Machine-readable class of an empty inset result (P60b reason split):
 *  - "invalid-input": the parcel ring or setback array could not be used;
 *  - "consumed": the boolean clip itself returned empty or degenerate-by-area
 *    — the ONLY class that supports a "setbacks exceed the lot" claim;
 *  - "validation-failed": the clip produced a ring that the correctness /
 *    conservation gates rejected. A validation failure must surface as such,
 *    never masquerade as a consume-lot measurement.
 */
export type InsetEmptyKind = "invalid-input" | "consumed" | "validation-failed";

export interface InsetResult {
  ring: Ring | null;
  areaSqFt: number;
  parcelAreaSqFt: number;
  empty: boolean;
  emptyReason?: string;
  emptyKind?: InsetEmptyKind;
}

/**
 * Produce the buildable envelope for a parcel ring given a per-edge setback
 * distance in FEET. Preserves the public API; uses strip-union-difference
 * internally for variable-distance inset.
 */
export function insetPerEdge(
  ring: Ring,
  insetFeetPerEdge: number[],
): InsetResult {
  const proj = projectRing(ring);
  if (!proj) {
    return {
      ring: null,
      areaSqFt: 0,
      parcelAreaSqFt: 0,
      empty: true,
      emptyReason: "parcel geometry is not a valid polygon",
      emptyKind: "invalid-input",
    };
  }
  const parcelAreaSqFt =
    ringAreaM2(proj.points) * FEET_PER_METER * FEET_PER_METER;

  const n = proj.points.length;
  if (insetFeetPerEdge.length !== n) {
    return {
      ring: null,
      areaSqFt: 0,
      parcelAreaSqFt,
      empty: true,
      emptyReason: `edge/setback count mismatch (${insetFeetPerEdge.length} vs ${n})`,
      emptyKind: "invalid-input",
    };
  }

  if (insetFeetPerEdge.some((ft) => !Number.isFinite(ft))) {
    return {
      ring: null,
      areaSqFt: 0,
      parcelAreaSqFt,
      empty: true,
      emptyReason: "non-finite setback distance",
      emptyKind: "invalid-input",
    };
  }

  const insetMeters = insetFeetPerEdge.map((ft) =>
    feetToMeters(Math.max(0, ft)),
  );
  const clip = insetProjected(proj, insetMeters);
  if (clip.kind === "clip-error") {
    return {
      ring: null,
      areaSqFt: 0,
      parcelAreaSqFt,
      empty: true,
      emptyReason: `geometry validation failed (boolean clip error: ${clip.detail})`,
      emptyKind: "validation-failed",
    };
  }
  if (clip.kind === "empty") {
    return {
      ring: null,
      areaSqFt: 0,
      parcelAreaSqFt,
      empty: true,
      emptyReason: "setbacks exceed the lot — no buildable area remains",
      emptyKind: "consumed",
    };
  }

  const rejection = classifyInset(proj.points, clip.points, clip.forbidden);
  if (rejection) {
    if (rejection.kind === "consumed") {
      return {
        ring: null,
        areaSqFt: 0,
        parcelAreaSqFt,
        empty: true,
        emptyReason: `setbacks exceed the lot — no buildable area remains (${rejection.reason})`,
        emptyKind: "consumed",
      };
    }
    return {
      ring: null,
      areaSqFt: 0,
      parcelAreaSqFt,
      empty: true,
      emptyReason: `geometry validation failed (${rejection.reason})`,
      emptyKind: "validation-failed",
    };
  }

  const insetArea =
    ringAreaM2(clip.points) * FEET_PER_METER * FEET_PER_METER;
  const closed: Ring = clip.points.map((p) => unproject(p, proj));
  closed.push([closed[0]![0], closed[0]![1]]);

  const fullGate = geometryCorrectnessGate(ring, closed, insetFeetPerEdge);
  if (!fullGate.pass) {
    return {
      ring: null,
      areaSqFt: 0,
      parcelAreaSqFt,
      empty: true,
      emptyReason: `geometry validation failed (correctness gate: ${fullGate.reasons.join("; ")})`,
      emptyKind: "validation-failed",
    };
  }

  return {
    ring: closed,
    areaSqFt: insetArea,
    parcelAreaSqFt,
    empty: false,
  };
}
