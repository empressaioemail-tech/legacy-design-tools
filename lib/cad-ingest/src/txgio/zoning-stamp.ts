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
 *
 * Same rule, one step further out (P-259): a parcel that lands in a polygon
 * whose published value has no base district in this city's vocabulary
 * (`parse.kind: "unrecognised"`) is reported as its own bucket, stamped with
 * the published value verbatim rather than with a truncated prefix.
 */

import {
  bboxOfGeometry,
  bboxesIntersect,
  normalizeDigitId,
  pointInGeometry,
  trueInteriorPoint,
  type GeoBbox,
  type GeoJsonGeometry,
} from "./geo";
import type { BaseCodeParse } from "./zoning-base-code";

/** One zoning polygon plus its raw district code, ready for indexed PIP. */
export interface ZoningPolygon {
  /** Raw district code (Georgetown `ZONE`, e.g. "RS") — stamped verbatim. */
  code: string;
  /** Human description (Georgetown `FULLZONE`) — provenance/logging only. */
  description?: string | null;
  geometry: GeoJsonGeometry;
  bbox: GeoBbox;
  /**
   * OPTIONAL (P-259). Set only for a layer whose config carries
   * `baseCodeParse` — the parse of the published value this polygon came from.
   * `parse.kind` decides what `code` means:
   *  - `base` — `code` is the resolved base district.
   *  - `planned-development` — `code` is the published PUD/PDD/PD/PC value.
   *  - `unrecognised` — `code` is the published value VERBATIM, and it is
   *    still what gets stamped: the raw value is a fact about the parcel and
   *    the router has a designed decline path for a code it cannot resolve,
   *    whereas writing NULL would assert "no zoning on record". What is never
   *    written is a truncated prefix (for "CS-1-MU-…" that would be CS, a
   *    different district with its own row). The polygon is kept in the index
   *    so a parcel inside it is not miscounted as "outside the city", and the
   *    stamp summary counts it in `parcelsUnrecognised`.
   *
   * `parse.interim` (P-259b) is carried unchanged and is what the writer reads
   * to set `txgio_parcel.zoning_district_interim` — a declared interim qualifier
   * (`I-<base>`) means the base district's standards apply by ordinance while
   * the zoning itself is interim. It is TRUE for a resolved interim base AND for
   * an interim value that resolved to nothing, so an unresolved `I-XYZ` is
   * disclosed as interim rather than folded into the generic unrecognised set.
   * It never changes `code`: "I-SF-2-NP" still stamps SF-2, exactly its base.
   * Absent for every other layer, where the published code IS the district.
   */
  parse?: BaseCodeParse;
}

/**
 * Build the in-memory zoning index once per stamp run. Drops any feature
 * with no usable code or no bounded geometry (so a malformed zoning row can
 * never stamp a bad code). Returns the polygons in input order; a bbox
 * pre-filter at lookup time keeps PIP to the handful of polygons whose bbox
 * holds the query point.
 */
