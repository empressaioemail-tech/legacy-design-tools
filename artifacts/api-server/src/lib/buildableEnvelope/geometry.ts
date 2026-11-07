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

/**
 * Ring cleaning before any inset (P-465). Stated tolerances:
 * - an edge shorter than {@link STUB_MAX_FT} feet is dropped when the dropped
 *   vertex already lies within {@link COLLINEAR_MERGE_MAX_FT} of the chord
 *   that replaces it;
 * - other vertices are dropped only by a Douglas-Peucker pass whose tolerance
 *   is {@link COLLINEAR_MERGE_MAX_FT} foot, so every original vertex stays
 *   within one foot of the cleaned ring.
 *
 * A turn-accumulation merge (10° steps, 45° accumulated) is not used. On the
 * CP3 census it replaced curved cadastral runs with chords tens to hundreds of
 * feet off the StratMap ring, and the inset of that chord drew outside the lot.
 * Grouping in edgeLabeling.ts is labeling-only and does not rewrite the ring.
 */
export const STUB_MAX_FT = 2;
/** Maximum distance, in feet, that cleaning may move the parcel boundary. */
export const COLLINEAR_MERGE_MAX_FT = 1;
/**
 * Second chord bound, used only when the one-foot ring's strip difference
 * does not complete. Measured on 48309:999666: 9,004 edges at one foot and
 * 7,002 edges at two feet threw inside polygon-clipping; 5,905 edges at
 * three feet drew. Three feet is not the ordinary tolerance.
 */
export const COLLINEAR_MERGE_RETRY_FT = 3;

function edgeLenM(a: XY, b: XY): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function pointSegDistM(p: XY, a: XY, b: XY): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-18) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
}

/**
 * Closed-ring Douglas–Peucker. Every input vertex stays within `tolM` of the
 * simplified ring. Returns the input when simplification would leave fewer
 * than 3 vertices.
 */
function simplifyRingWithin(pts: XY[], tolM: number): XY[] {
  if (pts.length <= 3) return pts;
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
  }
  cx /= pts.length;
  cy /= pts.length;
  let i0 = 0;
  let d0 = -1;
  for (let i = 0; i < pts.length; i++) {
    const d = Math.hypot(pts[i]!.x - cx, pts[i]!.y - cy);
    if (d > d0) {
      d0 = d;
      i0 = i;
    }
  }
  let i1 = 0;
  let d1 = -1;
  for (let i = 0; i < pts.length; i++) {
    const d = Math.hypot(pts[i]!.x - pts[i0]!.x, pts[i]!.y - pts[i0]!.y);
    if (d > d1) {
      d1 = d;
      i1 = i;
    }
  }
  if (i0 === i1) return pts;

  const chain = (from: number, to: number): XY[] => {
    const out: XY[] = [];
    let i = from;
    for (;;) {
      out.push(pts[i]!);
      if (i === to) break;
      i = (i + 1) % pts.length;
    }
    return out;
  };

  const dp = (span: XY[]): XY[] => {
    if (span.length <= 2) return span;
    const a = span[0]!;
    const b = span[span.length - 1]!;
    let maxD = 0;
    let idx = 0;
    for (let i = 1; i < span.length - 1; i++) {
      const d = pointSegDistM(span[i]!, a, b);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD <= tolM) return [a, b];
    const left = dp(span.slice(0, idx + 1));
    const right = dp(span.slice(idx));
    return [...left.slice(0, -1), ...right];
  };

  const merged = [
    ...dp(chain(i0, i1)).slice(0, -1),
    ...dp(chain(i1, i0)).slice(0, -1),
  ];
  return merged.length >= 3 ? merged : pts;
}

/**
 * Drop a vertex of a sub-2 ft edge only when it already lies within the chord
 * tolerance of its two neighbors. Independent (one pass), so a chain of nicks
 * cannot walk a bend off the lot; the sagitta pass then enforces the same
 * bound against the original vertices.
 */
function dropShortEdgesWithin(pts: XY[], tolM: number): XY[] {
  if (pts.length <= 3) return pts;
  const stubM = feetToMeters(STUB_MAX_FT);
  const n = pts.length;
  const keep = new Array<boolean>(n).fill(true);
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n]!;
    const cur = pts[i]!;
    const next = pts[(i + 1) % n]!;
    const short = edgeLenM(prev, cur) < stubM || edgeLenM(cur, next) < stubM;
    if (!short) continue;
    if (pointSegDistM(cur, prev, next) <= tolM) keep[i] = false;
  }
  const next = pts.filter((_, i) => keep[i]);
  return next.length >= 3 ? next : pts;
}

/**
 * Merge sub-2 ft nicks and collinear vertices that lie within one foot of the
 * replacing chord, then close the ring. Returns the input unchanged when the
 * ring is degenerate or cleaning would leave fewer than 3 vertices.
 */
function maxChordDeviationM(original: XY[], simplified: XY[]): number {
  let max = 0;
  const n = simplified.length;
  for (const p of original) {
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const d = pointSegDistM(p, simplified[i]!, simplified[(i + 1) % n]!);
      if (d < best) best = d;
    }
    if (best > max) max = best;
  }
  return max;
}

