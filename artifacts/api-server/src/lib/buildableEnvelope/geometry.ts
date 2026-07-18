/**
 * Pure geometry core for the buildable-envelope derivation.
 *
 * Given a parcel polygon ring (lng/lat) and a PER-EDGE inset distance (feet),
 * produce the inset ("buildable") ring by offsetting each edge inward by its
 * own distance and re-intersecting adjacent offset lines (a variable-distance
 * mitered inward offset). A uniform negative buffer of the whole polygon is
 * WRONG for setbacks — front/side/rear differ — so this offsets each labeled
 * edge independently.
 *
 * NO external geometry library is available in this repo (no turf/jsts), so the
 * projection + offset + line-intersection are implemented here with plain math
 * over a local equirectangular (equal-rectangular) projection about the ring
 * centroid. At parcel scale (tens to a few hundred metres) the equirectangular
 * distortion is negligible and lets us do the offset in metres.
 *
 * Kept free of I/O, Express, and the road/geocode signals so the offset math is
 * unit-testable in isolation. Edge LABELING (which edge is front/side/rear) is a
 * separate concern (see edgeLabeling.ts); this module consumes an already-
 * labeled per-edge distance array.
 */

const FEET_PER_METER = 3.280839895;
const EARTH_RADIUS_M = 6_378_137;

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
  // Drop a closing vertex equal to the first.
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

  const originLng =
    open.reduce((s, p) => s + p[0], 0) / open.length;
  const originLat =
    open.reduce((s, p) => s + p[1], 0) / open.length;

  const latRad = (originLat * Math.PI) / 180;
  // Local equirectangular scale (metres per degree) at the origin latitude.
  const mPerDegLat = (Math.PI / 180) * EARTH_RADIUS_M;
  const mPerDegLng = mPerDegLat * Math.cos(latRad);

  let points: XY[] = open.map(([lng, lat]) => ({
    x: (lng - originLng) * mPerDegLng,
    y: (lat - originLat) * mPerDegLat,
  }));

  // Orient CCW so the inward normal is a consistent left-turn of each edge.
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

/** Unit inward normal (left of the CCW edge direction) for edge i -> i+1. */
function inwardNormal(a: XY, b: XY): XY | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  // Left normal of (dx,dy) for a CCW ring points inward.
  return { x: -dy / len, y: dx / len };
}

/**
 * Intersect two infinite lines, each given as a point + direction. Returns null
 * when parallel (or nearly so).
 */
function lineIntersect(
  p: XY,
  dp: XY,
  q: XY,
  dq: XY,
): XY | null {
  const denom = dp.x * dq.y - dp.y * dq.x;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((q.x - p.x) * dq.y - (q.y - p.y) * dq.x) / denom;
  return { x: p.x + t * dp.x, y: p.y + t * dp.y };
}

export interface InsetResult {
  /** The inset ring as lng/lat (closed), or null when nothing is buildable. */
  ring: Ring | null;
  /** Buildable area in square feet (0 when empty). */
  areaSqFt: number;
  /** Original parcel area in square feet. */
  parcelAreaSqFt: number;
  /** True when the setbacks consume the whole lot (no buildable area). */
  empty: boolean;
  /** Why it is empty, when empty. */
  emptyReason?: string;
}

/**
 * Offset each edge of the (CCW) projected ring inward by its own distance
 * (metres), then re-intersect adjacent offset lines to get the new vertices.
 *
 * `insetMetersPerEdge[i]` is the inward offset for edge i (vertex i -> i+1).
 * The array length MUST equal points.length.
 */
function insetProjected(
  proj: ProjectedRing,
  insetMetersPerEdge: number[],
): { points: XY[] } | null {
  const pts = proj.points;
  const n = pts.length;
  if (n < 3 || insetMetersPerEdge.length !== n) return null;

  // Build each offset edge as (offsetPoint, direction).
  interface OffsetLine {
    p: XY;
    d: XY;
  }
  const offsetLines: (OffsetLine | null)[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const nrm = inwardNormal(a, b);
    if (!nrm) {
      offsetLines.push(null);
      continue;
    }
    const off = insetMetersPerEdge[i]!;
    const p: XY = { x: a.x + nrm.x * off, y: a.y + nrm.y * off };
    const d: XY = { x: b.x - a.x, y: b.y - a.y };
    offsetLines.push({ p, d });
  }

  // New vertex j is the intersection of offset line (j-1) and offset line (j).
  const out: XY[] = [];
  for (let j = 0; j < n; j++) {
    const prev = offsetLines[(j - 1 + n) % n];
    const cur = offsetLines[j];
    if (!prev || !cur) return null;
    const x = lineIntersect(prev.p, prev.d, cur.p, cur.d);
    if (!x) return null;
    out.push(x);
  }
  return { points: out };
}

