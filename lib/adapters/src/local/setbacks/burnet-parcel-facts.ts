/**
 * Parcel facts the Burnet per-parcel setback resolver (burnet-parcel-setbacks.ts) evaluates from data
 * (OPS-24 stage 6, 2026-10-13). Each measurement returns an explicit "undetermined" state when the
 * data cannot settle the condition; the resolver then serves the ordinance's rule with its
 * condition instead of a number. Pure functions over GeoJSON (WGS84 lon/lat); no I/O.
 *
 * 1. WATER ADJACENCY (Marble Falls Table 4.3.1.B note 1, "adjacent to Lake Marble Falls"; Horseshoe
 *    Bay § 14.02.402(b)(15)(U) "waterfront lots" and the "contiguous with the shoreline" height text,
 *    Lake LBJ). Measured against the USGS NHD High Resolution waterbody polygon for the named lake
 *    (./water/nhd-*.json, vendored by scripts/vendor-nhd-lakes.mjs). NHD High Resolution is compiled
 *    at 1:24,000 (90% of well-defined points within 12.2 m), and parcel lines carry their own error,
 *    so the shoreline position is uncertain by tens of metres. The bands are therefore:
 *      adjacent      -- the parcel polygon intersects the lake polygon (it reaches the mapped water);
 *      not-adjacent  -- the parcel is at least WATER_NOT_ADJACENT_MIN_M (60 m, about five times the
 *                       NHD 90% figure) from the lake polygon: no parcel that far from the mapped
 *                       water can share a boundary with the lake;
 *      undetermined  -- anything in between (a lot whose line stops short of the mapped shoreline,
 *                       or one across a street from it). The resolver serves both branches.
 *    Distances are measured on a local equirectangular projection around the parcel (error well
 *    under 0.1% at these distances).
 *
 * 2. LOT WIDTH (Marble Falls Table 4.2.6.A, whose rows are keyed by "Min. Lot Width"). The ordinance
 *    measures lot width along a line pack E does not define (pack F task 4 asks for the definition),
 *    so this does not pick an orientation. For a lot whose polygon fills at least
 *    LOT_WIDTH_MIN_RECTANGULARITY (0.9) of its minimum-area bounding rectangle, any reasonable
 *    lot-width line lies between the rectangle's short side and long side, so the lot width is
 *    bounded to [short - margin, long + margin] (LOT_WIDTH_MARGIN_FT = 1 ft for line-work error). A
 *    Table 4.2.6.A row is kept only if its width band intersects that interval. An irregular or
 *    multi-part lot gets no interval (every row is kept).
 *
 * 3. CAD CLASS (building type). The Texas Comptroller (PTAD) state property category letter of the
 *    parcel's CAD `property_use_code` (cad_property, latest tax year). Only category F (commercial
 *    and industrial real property) is used to narrow a Marble Falls district to its Table 4.3.1.B
 *    nonresidential row, and only categories A (single-family residential), B (multifamily) and M
 *    (mobile homes) to drop that row. CAD sub-codes (A1, B2, F7 ...) are county-local and are NOT
 *    read as a particular ordinance building type.
 */
import lakeMarbleFalls from "./water/nhd-lake-marble-falls.json" with { type: "json" };
import lakeLbj from "./water/nhd-lake-lbj.json" with { type: "json" };

export type Position = [number, number];
export interface PolygonGeometry {
  type: "Polygon";
  coordinates: Position[][];
}
export interface MultiPolygonGeometry {
  type: "MultiPolygon";
  coordinates: Position[][][];
}
export type ParcelGeometry = PolygonGeometry | MultiPolygonGeometry;

export const WATER_NOT_ADJACENT_MIN_M = 60;
export const LOT_WIDTH_MIN_RECTANGULARITY = 0.9;
export const LOT_WIDTH_MARGIN_FT = 1;
const FT_PER_M = 1 / 0.3048;

export type LakeKey = "lake-marble-falls" | "lake-lbj";

