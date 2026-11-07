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

/**
 * Plausible WGS84 degree envelope for Texas, generously padded past the
 * true state extent (roughly -106.65..-93.51 lng, 25.84..36.50 lat) so a
 * legitimate county on the border can never trip it.
 *
 * This is the DURABLE projection guard. The `.prj` assertion in
 * `parse.ts` reads a text declaration; this reads the coordinates
 * themselves, so it catches every failure mode the WKT parse can miss:
 * a projected CRS whose WKT nests a WGS84 GEOGCS (the real
 * `PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere", GEOGCS["GCS_WGS_1984",...]]`
 * case that ships on the 202505 StratMap vintage), a MISSING `.prj`
 * (which the CLI only warns about), a swapped lat/lng axis order, and
 * any future source change. Web Mercator meters for Texas land near
 * x=-11,200,000 / y=3,900,000 — orders of magnitude outside this box.
 */
export const TEXAS_WGS84_BOUNDS: GeoBbox = {
  westLng: -107.5,
  southLat: 25.0,
  eastLng: -93.0,
  northLat: 37.0,
};

/**
 * Hard ceiling on the cells one FEATURE may bucket into at ingest time.
 * A real Texas parcel occupies one or a few 0.02-degree cells; the
 * largest single ranch parcels stay well under a hundred. A count in
 * the thousands means the coordinates are not degrees, so the ingest
 * must fail loudly rather than attempt to materialize the key set.
 * (Pre-hardening, meter coordinates produced a count on the order of
 * 9.1e12 and the run died on memory exhaustion instead.)
 */
export const TXGIO_MAX_FEATURE_CELLS = 4096;

export interface GeoBbox {
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
}

/**
 * True when every corner of the bbox falls inside the plausible Texas
 * WGS84 degree envelope. Non-finite coordinates are never plausible.
 */