export function cleanParcelRing(
  ring: Ring,
  maxChordFt: number = COLLINEAR_MERGE_MAX_FT,
): Ring {
  const proj = projectRing(ring);
  if (!proj) return ring;
  const tolM = feetToMeters(maxChordFt);
  const stubbed = simplifyRingWithin(dropShortEdgesWithin(proj.points, tolM), tolM);
  // The stub pass drops against immediate neighbors. If that walked a bend
  // more than a foot off the served ring, discard it and simplify the
  // original vertices, which is bounded by the same tolerance.
  const cleaned =
    maxChordDeviationM(proj.points, stubbed) <= tolM + 1e-6
      ? stubbed
      : simplifyRingWithin(proj.points, tolM);
  if (cleaned.length < 3) return ring;
  const closed = cleaned.map((p) => unproject(p, proj));
  const first = closed[0]!;
  closed.push([first[0], first[1]]);
  return closed;
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

/**
 * Is a lng/lat point inside a lng/lat ring? Even-odd (ray-cast) crossing test,
 * the standard for a simple ring; a closed ring (first vertex repeated) and an
 * open one give the same answer, and a vertex-order reversal does not matter.
 *
 * P-339/P-366 residual (OPS-24, 2026-09-21). Added for the drawing route's
 * identity check: a posted point that pin-queries into a NEIGHBOURING envelope
 * is not evidence against the parcel the caller named when the point is also
 * inside that parcel's own ring. Measured on `48453:352594`: its record point
 * sits in a parcel of the Hays store while lying inside its own Travis ring,
 * because the two counties' parcel geometries overlap at the county line.
 */
export function ringContainsPoint(
  ring: Ring | null | undefined,
  point: { latitude: number; longitude: number } | LngLat,
): boolean {
  if (!ring || !ring.length) return false;
  const [lng, lat] = Array.isArray(point)
    ? point
    : [point.longitude, point.latitude];
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
  const open = openRing(ring);
  if (open.length < 3) return false;
  let inside = false;
  for (let i = 0, j = open.length - 1; i < open.length; j = i++) {
    const xi = open[i]![0]!;
    const yi = open[i]![1]!;
    const xj = open[j]![0]!;
    const yj = open[j]![1]!;
    const straddles = yi > lat !== yj > lat;
    if (!straddles) continue;
    const crossingLng = ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (lng < crossingLng) inside = !inside;
  }
  return inside;
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
 * Quantisation grid for the boolean RETRY below: 2^-26 m (about 15 nm).
 *
 * === Why the retry exists at all (P-372) ===
 *
 * polygon-clipping 0.15.7 dead-ends ("Unable to complete output ring starting
 * at [...]. Last matching segment found ends at [...].") when its two operands
 * share EXACT boundary geometry. That is not exotic here, it is the normal case:
 * each setback strip is anchored on the parcel's own vertices, so the union of
 * the strips passes exactly through every parcel vertex, and the union's outer
 * ring carries segments collinear with (and interior to) the parcel's own edges.
 * Measured on 48209:145880 (Kyle, R-1-A 25/10/15/10): all four parcel vertices
 * are bit-identical to vertices of the union's outer ring, four segments of that
 * ring are collinear with parcel edges, and `difference` threw — while both
 * operands are perfectly VALID rings and the difference is well defined (the
 * answer is the union's own hole; an independent rasterisation of the strips'
 * membership definition puts it at 310.536 m², and the library returns exactly
 * 310.536 m² the moment the operands are de-correlated). So this is a LIBRARY
 * robustness failure on valid input, not a bad ring: declining it would report
 * a gate failure about geometry that has no defect.
 *
 * === Why a grid, and why this grid ===
 *
 * Re-running the operation on both operands quantised onto a common grid
 * de-correlates them: the shared edges are no longer collinear and the shared
 * vertices are no longer identical, because the two operands reach their shared
 * values through different arithmetic. A power of two keeps `Math.round(v / g) *
 * g` EXACT — the snapped value is a representable double, so the snap adds no
 * error of its own beyond the grid step and is idempotent. At 2^-26 m a whole
 * parcel perimeter (hundreds of metres) moves the boolean's area arithmetic by
 * ~1e-6 m², six orders of magnitude below `conservationEpsilonM2`'s 0.5 m²
 * floor, eight below a square centimetre, and eight below the 0.03 m survey
 * noise `edgeLabeling` already tolerates. Both operands are quantised together
 * so the repair cannot bias the result toward either one.
 *
 * === What this is not ===
 *
 * It is a RETRY, not a guarantee: quantisation provably breaks the collinear
 * overlap (a shared segment gets a non-zero offset) but a shared VERTEX can
 * survive if both operands' values happen to land on the same grid point, so a
 * second failure is possible and is handled below by reporting the clip stage
 * as the stage that failed rather than dressing it up as a validation verdict.
 * It is attempted only AFTER the operation as constructed has thrown, so every
 * parcel that already derives keeps bit-identical output.
 */
/**
 * The retry grid, exported because it is a DECLARED tolerance: a caller (and a
 * test) may read it to bound what the repair can move. Worst-case displacement
 * of any coordinate is half a step, so the area a repair may shift is bounded by
 * (perimeter/2) x step — about 9e-7 m² on a 120 m parcel perimeter, six orders
 * below the conservation epsilon, which is why a repaired answer cannot pass
 * the gates by having drifted.
 */
export const BOOLEAN_RETRY_GRID_M = 2 ** -26;

/** One quantisation step onto the retry grid. Exact: the grid is a power of two. */
const activeRetryGridM = BOOLEAN_RETRY_GRID_M;
function snapToRetryGrid(v: number): number {
  return Math.round(v / activeRetryGridM) * activeRetryGridM;
}

/** Snap an open XY ring onto the retry grid, dropping vertices the snap merged. */
function snapXYRing(points: XY[]): XY[] {
  const out: XY[] = [];
  for (const p of points) {
    const x = snapToRetryGrid(p.x);
    const y = snapToRetryGrid(p.y);
    const last = out[out.length - 1];
    if (last && last.x === x && last.y === y) continue;
    out.push({ x, y });
  }
  while (
    out.length > 1 &&
    out[0]!.x === out[out.length - 1]!.x &&
    out[0]!.y === out[out.length - 1]!.y
  ) {
    out.pop();
  }
  return out;
}

/**
 * Snap a single-polygon operand (the difference's subject). Returns null when
 * the snap leaves fewer than a triangle's worth of vertices, which is itself a
 * reason to keep the unrepairable-clip verdict rather than to guess.
 */
function snapClipPolygon(
  poly: polygonClipping.Polygon,
): polygonClipping.Polygon | null {
  const rings: polygonClipping.Polygon = [];
  for (const ring of poly) {
    const snapped = snapXYRing(xyFromClipRing(ring));
    if (snapped.length >= 3) rings.push(closeClipRing(snapped));
  }
  return rings.length ? rings : null;
}

/** Snap every ring of a MultiPolygon operand; null when nothing usable survives. */
function snapMultiPolygon(
  mp: polygonClipping.MultiPolygon,
): polygonClipping.MultiPolygon | null {
  const out: polygonClipping.MultiPolygon = [];
  for (const poly of mp) {
    const snapped = snapClipPolygon(poly);
    if (snapped) out.push(snapped);
  }
  return out.length ? out : null;
}

type BooleanOperand = polygonClipping.Polygon | polygonClipping.MultiPolygon;

/**
 * Outcome of one boolean operation with the retry policy applied.
 * `repaired` is true only when the operation as constructed threw and the
 * quantised operands stood, so a caller can disclose the repair rather than
 * serve it silently.
 */
type BooleanAttempt<T> =
  | { ok: true; value: T; repaired: boolean; firstError?: string }
  | { ok: false; detail: string };

/**
 * Run ONE polygon-clipping operation, retrying once on quantised operands.
 *
 * The retry is `repair()` rather than an automatic snap because the two operand
 * shapes (single Polygon vs MultiPolygon) need different snapping, and because a
 * caller may have a healthier repair available. A null `repair()` — the snap
 * destroyed an operand — leaves the original error as the verdict. Both the
 * first error and the note that the retry also threw are kept in the detail,
 * because "the library was asked twice and could not" is a different fact from
 * "the library refused once".
 */
function booleanWithSnapRetry<T>(
  label: string,
  subject: BooleanOperand,
  clip: BooleanOperand,
  op: (a: BooleanOperand, b: BooleanOperand) => T,
  repair: () => { subject: BooleanOperand; clip: BooleanOperand } | null,
): BooleanAttempt<T> {
  try {
    return { ok: true, value: op(subject, clip), repaired: false };
  } catch (first) {
    const firstError = errorMessage(first);
    const snapped = repair();
    if (!snapped) {
      return {
        ok: false,
        detail: `${label} threw (${firstError}) and neither operand survived quantisation onto the ${BOOLEAN_RETRY_GRID_M} m retry grid`,
      };
    }
    try {
      return {
        ok: true,
        value: op(snapped.subject, snapped.clip),
        repaired: true,
        firstError,
      };
    } catch {
      return {
        ok: false,
        detail: `${label} threw (${firstError}) and threw again on both operands quantised to the ${BOOLEAN_RETRY_GRID_M} m retry grid`,
      };
    }
  }
}

/** The message of a thrown value, without assuming it is an Error. */
function errorMessage(e: unknown): string {
  const message = (e as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : String(e);
}

/**
 * Quarter-arc subdivision for a setback end cap. 15 segments over 90 degrees
 * (6 degrees per chord) puts the worst-case inscription shortfall at
 * d*(1-cos(3 deg)) = 0.00137*d — about 1 cm on a 25 ft setback, three orders of
 * magnitude below the defect it removes (P-235 measured a full-depth, 7.6 m
 * incursion) and far below any figure a consumer acts on.
 */
const SETBACK_JOIN_SEGMENTS = 15;

/**
 * Inward setback region for ONE edge: every point of the plane within `distM`
 * of the SEGMENT a->b, restricted to the inward half.
 *
 * This is the rectangular band between the segment and its parallel offset,
 * PLUS a quarter-arc end cap of radius `distM` at each endpoint. The caps are
 * not decoration: without them the per-edge regions are finite rectangles
 * whose end faces are perpendicular to their OWN edge direction, so wherever
 * consecutive ring edges differ in direction the two rectangles do not meet
 * (see `buildForbiddenStrips`).
 *
 * The arc is INSCRIBED (vertices exactly on the circle of radius `distM`), not
 * circumscribed. That matters: a circumscribed cap would reach `distM/cos` deep
 * at the normal direction and so bulge PAST the neighbouring rectangle on a
 * perfectly straight boundary, moving every straight-frontage envelope by a few
 * centimetres. Inscribed, the cap is a subset of the true disc and therefore a
 * provable no-op wherever the rectangles already meet or overlap.
 */
function setbackStadium(
  a: XY,
  b: XY,
  nrm: XY,
  distM: number,
  joinSegments: number = SETBACK_JOIN_SEGMENTS,
): polygonClipping.Polygon | null {
  if (distM <= 1e-9) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  const ux = dx / len;
  const uy = dy / len;

  const ring: [number, number][] = [
    [a.x, a.y],
    [b.x, b.y],
  ];
  // Cap at b: sweep from the edge direction (+u) round to the inward normal.
  for (let k = 1; k < joinSegments; k++) {
    const t = (k * Math.PI) / 2 / joinSegments;
    const c = Math.cos(t);
    const s = Math.sin(t);
    ring.push([
      b.x + distM * (ux * c + nrm.x * s),
      b.y + distM * (uy * c + nrm.y * s),
    ]);
  }
  ring.push([b.x + nrm.x * distM, b.y + nrm.y * distM]);
  ring.push([a.x + nrm.x * distM, a.y + nrm.y * distM]);
  // Cap at a: sweep from the inward normal round to the reverse direction (-u).
  for (let k = 1; k < joinSegments; k++) {
    const t = (k * Math.PI) / 2 / joinSegments;
    const c = Math.cos(t);
    const s = Math.sin(t);
    ring.push([
      a.x + distM * (nrm.x * c - ux * s),
      a.y + distM * (nrm.y * c - uy * s),
    ]);
  }
  ring.push([a.x, a.y]);
  return [ring];
}

/**
 * Union of the per-edge inward setback regions. Returns null when every edge
 * has a zero setback (no forbidden area at all). A union that throws is
 * reported as a detail string; callers convert that to an explicit clip-error,
 * never to a consume-lot verdict.
 *
 * `quantise` puts every strip on the retry grid (see BOOLEAN_RETRY_GRID_M): the
 * caller sets it only on the second attempt, after the as-constructed union or
 * the follow-on difference has thrown.
 *
 * === Why each edge contributes a capped stadium and not a bare rectangle ===
 *
 * P-235, parcel 48453:289990 (2407 Princeton Dr, Travis). Each edge used to
 * contribute only the rectangle between the segment and its parallel offset.
 * A rectangle's end faces are perpendicular to ITS OWN edge direction, so at a
 * shared ring vertex the two rectangles are mitred only by accident:
 *
 *   - at a CONVEX vertex (CCW left turn) they OVERLAP and the corner is
 *     covered, which is why this went unnoticed for so long;
 *   - at a REFLEX vertex (CCW right turn, interior angle > 180 deg — the shape
 *     a frontage takes when the parcel sits on the OUTSIDE of a street curve)
 *     they splay apart, leaving an uncovered wedge whose APEX IS ON THE
 *     PARCEL BOUNDARY and which extends the full setback depth.
 *
 * The parcel-minus-forbidden difference then emits that wedge as part of the
 * buildable region, so the drawn envelope runs all the way back to the front
 * property line. Measured on 48453:289990 with Austin SF-3 (25/5/10):
 * 0.052 m² uncovered in two slivers, each touching the boundary (0.0000 m),
 * the larger 7.62 m deep at the frontage — the whole front setback.
 *
 * `stripReversalSpikes` below was built for this shape and does not catch it:
 * it removes ONE vertex per pass and tests the mouth between that vertex's
 * immediate neighbours, so a sliver carrying an intermediate vertex on either
 * leg reads as a 6-7 m mouth and is preserved. It is a draw-time cosmetic and
 * was never the fix; this is.
 *
 * The forbidden region is now exactly `{p : dist(p, edge_i) <= d_i}` unioned
 * over edges — the literal reading of "no structure within d feet of the
 * property line" — rather than an approximation of it that happens to be
 * right only at convex corners. Round (not mitred) joins are what that
 * definition produces: a mitre would forbid points MORE than d from every
 * boundary segment, which the ordinance permits, and is unbounded at a sharp
 * reflex notch.
 */
function unionStrips(
  strips: polygonClipping.Polygon[],
): { forbidden: polygonClipping.MultiPolygon } | { detail: string } {
  if (strips.length === 0) return { forbidden: [] };
  // Ordinary lots keep the left-fold. A ring of hundreds of edges makes that
  // fold quadratic (48309:999666, about ten thousand edges, did not finish).
  // Those union in a balanced tree. Union is the same region either way;
  // only the library's operation order changes, and only past this count.
  if (strips.length <= 48) {
    let forbidden: polygonClipping.MultiPolygon = [strips[0]!];
    for (let i = 1; i < strips.length; i++) {
      try {
        forbidden = polygonClipping.union(forbidden, strips[i]!);
      } catch (e) {
        return { detail: `setback strip union threw (${errorMessage(e)})` };
      }
    }
    return { forbidden };
  }
  let level: polygonClipping.MultiPolygon[] = strips.map((strip) => [strip]);
  while (level.length > 1) {
    const next: polygonClipping.MultiPolygon[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1];
      if (!right) {
        next.push(left);
        continue;
      }
      try {
        next.push(polygonClipping.union(left, right));
      } catch (e) {
        return { detail: `setback strip union threw (${errorMessage(e)})` };
      }
    }
    level = next;
  }
  return { forbidden: level[0] ?? [] };
}

function buildForbiddenStrips(
  pts: XY[],
  insetMetersPerEdge: number[],
  quantise: boolean,
): { forbidden: polygonClipping.MultiPolygon | null } | { detail: string } {
  const n = pts.length;
  // A multi-thousand-edge ring (48309:999666, 9,004 edges after the one-foot
  // clean, 61 miles of boundary) does not finish when every edge carries a
  // 15-segment round cap. On a boundary that dense the neighbouring rectangles
  // already cover the corner disc to well under a foot, so the cap is omitted.
  const joinSegments = n > 2000 ? 1 : SETBACK_JOIN_SEGMENTS;
  const strips: polygonClipping.Polygon[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const nrm = inwardNormal(a, b);
    if (!nrm) continue;
    const built = setbackStadium(a, b, nrm, insetMetersPerEdge[i]!, joinSegments);
    if (!built) continue;
    const strip = quantise ? snapClipPolygon(built) : built;
    if (!strip) continue;
    strips.push(strip);
  }
  if (strips.length === 0) return { forbidden: null };
  const unioned = unionStrips(strips);
  if ("detail" in unioned) return unioned;
  return { forbidden: unioned.forbidden };
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
 * The clip as ONE attempt saw it. "empty" is the ONLY outcome that supports a
 * consume-lot claim; "threw" is an instrument failure at the boolean layer and
 * is what the retry policy below acts on — never a measurement.
 *
 * `parcelPoints` travels with the attempt because the retry quantises the
 * SUBJECT as well as the clip, and a later consumer must validate the subject
 * the clip actually stood on rather than the one as served. (`classifyInset`
 * takes it directly below; the exported `geometryCorrectnessGate` still receives
 * the ring as served, because its own retry reaches the same quantised subject
 * — see `correctnessReasons` — and because that gate's signature is part of the
 * CI regression surface.)
 */
type ClipAttempt =
  | {
      kind: "ok";
      points: XY[];
      forbidden: polygonClipping.MultiPolygon | null;
      parcelPoints: XY[];
    }
  | {
      kind: "empty";
      forbidden: polygonClipping.MultiPolygon | null;
      parcelPoints: XY[];
    }
  | { kind: "threw"; detail: string };

/**
 * Record that the clip only stood after both operands were quantised onto the
 * retry grid. Carried out of the clip so it can be disclosed (never served
 * silently) and so the conservation gate validates the repaired operands.
 */
export type ClipRepair = {
  /** The quantisation grid the retry used, in metres. */
  gridM: number;
  /** The failure the as-constructed attempt threw, verbatim. */
  firstError: string;
};

/** Outcome of the boolean clip, after the retry policy has had its one retry. */
type ClipOutcome =
  | {
      kind: "ok";
      points: XY[];
      forbidden: polygonClipping.MultiPolygon | null;
      parcelPoints: XY[];
      repair: ClipRepair | null;
    }
  | {
      kind: "empty";
      forbidden: polygonClipping.MultiPolygon | null;
      parcelPoints: XY[];
      repair: ClipRepair | null;
    }
  | { kind: "clip-error"; detail: string; repair: ClipRepair | null };

/**
 * ONE pass of the clip: strip union then parcel-minus-strips difference, with
 * every operand either as constructed or quantised onto the retry grid.
 *
 * Variable-distance inset via strip union + difference (polygon-clipping).
 * `insetMetersPerEdge[i]` is the inward offset for edge i (vertex i -> i+1).
 * When the difference yields several pieces, the largest is kept (a parcel
 * pinched into disjoint buildable regions renders its dominant region).
 */
function clipAttempt(
  parcelPoints: XY[],
  insetMetersPerEdge: number[],
  quantise: boolean,
): ClipAttempt {
  const pts = quantise ? snapXYRing(parcelPoints) : parcelPoints;
  if (pts.length < 3) {
    return {
      kind: "threw",
      detail: `the parcel ring did not survive quantisation onto the ${BOOLEAN_RETRY_GRID_M} m retry grid`,
    };
  }

  const strips = buildForbiddenStrips(pts, insetMetersPerEdge, quantise);
  if ("detail" in strips) return { kind: "threw", detail: strips.detail };
  const forbidden = strips.forbidden;

  if (!forbidden) {
    return {
      kind: "ok",
      points: pts.map((p) => ({ x: p.x, y: p.y })),
      forbidden: null,
      parcelPoints: pts,
    };
  }

  const parcelPoly: polygonClipping.Polygon = [closeClipRing(pts)];
  let diff: polygonClipping.MultiPolygon;
  try {
    diff = polygonClipping.difference(parcelPoly, forbidden);
  } catch (e) {
    return {
      kind: "threw",
      detail: `parcel-minus-strips difference threw (${errorMessage(e)})`,
    };
  }
  if (!diff.length) return { kind: "empty", forbidden, parcelPoints: pts };

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

  if (!best) return { kind: "empty", forbidden, parcelPoints: pts };
  // Clean degenerate zero-width excursions BEFORE the ring reaches callers:
  // the wire geometry, exports, and the conservation gate all see the same
  // spike-free ring (spikes carry no area, so the gate arithmetic is
  // unaffected either way).
  return {
    kind: "ok",
    points: stripReversalSpikes(best),
    forbidden,
    parcelPoints: pts,
  };
}

/**
 * The clip with its retry policy: run it as constructed, and only if that
 * THROWS, run it once more with every operand quantised onto the retry grid
 * (see BOOLEAN_RETRY_GRID_M for why that de-correlates the operands, and why it
 * is a retry rather than a guarantee).
 *
 * A parcel that already derives takes the first branch and is bit-identical to
 * its pre-P-372 output. A parcel that only derives on the repaired operands
 * comes back with `repair` set, so the repair travels with the answer instead of
 * being invisible. When both attempts throw, the failure is reported as a
 * CLIP-stage refusal carrying both errors — it is never dressed up as a
 * validation verdict, because no validation ran.
 */
function insetProjected(
  proj: ProjectedRing,
  insetMetersPerEdge: number[],
): ClipOutcome {
  const pts = proj.points;
  const n = pts.length;
  if (n < 3 || insetMetersPerEdge.length !== n) {
    return { kind: "clip-error", detail: "edge/setback count mismatch", repair: null };
  }

  for (const d of insetMetersPerEdge) {
    if (!Number.isFinite(d) || d < 0) {
      return { kind: "clip-error", detail: "invalid setback distance", repair: null };
    }
  }

  const first = clipAttempt(pts, insetMetersPerEdge, false);
  if (first.kind !== "threw") return { ...first, repair: null };

  const retry = clipAttempt(pts, insetMetersPerEdge, true);
  if (retry.kind === "threw") {
    return {
      kind: "clip-error",
      detail: `${first.detail}; retried with both operands quantised to the ${BOOLEAN_RETRY_GRID_M} m grid and ${retry.detail}`,
      repair: null,
    };
  }
  return {
    ...retry,
    repair: { gridM: BOOLEAN_RETRY_GRID_M, firstError: first.detail },
  };
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
  if (n < 4) return false;
  // Parcel rings of several thousand vertices make the naive pair loop
  // dominate the draw (measured on 48309:999666, 13k vertices). Segments are
  // bucketed by a 20 m grid; a proper crossing lies in a cell both bboxes
  // cover, so the pair set is the same as the full loop.
  const cell = 20;
  const buckets = new Map<number, number[]>();
  const pack = (ix: number, iy: number) => ix * 73856093 + iy;
  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    const minx = Math.floor(Math.min(a.x, b.x) / cell);
    const maxx = Math.floor(Math.max(a.x, b.x) / cell);
    const miny = Math.floor(Math.min(a.y, b.y) / cell);
    const maxy = Math.floor(Math.max(a.y, b.y) / cell);
    for (let ix = minx; ix <= maxx; ix++) {
      for (let iy = miny; iy <= maxy; iy++) {
        const k = pack(ix, iy);
        const arr = buckets.get(k);
        if (arr) arr.push(i);
        else buckets.set(k, [i]);
      }
    }
  }
  const seen = new Set<number>();
  for (const arr of buckets.values()) {
    for (let p = 0; p < arr.length; p++) {
      const i = arr[p]!;
      const a = points[i]!;
      const b = points[(i + 1) % n]!;
      for (let q = p + 1; q < arr.length; q++) {
        const j = arr[q]!;
        if (Math.abs(i - j) <= 1) continue;
        if ((i === 0 && j === n - 1) || (j === 0 && i === n - 1)) continue;
        const lo = i < j ? i : j;
        const hi = i < j ? j : i;
        const id = lo * n + hi;
        if (seen.has(id)) continue;
        seen.add(id);
        const c = points[j]!;
        const d = points[(j + 1) % n]!;
        if (segCrossProper(a, b, c, d)) return true;
      }
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
type ConservationCheck =
  | { kind: "ran"; failures: string[] }
  /**
   * The boolean layer itself could not complete — an INSTRUMENT failure, never
   * a finding about the geometry. Kept as its own shape since P-372 so a caller
   * can retry the operation (the clip does) instead of reporting a violation.
   */
  | { kind: "could-not-run"; reason: string };

function conservationFailures(
  parcelPts: XY[],
  insetPts: XY[],
  forbidden: polygonClipping.MultiPolygon | null,
  quantise: boolean,
): ConservationCheck {
  const failures: string[] = [];
  // Validate the operand set the clip actually stood on. When the clip needed
  // the retry, the gate must be handed the quantised copies too: it re-runs the
  // SAME difference, so a gate left on the as-constructed operands would throw
  // exactly where the clip just threw, and would report a clip failure as a
  // validation failure — the mis-staging P-372 exists to remove.
  const parcel = quantise ? snapXYRing(parcelPts) : parcelPts;
  const inset = quantise ? snapXYRing(insetPts) : insetPts;
  const strips = quantise && forbidden ? snapMultiPolygon(forbidden) : forbidden;
  if (quantise && forbidden && !strips) {
    return {
      kind: "could-not-run",
      reason: "the strip union vanished under quantisation",
    };
  }

  const parcelAreaM2 = ringAreaM2(parcel);
  const insetAreaM2 = ringAreaM2(inset);
  const eps = conservationEpsilonM2(parcelAreaM2);

  if (!strips) {
    if (Math.abs(parcelAreaM2 - insetAreaM2) >= eps) {
      failures.push(
        `zero-setback inset area ${insetAreaM2.toFixed(2)} m² does not match parcel ${parcelAreaM2.toFixed(2)} m²`,
      );
    }
    return { kind: "ran", failures };
  }

  const parcelPoly: polygonClipping.Polygon = [closeClipRing(parcel)];
  const insetPoly: polygonClipping.Polygon = [closeClipRing(inset)];

  let overlapM2: number;
  let forbiddenInParcelM2: number;
  let remainder: polygonClipping.MultiPolygon;
  // `stage` names WHICH boolean could not run, so the reason can say so instead
  // of the old blanket "boolean op threw".
  let stage = "intersection(inset ∩ strips)";
  try {
    overlapM2 = multiPolygonAreaM2(
      polygonClipping.intersection(insetPoly, strips),
    );
    stage = "intersection(strips ∩ parcel)";
    forbiddenInParcelM2 = multiPolygonAreaM2(
      polygonClipping.intersection(strips, parcelPoly),
    );
    stage = "difference(parcel - strips)";
    remainder = polygonClipping.difference(parcelPoly, strips);
  } catch (e) {
    return {
      kind: "could-not-run",
      reason: `${stage} threw: ${errorMessage(e)}`,
    };
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

  return { kind: "ran", failures };
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
  quantise: boolean,
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
  // The clip already produced a ring. polygon-clipping still dead-ends on the
  // conservation booleans when a strip shares the parcel boundary (P-372): the
  // two reported ends can be a fraction of a millimetre apart. The clip retries
  // that case on the quantised grid; this gate must do the same before it
  // declines a ring the clip accepted. A retry that still cannot run, or that
  // runs and finds a real overlap, stays a validation failure.
  let conservation = conservationFailures(orig, inset, forbidden, quantise);
  if (conservation.kind === "could-not-run" && !quantise) {
    conservation = conservationFailures(orig, inset, forbidden, true);
  }
  if (conservation.kind === "could-not-run") {
    return {
      kind: "validation-failed",
      reason: `conservation check could not run (${conservation.reason})`,
    };
  }
  if (conservation.failures.length) {
    return { kind: "validation-failed", reason: conservation.failures.join("; ") };
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
 *
 * P-372: the boolean-bearing half is run under the clip's own retry policy
 * (operands as constructed, then quantised onto BOOLEAN_RETRY_GRID_M). Without
 * it this gate re-derives the same strips and re-runs the same difference that
 * the clip just needed the retry for, so a repaired clip would be failed here by
 * the identical operation — reporting a library limitation as a geometry
 * defect. When both operand sets fail to run, that is stated as such and is
 * still a `pass: false`: the gate never silently passes.
 */
export function geometryCorrectnessGate(
  parcelRing: Ring,
  insetRing: Ring | null,
  insetFeetPerEdge: number[],
): GeometryCorrectnessResult {
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

  const asBuilt = correctnessReasons(orig, inset, insetFeetPerEdge, false);
  if (asBuilt) return { pass: asBuilt.length === 0, reasons: asBuilt };

  const repaired = correctnessReasons(orig, inset, insetFeetPerEdge, true);
  if (repaired) return { pass: repaired.length === 0, reasons: repaired };

  return {
    pass: false,
    reasons: [
      `the boolean layer could not run on the operands as constructed or quantised to the ${BOOLEAN_RETRY_GRID_M} m retry grid`,
    ],
  };
}

/**
 * The gate's reason list for ONE operand set, or null when the boolean layer
 * could not run on it (the caller retries quantised before reporting).
 */
function correctnessReasons(
  orig: XY[],
  inset: XY[],
  insetFeetPerEdge: number[],
  quantise: boolean,
): string[] | null {
  const parcel = quantise ? snapXYRing(orig) : orig;
  const candidate = quantise ? snapXYRing(inset) : inset;
  if (parcel.length < 3 || candidate.length < 3) return null;

  const reasons: string[] = [];
  if (insetFeetPerEdge.length !== parcel.length) {
    reasons.push(
      `edge/setback count mismatch (${insetFeetPerEdge.length} vs ${parcel.length})`,
    );
  }
  if (signedArea(candidate) <= 0) reasons.push("inset orientation flipped or zero area");
  if (ringSelfIntersects(candidate)) reasons.push("inset ring self-intersects");
  for (const p of candidate) {
    if (!pointInOrOnPolygon(p, parcel, 0.12)) {
      reasons.push("inset vertex lies outside parcel");
      break;
    }
  }
  if (insetAreaTooSmall(parcel, candidate)) {
    reasons.push("inset collapsed to a sliver relative to parcel");
  }
  if (insetFeetPerEdge.length === parcel.length) {
    const insetMeters = insetFeetPerEdge.map((ft) =>
      feetToMeters(Math.max(0, ft)),
    );
    const strips = buildForbiddenStrips(parcel, insetMeters, quantise);
    if ("detail" in strips) return null;
    const conservation = conservationFailures(
      parcel,
      candidate,
      strips.forbidden,
      quantise,
    );
    if (conservation.kind === "could-not-run") return null;
    reasons.push(...conservation.failures);
  }
  return reasons;
}

function insetAreaTooSmall(orig: XY[], inset: XY[]): boolean {
  const origArea = signedArea(orig);
  const insetArea = signedArea(inset);
  return insetArea < origArea * 0.0025;
}

/**
 * Machine-readable class of an empty inset result (P60b reason split, extended
 * by P-372):
 *  - "invalid-input": the parcel ring or setback array could not be used;
 *  - "consumed": the boolean clip itself returned empty or degenerate-by-area
 *    — the ONLY class that supports a "setbacks exceed the lot" claim;
 *  - "validation-failed": the clip produced a ring that the correctness /
 *    conservation gates rejected. A validation failure must surface as such,
 *    never masquerade as a consume-lot measurement;
 *  - "clip-failed" (P-372): the boolean CLIP could not be executed at all, on
 *    the operands as constructed or on their quantised retry — an INSTRUMENT
 *    failure. Distinct from "validation-failed" because no gate ever judged a
 *    ring: reporting a library that could not subtract a valid parcel from a
 *    valid strip union as a "geometry validation failure" tells the reader a
 *    verdict was reached about geometry that has no defect. (Before P-372 this
 *    case arrived as `emptyKind: "validation-failed"` with a reason whose own
 *    text said "boolean clip error" — the reason already knew, the class did
 *    not, and the wire only carried the class.)
 */
export type InsetEmptyKind =
  | "invalid-input"
  | "consumed"
  | "validation-failed"
  | "clip-failed";

export interface InsetResult {
  ring: Ring | null;
  areaSqFt: number;
  parcelAreaSqFt: number;
  empty: boolean;
  emptyReason?: string;
  emptyKind?: InsetEmptyKind;
  /**
   * Present when the clip only stood after both operands were quantised onto
   * the retry grid (see BOOLEAN_RETRY_GRID_M). Not a customer-facing fact — it
   * moves a figure by ~1e-6 m² — but it must be countable, so a caller can
   * report how often this engine depends on the repair instead of the repair
   * being invisible.
   */
  clipRepair?: ClipRepair;
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

  // P-372: a parcel ring that CROSSES ITSELF is not a boundary, and the honest
  // place to say so is here rather than at the boolean layer. Measured on a
  // bowtie fixture: the clip throws on both the as-constructed and the
  // quantised operands, so the payload used to decline as a clip failure —
  // naming a library that refused a ring which is itself the defect. This is a
  // proper-crossing test (segCrossProper), so the exact-touch and near-collinear
  // vertices digitized cadastral rings legitimately carry do not trip it.
  if (ringSelfIntersects(proj.points)) {
    return {
      ring: null,
      areaSqFt: 0,
      parcelAreaSqFt,
      empty: true,
      emptyReason:
        "parcel ring self-intersects — the served polygon is not a valid boundary",
      emptyKind: "invalid-input",
    };
  }

  const clip = insetProjected(proj, insetMeters);
  if (clip.kind === "clip-error") {
    return {
      ring: null,
      areaSqFt: 0,
      parcelAreaSqFt,
      empty: true,
      // P-372: the CLIP stage names itself. The reason says which operation
      // threw and that the quantised retry also ran and also threw, so a reader
      // can tell "the boolean library could not subtract these operands" from
      // "the ring failed a gate" without guessing.
      emptyReason: `geometry clip failed — no ring was produced to validate (${clip.detail})`,
      emptyKind: "clip-failed",
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

  const rejection = classifyInset(
    clip.parcelPoints,
    clip.points,
    clip.forbidden,
    clip.repair !== null,
  );
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
      ...(clip.repair ? { clipRepair: clip.repair } : {}),
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
      ...(clip.repair ? { clipRepair: clip.repair } : {}),
    };
  }

  return {
    ring: closed,
    areaSqFt: insetArea,
    parcelAreaSqFt,
    empty: false,
    ...(clip.repair ? { clipRepair: clip.repair } : {}),
  };
}