interface VendoredLake {
  key: string;
  name: string;
  geometry: PolygonGeometry;
}

const LAKES: Record<LakeKey, VendoredLake> = {
  "lake-marble-falls": lakeMarbleFalls as unknown as VendoredLake,
  "lake-lbj": lakeLbj as unknown as VendoredLake,
};

export function lakeName(key: LakeKey): string {
  return LAKES[key].name;
}

/* --------------------------------- planar helpers --------------------------------- */

interface Projector {
  (p: Position): [number, number];
}

/** Metres per degree at `lat` (WGS84 series), for a local equirectangular projection. */
function projectorAt(lon0: number, lat0: number): Projector {
  const phi = (lat0 * Math.PI) / 180;
  const mPerDegLat = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
  const mPerDegLon = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
  return (p) => [(p[0] - lon0) * mPerDegLon, (p[1] - lat0) * mPerDegLat];
}

function polygonsOf(g: ParcelGeometry): Position[][][] {
  return g.type === "Polygon" ? [g.coordinates] : g.coordinates;
}

function isGeometry(g: unknown): g is ParcelGeometry {
  if (!g || typeof g !== "object") return false;
  const t = (g as { type?: unknown }).type;
  return (t === "Polygon" || t === "MultiPolygon") && Array.isArray((g as { coordinates?: unknown }).coordinates);
}

function ringArea(r: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return Math.abs(a) / 2;
}