/**
 * Detect whether the inset ring has collapsed or inverted: the offset lines can
 * cross, producing a ring whose orientation flipped (negative area for a
 * CCW-derived ring) or that self-intersects. A flipped/tiny ring means the
 * setbacks overran the lot along some axis — the envelope is empty.
 */
function insetIsDegenerate(orig: XY[], inset: XY[]): boolean {
  const origArea = signedArea(orig); // > 0 (CCW)
  const insetArea = signedArea(inset);
  // Orientation flipped => the offset lines crossed => no buildable area.
  if (insetArea <= 0) return true;
  // Collapsed to a sliver relative to the parcel.
  if (insetArea < origArea * 0.0025) return true;
  // Self-intersection check (any non-adjacent edge pair crossing).
  if (ringSelfIntersects(inset)) return true;
  // Containment: when the setback over-shoots an axis, the inset rectangle can
  // INVERT into a same-orientation mirror whose area is still positive but which
  // lies (partly) OUTSIDE the parcel. Every inset vertex must fall inside (or on)
  // the original ring; a vertex outside means the offset overran the lot.
  for (const p of inset) {
    if (!pointInOrOnPolygon(p, orig)) return true;
  }
  // Per-edge direction flip: an over-inset that mirrors an axis reverses that
  // edge's direction (the inset edge runs opposite the original). If ANY inset
  // edge reverses relative to its original edge, an axis collapsed — no
  // buildable area. This catches the symmetric mirror-rectangle case that stays
  // positive-area AND fully contained.
  const n = orig.length;
  for (let i = 0; i < n; i++) {
    const oa = orig[i]!;
    const ob = orig[(i + 1) % n]!;
    const ia = inset[i]!;
    const ib = inset[(i + 1) % n]!;
    const odx = ob.x - oa.x;
    const ody = ob.y - oa.y;
    const idx = ib.x - ia.x;
    const idy = ib.y - ia.y;
    // Opposite direction => negative dot product => that axis inverted.
    if (odx * idx + ody * idy < 0) return true;
  }
  return false;
}

/** Ray-cast point-in-polygon with an on-edge tolerance (local metres). */
function pointInOrOnPolygon(p: XY, poly: XY[]): boolean {
  const n = poly.length;
  // On-edge (within ~5 cm) counts as inside — offset vertices legitimately land
  // on the boundary for a zero-setback edge.
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    if (pointOnSegment(p, a, b, 0.05)) return true;
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

function segCross(a: XY, b: XY, c: XY, d: XY): boolean {
  const cross = (o: XY, p: XY, q: XY) =>
    (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
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
      // skip adjacent (share a vertex) and the wrap-around adjacency
      if (j === i) continue;
      if ((j + 1) % n === i) continue;
      if (i === (j + 1) % n) continue;
      if (Math.abs(i - j) <= 1) continue;
      const c = points[j]!;
      const d = points[(j + 1) % n]!;
      if (segCross(a, b, c, d)) return true;
    }
  }
  return false;
}

/**
 * Produce the buildable envelope for a parcel ring given a per-edge setback
 * distance in FEET. `insetFeetPerEdge[i]` is the setback applied to edge i
 * (vertex i -> i+1) of the OPENED ring (see openRing). Handles the empty case
 * (setbacks exceed the lot) honestly.
 *
 * Edge indexing note: the caller (edge labeling) must produce
 * `insetFeetPerEdge` aligned to the same opened+CCW ring this function derives
 * via projectRing. Use `projectRing(ring).points` to see that ordering.
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
    };
  }
  const parcelAreaSqFt = ringAreaM2(proj.points) * FEET_PER_METER * FEET_PER_METER;

  const n = proj.points.length;
  if (insetFeetPerEdge.length !== n) {
    return {
      ring: null,
      areaSqFt: 0,
      parcelAreaSqFt,
      empty: true,
      emptyReason: `edge/setback count mismatch (${insetFeetPerEdge.length} vs ${n})`,
    };
  }

  const insetMeters = insetFeetPerEdge.map((ft) =>
    feetToMeters(Math.max(0, ft)),
  );
  const insetXY = insetProjected(proj, insetMeters);
  if (!insetXY) {
    return {
      ring: null,
      areaSqFt: 0,
      parcelAreaSqFt,
      empty: true,
      emptyReason: "setbacks leave no buildable area (offset lines did not close)",
    };
  }

  if (insetIsDegenerate(proj.points, insetXY.points)) {
    return {
      ring: null,
      areaSqFt: 0,
      parcelAreaSqFt,
      empty: true,
      emptyReason: "setbacks exceed the lot — no buildable area remains",
    };
  }

  const insetArea = ringAreaM2(insetXY.points) * FEET_PER_METER * FEET_PER_METER;
  const closed: Ring = insetXY.points.map((p) => unproject(p, proj));
  // Close the ring.
  closed.push([closed[0]![0], closed[0]![1]]);

  return {
    ring: closed,
    areaSqFt: insetArea,
    parcelAreaSqFt,
    empty: false,
  };
}