export function isPlausibleTexasWgs84Bbox(bbox: GeoBbox): boolean {
  const values = [bbox.westLng, bbox.eastLng, bbox.southLat, bbox.northLat];
  if (!values.every((v) => Number.isFinite(v))) return false;
  return (
    bbox.westLng >= TEXAS_WGS84_BOUNDS.westLng &&
    bbox.eastLng <= TEXAS_WGS84_BOUNDS.eastLng &&
    bbox.southLat >= TEXAS_WGS84_BOUNDS.southLat &&
    bbox.northLat <= TEXAS_WGS84_BOUNDS.northLat
  );
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
 * Absolute ceiling on an uncapped `cellKeysForBbox` call. Texas spans
 * roughly 730 x 535 = ~390k cells at 0.02 degrees, so a whole-state
 * bbox is still comfortably under this; anything above it is a
 * coordinate-space error, not a query.
 */
const CELL_KEY_HARD_CEILING = 4_000_000;

/**
 * Number of grid cells a bbox covers, without materializing any of
 * them. Cheap enough to check before allocating. Returns `NaN` when a
 * coordinate is not finite.
 */
export function cellCountForBbox(
  bbox: GeoBbox,
  gridDeg: number = TXGIO_TILE_GRID_DEG,
): number {
  const wIdx = Math.floor(bbox.westLng / gridDeg);
  const eIdx = Math.floor(bbox.eastLng / gridDeg);
  const sIdx = Math.floor(bbox.southLat / gridDeg);
  const nIdx = Math.floor(bbox.northLat / gridDeg);
  return (eIdx - wIdx + 1) * (nIdx - sIdx + 1);
}

/**
 * Every cell key a bbox intersects, iterated by integer cell index so
 * repeated `+= gridDeg` float drift can never skip or duplicate a
 * cell. `maxCells` caps the result (returns `null` when the bbox
 * would cover more) so a zoomed-out viewport can fall back to a
 * bbox-column scan instead of an enormous IN list.
 *
 * Callers that pass no `maxCells` are still protected: a non-finite or
 * absurd cell count THROWS rather than attempting the allocation. That
 * case is never a legitimate viewport or a legitimate parcel — it means
 * the bbox is not in degrees — and a loud failure is strictly better
 * than an out-of-memory kill partway through a county load.
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
  if (!Number.isFinite(count)) {
    throw new Error(
      `cellKeysForBbox: non-finite cell count for bbox ` +
        `[${bbox.westLng},${bbox.southLat},${bbox.eastLng},${bbox.northLat}] ` +
        `— coordinates are not usable WGS84 degrees`,
    );
  }
  if (count <= 0) return [];
  if (maxCells !== undefined && count > maxCells) return null;
  if (count > CELL_KEY_HARD_CEILING) {
    throw new Error(
      `cellKeysForBbox: bbox covers ${count} cells at grid ${gridDeg}, above ` +
        `the ${CELL_KEY_HARD_CEILING} hard ceiling — bbox ` +
        `[${bbox.westLng},${bbox.southLat},${bbox.eastLng},${bbox.northLat}] ` +
        `is not plausible WGS84 degrees (projected meters?)`,
    );
  }
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
 *
 * The parameter is `unknown`, not `GeoJsonGeometry`, on purpose: the ETJ
 * reader (P-359) computes an envelope from a row whose geometry it has not
 * accepted yet — a published drawing it may go on to refuse — and it must be
 * able to do that without asserting the very thing it is about to check. The
 * walk is already type-blind, so nothing here trusts the shape.
 */
export function bboxOfGeometry(geometry: unknown): GeoBbox | null {
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

  walk(
    (geometry as { coordinates?: unknown } | null | undefined)?.coordinates,
  );
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

// --------------------------------------------------------------- IDs

/**
 * Strip leading zeros from an all-digit id ("0031131" -> "31131"); any
 * other value is returned trimmed, unchanged. Shared normalization for
 * every place `cad-ingest` compares a CAD/GIS id as a loose string
 * (`--prop-ids-file` ids, a zoning layer's own parcel-id attribute). Kept
 * here, not re-derived per call site, because `zoning-cli.ts`'s
 * `normalizePropId` and the zoning-stamp parcel-id join (`zoning-stamp.ts`)
 * both need EXACTLY this rule and a silent divergence between two copies
 * would reintroduce the class of bug OPS-16 already named (a fix landing
 * in one copy of the logic but not its sibling). `api-server`'s own
 * `normalizeCadPropId` (`parcelNodeId.ts`) mirrors this rule too, but is
 * deliberately NOT imported here — `cad-ingest` stays dependency-free of
 * `api-server` (see `zoning-cli.ts`'s header) — so that is a documented,
 * separate copy across the package boundary, not an oversight.
 */
export function normalizeDigitId(raw: string): string {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return t;
  return t.replace(/^0+(?=\d)/, "");
}

// -------------------------------------------------------- Interior point

/** A WGS84 (or whatever CRS the geometry is in) point, longitude first. */
export interface InteriorPoint {
  longitude: number;
  latitude: number;
}

function isPosition2(v: unknown): v is [number, number] {
  return (
    Array.isArray(v) &&
    v.length >= 2 &&
    typeof v[0] === "number" &&
    typeof v[1] === "number" &&
    Number.isFinite(v[0]) &&
    Number.isFinite(v[1])
  );
}

/** One polygon PART: outer ring first, any holes after (GeoJSON Polygon.coordinates shape). */
type RingSet = [number, number][][];

/** Filter a raw coordinate ring to finite positions; null when fewer than 3 survive. */
function cleanRing(ring: unknown): [number, number][] | null {
  if (!Array.isArray(ring)) return null;
  const out = ring.filter(isPosition2) as [number, number][];
  return out.length >= 3 ? out : null;
}

/** Every Polygon/MultiPolygon PART (outer + holes) with usable rings, geometry order preserved. */
function partsOf(geometry: GeoJsonGeometry): RingSet[] {
  const raw: unknown[] =
    geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.type === "MultiPolygon" && Array.isArray(geometry.coordinates)
        ? geometry.coordinates
        : [];
  const parts: RingSet[] = [];
  for (const part of raw) {
    if (!Array.isArray(part)) continue;
    const rings: RingSet = [];
    for (const ring of part) {
      const cleaned = cleanRing(ring);
      if (cleaned) rings.push(cleaned);
    }
    if (rings.length > 0) parts.push(rings);
  }
  return parts;
}

/** Numerically-stable shoelace |area| (same origin-shift as `zoning-stamp.ts`'s centroid fix). */
function absRingArea(ring: [number, number][]): number {
  const [ox, oy] = ring[0]!;
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [rx0, ry0] = ring[i]!;
    const [rx1, ry1] = ring[(i + 1) % ring.length]!;
    a += (rx0 - ox) * (ry1 - oy) - (rx1 - ox) * (ry0 - oy);
  }
  return Math.abs(a) * 0.5;
}

/** The PART (outer ring + its holes) whose OUTER ring has the largest |area|. */
function largestPart(parts: RingSet[]): RingSet | null {
  let best: RingSet | null = null;
  let bestArea = -1;
  for (const part of parts) {
    const area = absRingArea(part[0]!);
    if (area > bestArea) {
      bestArea = area;
      best = part;
    }
  }
  return best;
}

/**
 * Every x where a horizontal ray at `fixed` crosses an edge of `ring`,
 * sorted ascending. Half-open on the fixed coordinate (`a > fixed !== b >
 * fixed`) so a vertex lying exactly on the scanline is counted once, same
 * convention as `ringCrossings` above. Passing (lat-major) coordinates
 * swapped lets the SAME function serve a vertical scanline (see
 * `trueInteriorPoint`): callers that want crossings-by-latitude pass rings
 * with [lat, lng] pairs and read the result as latitudes.
 */
function scanlineCrossings(rings: RingSet, fixed: number): number[] {
  const xs: number[] = [];
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, ay] = ring[i]!;
      const [bx, by] = ring[j]!;
      if (ay > fixed !== by > fixed) {
        const t = (fixed - ay) / (by - ay);
        xs.push(ax + t * (bx - ax));
      }
    }
  }
  xs.sort((a, b) => a - b);
  return xs;
}