export function buildZoningIndex(
  features: Array<{
    code: string | null | undefined;
    description?: string | null;
    geometry: GeoJsonGeometry | null | undefined;
    parse?: BaseCodeParse;
  }>,
): ZoningPolygon[] {
  const out: ZoningPolygon[] = [];
  for (const f of features) {
    const code = typeof f.code === "string" ? f.code.trim() : "";
    if (!code) continue;
    if (!f.geometry) continue;
    const bbox = bboxOfGeometry(f.geometry);
    if (!bbox) continue;
    out.push({
      code,
      description: f.description ?? null,
      geometry: f.geometry,
      bbox,
      parse: f.parse,
    });
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
 *
 * BUG FIX (2026-08-05, WDLL): the shoelace centroid sums `(x+x')*cross`
 * over the ring, where `cross` is the signed area contributed by one edge
 * — for a small parcel (~tens of meters across) at real WGS84 magnitude
 * (longitude ~-97, latitude ~30) `cross` is ~1e-7..1e-9 while `(x+x')` is
 * ~-194. Multiplying a ~200-magnitude term into a ~1e-8-magnitude
 * accumulator is catastrophic cancellation: `cx`/`cy` lose most of their
 * significant digits before the final divide, and the resulting "centroid"
 * can land TENS OF METERS from the true centroid — confirmed live on
 * Bastrop prop_id 31131 (verified against the SAME polygon geometry the
 * parcel's own Zoned_Parcels/83 zoning record carries): the un-shifted
 * formula put the point ~21m east / ~7m south of the true centroid, clean
 * outside both the parcel's own bbox and its zoning polygon. This is why
 * the Bastrop 41-parcel scoped stamp (PR #385) reproduced the identical
 * miss the whole-county run always had — the bug is in this shared
 * function, not in scoping. It silently degrades PIP accuracy for EVERY
 * city's whole-county stamp run, worse as parcels sit farther from
 * longitude/latitude (0, 0) — i.e. worse the farther a city is from the
 * prime meridian/equator, which every TX city is.
 *
 * Fix: shift the ring to a local origin (its first vertex) before the
 * shoelace accumulation, then shift the result back. This is the standard
 * numerically-stable form of the polygon-centroid formula — the summed
 * terms stay near the parcel's own scale (~1e-4) instead of the raw
 * coordinate's scale (~1e2), so `cross` and `(x+x')` are both small and
 * cancellation never eats the significant digits.
 */
export function representativePoint(
  geometry: GeoJsonGeometry,
): { longitude: number; latitude: number } | null {
  const ring = largestRing(geometry);
  if (!ring || ring.length < 3) return null;
  // Local origin = the ring's own first vertex, so every summed term
  // during accumulation stays near the parcel's own coordinate scale.
  const [ox, oy] = ring[0]!;
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const [rx0, ry0] = ring[i]!;
    const [rx1, ry1] = ring[(i + 1) % ring.length]!;
    const x0 = rx0 - ox;
    const y0 = ry0 - oy;
    const x1 = rx1 - ox;
    const y1 = ry1 - oy;
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
  return { longitude: cx / (6 * a) + ox, latitude: cy / (6 * a) + oy };
}

/**
 * The zoning district code whose polygon contains the point, or null when
 * the point is in no zoning polygon. Bbox pre-filter then even-odd ray-cast
 * (`pointInGeometry`). First containing polygon wins (zoning layers do not
 * overlap; on the rare shared boundary the first is as correct as any).
 *
 * `parse` (P-259) is carried straight off the polygon so the caller can tell a
 * real district from a published value this city's vocabulary does not carry:
 * the latter is stamped VERBATIM and counted apart (never a truncated prefix,
 * never a silent null).
 */
export function zoningCodeAtPoint(
  index: ZoningPolygon[],
  longitude: number,
  latitude: number,
): { code: string; description?: string | null; parse?: BaseCodeParse } | null {
  const pointBbox: GeoBbox = {
    westLng: longitude,
    southLat: latitude,
    eastLng: longitude,
    northLat: latitude,
  };
  for (const poly of index) {
    if (!bboxesIntersect(poly.bbox, pointBbox)) continue;
    if (pointInGeometry(longitude, latitude, poly.geometry)) {
      return {
        code: poly.code,
        description: poly.description,
        parse: poly.parse,
      };
    }
  }
  return null;
}

/**
 * True when the matched zoning polygon's published value carried a DECLARED
 * interim qualifier (P-259b) — Austin's `I-<base>` family. The stamped district
 * is the base district, which is what the ordinance gives it; the extra fact is
 * that the zoning is INTERIM (granted on annexation until permanent zoning is
 * established), which is not the same as stably-zoned `SF-2` and is disclosed
 * separately on the parcel row rather than in `zoning_district`.
 *
 * Reads `parse.interim` and nothing else, so it is true for an interim value
 * that resolved to a base, an interim planned-development value, and an
 * unresolved interim value alike.
 */
export function isInterimDistrict(
  hit: { parse?: BaseCodeParse } | null | undefined,
): boolean {
  return hit?.parse?.interim === true;
}

/**
 * Stamp one parcel: compute its representative point, PIP the zoning index.
 *
 * BUG FIX (2026-10-09, Burnet stage 3 §3 Bug 1 — Marble Falls sample #41,
 * prop_id 112953): `representativePoint` above is a bare centroid — it does
 * NOT check that the centroid actually lands inside the parcel's own ring
 * before returning it (only a zero-area/collinear ring gets a fallback).
 * For a deeply non-convex parcel (a thin, winding road right-of-way is the
 * measured case: 1,065 of Burnet's 59,785 parcel features have their
 * centroid outside their own polygon) that unchecked centroid can land
 * anywhere, including well outside the parcel — and when it happens to fall
 * inside a NEIGHBOURING zoning polygon, the parcel was stamped with the
 * neighbour's district. The PRE-FIX fallback for a centroid that hit no
 * zoning polygon at all made this worse: it swept the ring's own vertices
 * and stamped whichever one FIRST happened to PIP into any polygon — a
 * ring vertex sits ON a boundary that can be shared with a neighbour, and
 * the even-odd ray cast has no reason to prefer "this parcel's own
 * district" when a shared-boundary point is numerically inside the
 * neighbour's ring.
 *
 * Verified live against prop_id 112953's real production geometry
 * (48053:112953): the bare centroid is OUTSIDE the parcel's own ring and
 * lands DIRECTLY inside the neighbouring Marble Falls "MR" polygon on the
 * very first try — the old vertex-sweep fallback was never even reached for
 * this sample; the bug is the missing inside-check on the fast path, not
 * the vertex sweep alone. (If the vertex sweep HAD run, its first hit for
 * this geometry is a different wrong answer, "ENZ.4" — i.e. the sweep is
 * its own, separate instance of the same class of bug, which is why it is
 * removed rather than kept as a second-stage fallback.)
 *
 * Fix: the FAST path is unchanged byte-for-byte when it already works — the
 * centroid is tried first, and used exactly as before whenever it is both
 * inside the parcel's own ring AND lands in a zoning polygon (this is true
 * for the overwhelming majority of parcels, so this function's cost is
 * unchanged for them). Only when the centroid is missing, outside the
 * parcel's own ring, or inside the ring but in no zoning polygon does this
 * function reach for `trueInteriorPoint` (geo.ts) — a point PROVEN strictly
 * inside the parcel (scanline search, holes/MultiPolygon-aware, never a
 * vertex, never outside) — and try THAT point against the zoning index
 * instead of sweeping boundary vertices. If neither point lands in a
 * zoning polygon, the parcel is honestly left unmatched (null), exactly the
 * conservative-fallback contract this module has always had.
 */
export function stampParcelZoning(
  index: ZoningPolygon[],
  parcelGeometry: GeoJsonGeometry,
): { code: string; description?: string | null; parse?: BaseCodeParse } | null {
  const centroid = representativePoint(parcelGeometry);
  if (centroid && pointInGeometry(centroid.longitude, centroid.latitude, parcelGeometry)) {
    const hit = zoningCodeAtPoint(index, centroid.longitude, centroid.latitude);
    if (hit) return hit;
  }
  // Centroid missing, outside the parcel's own ring, or inside but no
  // zoning polygon underneath it — try a point GUARANTEED inside the
  // parcel (never a shared boundary vertex) before giving up.
  const interior = trueInteriorPoint(parcelGeometry);
  if (interior) {
    const hit = zoningCodeAtPoint(index, interior.longitude, interior.latitude);
    if (hit) return hit;
  }
  return null;
}

/**
 * One parcel-shaped zoning layer's own feature for a given CAD parcel id
 * (P-???, Burnet stage 3 §3 Bug 2 — Horseshoe Bay sample #30/#40).
 *
 * `code: null` means the layer's OWN feature for this exact parcel carries
 * a blank/no district on its code field — a DECLARED fact (the register's
 * own CA/vacant-land rows), never to be filled in from a point lookup that
 * might land in a neighbour's polygon on a misaligned shared boundary.
 */
export interface ParcelIdZoningEntry {
  code: string | null;
  description?: string | null;
  parse?: BaseCodeParse;
}

/**
 * Build a parcel-id -> own-feature index for a layer whose features ARE
 * the city's parcel fabric (Horseshoe Bay's `Zoning Parcels` layer: one
 * feature per CAD parcel, carrying both the parcel's own `PROP_ID` and its
 * zoning code). Keyed by the SAME normalized id `--prop-ids-file` uses
 * (`normalizeDigitId`, geo.ts) so a lookup by `txgio_parcel.prop_id` and a
 * lookup by this layer's own id field agree on leading zeros.
 *
 * Deliberately NOT built from `buildZoningIndex`'s output: that function
 * drops every feature with a blank `code` (so a parcel's own blank-coded
 * feature would simply not exist in the PIP index), which is exactly the
 * loss bug 2 is about. This index keeps every feature that carries a
 * parcel id, blank code included — the blank IS the fact a caller needs to
 * read before ever falling back to a point lookup.
 *
 * A parcel id repeated across more than one feature keeps the FIRST and
 * drops the rest — a parcel-shaped layer is expected to carry one feature
 * per parcel; a repeat is a layer-data surprise, not something to resolve
 * by silently overwriting in either direction.
 */
export function buildParcelIdIndex(
  features: Array<{
    parcelId?: string | null;
    code: string | null | undefined;
    description?: string | null;
    parse?: BaseCodeParse;
  }>,
): Map<string, ParcelIdZoningEntry> {
  const out = new Map<string, ParcelIdZoningEntry>();
  for (const f of features) {
    if (!f.parcelId) continue;
    const id = normalizeDigitId(f.parcelId);
    if (!id || out.has(id)) continue;
    const code = typeof f.code === "string" ? f.code.trim() : "";
    out.set(id, {
      code: code.length > 0 ? code : null,
      description: f.description ?? null,
      parse: f.parse,
    });
  }
  return out;
}