function pointInRing(x: number, y: number, r: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i];
    const [xj, yj] = r[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Point in a polygon given as rings (first = outer, rest = holes). */
function pointInPolygonRings(x: number, y: number, rings: [number, number][][]): boolean {
  if (rings.length === 0 || !pointInRing(x, y, rings[0])) return false;
  for (let k = 1; k < rings.length; k++) if (pointInRing(x, y, rings[k])) return false;
  return true;
}

function segSegDistance(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(ptSegDistance(a, c, d), ptSegDistance(b, c, d), ptSegDistance(c, a, b), ptSegDistance(d, a, b));
}

function ptSegDistance(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx - p[0];
  const y = a[1] + t * dy - p[1];
  return Math.sqrt(x * x + y * y);
}

function orient(a: [number, number], b: [number, number], c: [number, number]): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function segmentsIntersect(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  const on = (p: [number, number], q: [number, number], r: [number, number]) =>
    Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
  if (o1 === 0 && on(a, b, c)) return true;
  if (o2 === 0 && on(a, b, d)) return true;
  if (o3 === 0 && on(c, d, a)) return true;
  if (o4 === 0 && on(c, d, b)) return true;
  return false;
}

/* --------------------------------- 1. water adjacency --------------------------------- */

export type WaterAdjacencyState = "adjacent" | "not-adjacent" | "undetermined";

export interface WaterAdjacency {
  lake: LakeKey | "synthetic";
  lakeName: string;
  state: WaterAdjacencyState;
  /** Shortest distance from the parcel polygon to the lake polygon, metres (0 = they intersect). Null when the geometry is unusable. */
  distanceM: number | null;
  basis: string;
}

/**
 * Measure a parcel against one vendored lake. Exact: the parcel intersects the lake polygon iff an
 * edge of one crosses an edge of the other or a vertex of one lies inside the other; otherwise the
 * distance is the shortest edge-to-edge distance. Only lake edges within `WATER_NOT_ADJACENT_MIN_M`
 * of the parcel's bounding box are examined.
 */
export function measureWaterAdjacency(parcel: unknown, lake: LakeKey): WaterAdjacency {
  return measureWaterAdjacencyAgainst(parcel, LAKES[lake].geometry, lake, LAKES[lake].name);
}

/** The same measurement against any lake polygon (exported for tests with a synthetic lake). */
export function measureWaterAdjacencyAgainst(
  parcel: unknown,
  lakeGeometry: PolygonGeometry,
  lake: LakeKey | "synthetic",
  name: string,
): WaterAdjacency {
  if (!isGeometry(parcel)) {
    return { lake, lakeName: name, state: "undetermined", distanceM: null, basis: "parcel geometry missing or not a polygon" };
  }
  const parcelPolys = polygonsOf(parcel);
  const first = parcelPolys[0]?.[0]?.[0];
  if (!first) return { lake, lakeName: name, state: "undetermined", distanceM: null, basis: "parcel geometry has no coordinates" };
  const proj = projectorAt(first[0], first[1]);
  const pPolys = parcelPolys.map((poly) => poly.map((ring) => ring.map(proj)));
  const lakeRings = lakeGeometry.coordinates.map((ring) => ring.map(proj));

  // Parcel bbox (projected), grown by the not-adjacent band: lake edges outside it cannot matter.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of pPolys) for (const ring of poly) for (const [x, y] of ring) {
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  const pad = WATER_NOT_ADJACENT_MIN_M * 2;
  const near = (a: [number, number], b: [number, number]) =>
    Math.max(a[0], b[0]) >= minX - pad && Math.min(a[0], b[0]) <= maxX + pad && Math.max(a[1], b[1]) >= minY - pad && Math.min(a[1], b[1]) <= maxY + pad;

  // Containment either way (a vertex of one strictly inside the other).
  const firstParcelVertex = pPolys[0][0][0];
  if (pointInPolygonRings(firstParcelVertex[0], firstParcelVertex[1], lakeRings)) {
    return { lake, lakeName: name, state: "adjacent", distanceM: 0, basis: `parcel reaches into the NHD ${name} polygon` };
  }
  let best = Infinity;
  for (const lr of lakeRings) {
    for (let i = 1; i < lr.length; i++) {
      const a = lr[i - 1];
      const b = lr[i];
      if (!near(a, b)) continue;
      for (const poly of pPolys) {
        if (pointInPolygonRings(a[0], a[1], poly)) best = 0;
        for (const ring of poly) {
          for (let j = 1; j < ring.length; j++) {
            const d = segSegDistance(a, b, ring[j - 1], ring[j]);
            if (d < best) best = d;
          }
        }
      }
      if (best === 0) break;
    }
    if (best === 0) break;
  }
  if (best === 0) {
    return { lake, lakeName: name, state: "adjacent", distanceM: 0, basis: `parcel polygon intersects the NHD ${name} polygon` };
  }
  if (best >= WATER_NOT_ADJACENT_MIN_M) {
    return {
      lake,
      lakeName: name,
      state: "not-adjacent",
      distanceM: Number.isFinite(best) ? Math.round(best * 10) / 10 : null,
      basis: `parcel is ${Number.isFinite(best) ? `${Math.round(best)} m` : `more than ${WATER_NOT_ADJACENT_MIN_M * 2} m`} from the NHD ${name} polygon (not-adjacent band: >= ${WATER_NOT_ADJACENT_MIN_M} m)`,
    };
  }
  return {
    lake,
    lakeName: name,
    state: "undetermined",
    distanceM: Math.round(best * 10) / 10,
    basis: `parcel is ${best.toFixed(1)} m from the NHD ${name} polygon: inside the 0-${WATER_NOT_ADJACENT_MIN_M} m band where NHD and parcel line-work error cannot say whether it borders the lake`,
  };
}

/* ----------------------------------- 2. lot width ----------------------------------- */

export interface LotWidthMeasure {
  /** Bounds on the lot width in feet, or null when the shape does not bound it. */
  intervalFt: [number, number] | null;
  shortSideFt: number | null;
  longSideFt: number | null;
  rectangularity: number | null;
  basis: string;
}

function convexHull(points: [number, number][]): [number, number][] {
  const pts = [...points].sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  if (pts.length < 3) return pts;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** Minimum-area bounding rectangle of a convex hull (one hull edge is always flush with a side). */
function minAreaRect(hull: [number, number][]): { a: number; b: number; area: number } | null {
  if (hull.length < 3) return null;
  let best: { a: number; b: number; area: number } | null = null;
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i];
    const q = hull[(i + 1) % hull.length];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len === 0) continue;
    const ux = (q[0] - p[0]) / len;
    const uy = (q[1] - p[1]) / len;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const [x, y] of hull) {
      const u = x * ux + y * uy;
      const v = -x * uy + y * ux;
      minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v);
    }
    const a = maxU - minU;
    const b = maxV - minV;
    if (!best || a * b < best.area) best = { a, b, area: a * b };
  }
  return best;
}