/** Candidate scanline positions: midpoints between (possibly subsampled) distinct vertex coordinates. */
function candidateScanlines(sortedDistinct: number[], maxLines: number): number[] {
  const n = sortedDistinct.length;
  if (n < 2) return [];
  let picked: number[];
  if (n - 1 <= maxLines) {
    picked = sortedDistinct;
  } else {
    picked = [];
    for (let k = 0; k <= maxLines; k++) {
      const idx = Math.round((k * (n - 1)) / maxLines);
      picked.push(sortedDistinct[idx]!);
    }
  }
  const lines: number[] = [];
  for (let i = 0; i + 1 < picked.length; i++) {
    const a = picked[i]!;
    const b = picked[i + 1]!;
    const mid = (a + b) / 2;
    if (mid > a && mid < b) lines.push(mid);
  }
  return lines;
}

/** Best (widest) inside segment found along one scanline direction. */
interface BestSegment {
  /** The point: [varying coordinate midpoint, fixed scanline coordinate]. */
  point: [number, number];
  width: number;
}

/**
 * Scan a fixed set of lines perpendicular to `axis`. `axis==="y"` means
 * HORIZONTAL scanlines at fixed latitudes, varying longitude (the normal
 * orientation); `axis==="x"` means VERTICAL scanlines at fixed longitudes,
 * varying latitude, done by swapping each ring's [lng,lat] to [lat,lng] so
 * the same crossing math applies, then swapping the result back.
 */
function bestSegmentAlong(rings: RingSet, axis: "x" | "y"): BestSegment | null {
  const swapped: RingSet =
    axis === "x" ? rings.map((ring) => ring.map(([x, y]) => [y, x] as [number, number])) : rings;
  const fixedValues = new Set<number>();
  for (const ring of swapped) for (const [, y] of ring) fixedValues.add(y);
  const sorted = [...fixedValues].sort((a, b) => a - b);
  const lines = candidateScanlines(sorted, 192);
  let best: BestSegment | null = null;
  for (const fixed of lines) {
    const xs = scanlineCrossings(swapped, fixed);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const width = xs[i + 1]! - xs[i]!;
      if (width <= 0) continue;
      if (best === null || width > best.width) {
        const mid = (xs[i]! + xs[i + 1]!) / 2;
        best = {
          width,
          point: axis === "x" ? [fixed, mid] : [mid, fixed],
        };
      }
    }
  }
  return best;
}

/**
 * A point GUARANTEED strictly inside a Polygon/MultiPolygon — never a
 * vertex, never outside the ring, never inside a hole, never on a shared
 * boundary with a neighbouring feature. Unlike a bare centroid, this never
 * needs an "is it actually inside?" afterthought: every candidate this
 * function considers is derived from an inside scanline segment, and the
 * final choice is verified against the geometry before it is returned.
 *
 * Method (dependency-free — no PostGIS, no turf, matching this module's own
 * design note): for a MultiPolygon, the LARGEST-area part by its outer
 * ring (never a hole, never a smaller part) is used — the brief's own
 * instruction, and the only sane choice when a caller wants ONE point.
 * Within that part, horizontal AND vertical scanlines are placed at the
 * midpoints between the part's own vertex coordinates (subsampled when a
 * ring is very dense, so cost stays bounded regardless of vertex count),
 * each scanline's crossings against EVERY ring of the part (outer + holes)
 * are combined with the even-odd rule — exactly `pointInPolygonRings`'s own
 * rule, so a hole is excluded for free — and the WIDEST inside segment
 * across both orientations wins. Scanning both axes means a thin strip
 * oriented either way still gets a reasonable interior point (a long
 * horizontal road is wide along horizontal scanlines; a long vertical one
 * along vertical scanlines).
 *
 * Returns null only for a geometry with no usable ring, or one so
 * degenerate (zero area, a line) that no scanline ever finds a strictly
 * inside segment — there is no interior point to report, which is the
 * honest answer for a sliver with no interior.
 */
export function trueInteriorPoint(geometry: GeoJsonGeometry): InteriorPoint | null {
  const parts = partsOf(geometry);
  const part = largestPart(parts);
  if (!part) return null;

  const horizontal = bestSegmentAlong(part, "y");
  const vertical = bestSegmentAlong(part, "x");
  const candidates = [horizontal, vertical]
    .filter((c): c is BestSegment => c !== null)
    .sort((a, b) => b.width - a.width);

  for (const c of candidates) {
    const [longitude, latitude] = c.point;
    if (pointInGeometry(longitude, latitude, geometry)) {
      return { longitude, latitude };
    }
  }
  return null;
}