export function measureLotWidth(parcel: unknown): LotWidthMeasure {
  const none = (basis: string): LotWidthMeasure => ({ intervalFt: null, shortSideFt: null, longSideFt: null, rectangularity: null, basis });
  if (!isGeometry(parcel)) return none("parcel geometry missing or not a polygon");
  const polys = polygonsOf(parcel);
  if (polys.length !== 1) return none(`multi-part lot (${polys.length} parts): lot width is not bounded`);
  const outer = polys[0][0];
  if (!outer || outer.length < 4) return none("parcel ring has fewer than 4 positions");
  const proj = projectorAt(outer[0][0], outer[0][1]);
  const rings = polys[0].map((r) => r.map(proj));
  const area = ringArea(rings[0]) - rings.slice(1).reduce((s, r) => s + ringArea(r), 0);
  const rect = minAreaRect(convexHull(rings[0]));
  if (!rect || rect.area <= 0) return none("degenerate parcel ring");
  const shortFt = Math.min(rect.a, rect.b) * FT_PER_M;
  const longFt = Math.max(rect.a, rect.b) * FT_PER_M;
  const rectangularity = area / rect.area;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  if (rectangularity < LOT_WIDTH_MIN_RECTANGULARITY) {
    return {
      intervalFt: null,
      shortSideFt: r1(shortFt),
      longSideFt: r1(longFt),
      rectangularity: Math.round(rectangularity * 1000) / 1000,
      basis: `irregular lot (fills ${Math.round(rectangularity * 100)}% of its bounding rectangle, under ${LOT_WIDTH_MIN_RECTANGULARITY * 100}%): lot width is not bounded`,
    };
  }
  const lo = r1(shortFt - LOT_WIDTH_MARGIN_FT);
  const hi = r1(longFt + LOT_WIDTH_MARGIN_FT);
  return {
    intervalFt: [lo, hi],
    shortSideFt: r1(shortFt),
    longSideFt: r1(longFt),
    rectangularity: Math.round(rectangularity * 1000) / 1000,
    basis: `near-rectangular lot ${r1(shortFt)} ft x ${r1(longFt)} ft: lot width lies in [${lo}, ${hi}] ft whichever side is the front (+/- ${LOT_WIDTH_MARGIN_FT} ft line-work margin)`,
  };
}

/** True when a Table 4.2.6.A row's width band [min, below) can contain a width in `interval`. */
export function widthBandIntersects(band: [number, number | null], interval: [number, number]): boolean {
  const [min, below] = band;
  return interval[1] >= min && (below === null || interval[0] < below);
}

/* ----------------------------------- 3. CAD class ----------------------------------- */

export type PtadCategory = "A" | "B" | "F" | "M" | "other" | "none";

/**
 * The PTAD state category letter of a CAD property_use_code. `none` = no code on record (no CAD
 * row, or a blank code); `other` = any category this resolver does not read (C vacant, D/E rural and
 * ag, J utilities, O inventory, X exempt ...).
 */
export function ptadCategory(propertyUseCode: string | null | undefined): PtadCategory {
  const code = (propertyUseCode ?? "").trim().toUpperCase();
  if (!code) return "none";
  const c = code[0];
  if (c === "A" || c === "B" || c === "F" || c === "M") return c;
  return "other";
}
