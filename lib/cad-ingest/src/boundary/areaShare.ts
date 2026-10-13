/**
 * Jurisdiction containment BY AREA SHARE: the one rule that decides which
 * city (or county) a PARCEL belongs to.
 *
 * WHY NOT A POINT. Every point rule answers a parcel that straddles a city
 * line by accident of geometry: a centroid outside a bent parcel, a ring's
 * first vertex sitting ON a boundary shared with a neighbour, or an interior
 * point that happens to land in the 46% piece. Measured on Burnet
 * (`doc_repo/_inbox/2026-10-12_burnet_city_containment_interior_point_EVIDENCE.md`):
 * no point rule gets a parcel that is 54% inside Horseshoe Bay right
 * reliably. The question a customer is asking is "whose land is this?", and
 * that is a question about AREA.
 *
 * THE RULE (`decideByAreaShare`):
 *
 *   1. Measure every jurisdiction polygon's overlap with the parcel in
 *      EPSG:3083 (NAD83 / Texas Centric Albers Equal Area), the same
 *      equal-area plane whole-parcel flood uses (hauska-factory
 *      `src/lib/area-share-overlay.mjs`, card F1, PR #271). The part of the
 *      parcel no polygon covers is the REMAINDER (for city limits:
 *      unincorporated land).
 *   2. The parcel belongs to the piece holding the MAJORITY (> 50%) of its
 *      area. The remainder competes as a piece in its own right, so a parcel
 *      that is 54% unincorporated is unincorporated and one that is 54% in
 *      Horseshoe Bay is in Horseshoe Bay.
 *   3. When no piece holds a majority (three or more pieces, e.g. 45% city A,
 *      40% city B, 15% unincorporated) the LARGEST piece wins and the
 *      decision says so (`rule: "plurality"`). Unincorporated is NOT the
 *      default here, because every consumer of this answer needs exactly one
 *      jurisdiction and reads "unincorporated" as a positive finding: the
 *      parcel_record `cityLimits` cell holds one city name, the zoning verdict
 *      (`zoningVerdictFromCityLimits`) serves `not-applicable` for an
 *      unincorporated parcel, and the ETJ reader runs the ring test only for an
 *      unincorporated parcel (an incorporated one is settled out of every ETJ,
 *      P-376). Calling a parcel that is 85% incorporated "unincorporated"
 *      would tell all three of them something false about most of the land.
 *      The plurality case is disclosed as a split every time (step 4), so it
 *      never decides silently.
 *   4. A SPLIT is recorded when the winner holds less than 99% AND at least
 *      one other piece is not a SLIVER. A sliver is the flood rule (operator
 *      ruling D1, `flood-ingest.mjs` SLIVER_MAX_SHARE / SLIVER_MAX_M2): under
 *      1% of the parcel AND under 50 m². A split is served with every
 *      non-sliver piece and a sentence a surface can show as is:
 *      "93% in Horseshoe Bay, 7% unincorporated".
 *
 * Ties (equal area to the square metre are not observed, but the order must
 * still be total): a city piece before the remainder, then geo id ascending.
 *
 * Two ways to measure, one way to decide. `measureJurisdictionPieces` measures
 * in-process (polygon-clipping in WGS84, then each piece projected to EPSG:3083
 * and shoelaced, exactly what PostGIS `ST_Area(ST_Transform(ST_Intersection(...),
 * 3083))` does: transform the vertices, then planar area). `cityAreaShareSql`
 * measures in PostGIS for a whole county. Both feed `decideByAreaShare`, so
 * there is one rule whichever side measured.
 */

import polygonClipping from "polygon-clipping";
import {
  bboxOfGeometry,
  bboxesIntersect,
  type GeoBbox,
  type GeoJsonGeometry,
} from "../txgio/geo";

/** Recorded on every decision so a stored answer names the rule that made it. */
export const AREA_SHARE_METHOD = "area-share-3083-v1" as const;

/** NAD83 / Texas Centric Albers Equal Area. Same plane as whole-parcel flood. */
export const EQUAL_AREA_SRID = 3083 as const;

/** A piece wins outright only with MORE than this share of the parcel. */
export const MAJORITY_SHARE = 0.5;

/** A winner at or above this share is never disclosed as a split. */
export const SPLIT_DISCLOSURE_BELOW_SHARE = 0.99;

/** Flood's sliver rule (operator ruling D1): under 1% of the parcel ... */
export const SLIVER_MAX_SHARE = 0.01;
/** ... AND under 50 m². Both must hold. */
export const SLIVER_MAX_M2 = 50;

/** One measured overlap between a parcel and a jurisdiction polygon. */
export interface MeasuredJurisdictionPiece {
  /** The jurisdiction's own key (tx_city_boundary geo_id, county fips). */
  id: string;
  name: string;
  gnis?: string | null;
  areaM2: number;
}

/** A piece of the parcel, as decided. */
export type AreaSharePiece =
  | {
      kind: "jurisdiction";
      id: string;
      name: string;
      gnis: string | null;
      areaM2: number;
      share: number;
      sliver: boolean;
    }
  | {
      /** The part of the parcel no jurisdiction polygon covers. */
      kind: "remainder";
      areaM2: number;
      share: number;
      sliver: boolean;
    };

export interface AreaShareDecision {
  method: typeof AREA_SHARE_METHOD;
  parcelM2: number;
  winner: AreaSharePiece;
  /** `majority`: the winner holds > 50%. `plurality`: no piece does. */
  rule: "majority" | "plurality";
  /** True when the split must be disclosed (see the module header, step 4). */
  split: boolean;
  /** Every piece with positive area, largest first (slivers included, flagged). */
  pieces: AreaSharePiece[];
  /** "93% in Horseshoe Bay, 7% unincorporated" when `split`, else null. */
  disclosure: string | null;
}

/** Flood's sliver rule, verbatim: under 1% of the parcel AND under 50 m². */
export function isSliverPiece(share: number, areaM2: number): boolean {
  return share < SLIVER_MAX_SHARE && areaM2 < SLIVER_MAX_M2;
}

/**
 * Below this share of the parcel, an uncovered remainder is floating-point
 * noise from a parcel its city fully covers (the intersection's area differs
 * from the parcel's own in the last digits). Not a sliver to disclose, not
 * land: dropped.
 */
const REMAINDER_NOISE_SHARE = 1e-9;

function comparePieces(a: AreaSharePiece, b: AreaSharePiece): number {
  if (b.areaM2 !== a.areaM2) return b.areaM2 - a.areaM2;
  if (a.kind !== b.kind) return a.kind === "jurisdiction" ? -1 : 1;
  if (a.kind === "jurisdiction" && b.kind === "jurisdiction") {
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }
  return 0;
}

/** Whole percent, never rounding a real piece to 0% or a partial winner to 100%. */
export function formatShare(share: number): string {
  const pct = Math.round(share * 100);
  if (pct <= 0) return "<1%";
  if (pct >= 100 && share < 1) return ">99%";
  return `${pct}%`;
}

/**
 * The sentence a surface shows for a split. Non-sliver pieces only, largest
 * first. `remainderLabel` names the uncovered part ("unincorporated" for city
 * limits).
 */
export function describeAreaShareSplit(
  pieces: readonly AreaSharePiece[],
  remainderLabel: string,
): string {
  return pieces
    .filter((p) => !p.sliver)
    .map((p) =>
      p.kind === "jurisdiction"
        ? `${formatShare(p.share)} in ${p.name}`
        : `${formatShare(p.share)} ${remainderLabel}`,
    )
    .join(", ");
}

/**
 * THE RULE. Returns null when the parcel has no measurable area (nothing to
 * share out — the caller's "unmeasured", never a guessed jurisdiction).
 *
 * `pieces` may repeat an id (a polygon measured in several subdivided parts);
 * they are summed. Non-positive areas are touches, not overlaps, and are
 * dropped.
 */
export function decideByAreaShare(
  parcelM2: number,
  pieces: readonly MeasuredJurisdictionPiece[],
  remainderLabel: string,
): AreaShareDecision | null {
  if (!Number.isFinite(parcelM2) || parcelM2 <= 0) return null;

  const byId = new Map<string, { name: string; gnis: string | null; areaM2: number }>();
  for (const p of pieces) {
    if (!Number.isFinite(p.areaM2) || p.areaM2 <= 0) continue;
    const prev = byId.get(p.id);
    if (prev) prev.areaM2 += p.areaM2;
    else byId.set(p.id, { name: p.name, gnis: p.gnis ?? null, areaM2: p.areaM2 });
  }

  const decided: AreaSharePiece[] = [];
  let covered = 0;
  for (const [id, p] of byId) {
    covered += p.areaM2;
    const share = p.areaM2 / parcelM2;
    decided.push({
      kind: "jurisdiction",
      id,
      name: p.name,
      gnis: p.gnis,
      areaM2: p.areaM2,
      share,
      sliver: isSliverPiece(share, p.areaM2),
    });
  }
  const remainderM2 = parcelM2 - covered;
  const remainderShare = remainderM2 / parcelM2;
  if (remainderShare > REMAINDER_NOISE_SHARE) {
    decided.push({
      kind: "remainder",
      areaM2: remainderM2,
      share: remainderShare,
      sliver: isSliverPiece(remainderShare, remainderM2),
    });
  }
  if (decided.length === 0) return null;
  decided.sort(comparePieces);

  const winner = decided[0]!;
  const rule = winner.share > MAJORITY_SHARE ? "majority" : "plurality";
  const split =
    winner.share < SPLIT_DISCLOSURE_BELOW_SHARE &&
    decided.some((p) => p !== winner && !p.sliver);
  return {
    method: AREA_SHARE_METHOD,
    parcelM2,
    winner,
    rule,
    split,
    pieces: decided,
    disclosure: split ? describeAreaShareSplit(decided, remainderLabel) : null,
  };
}

// ------------------------------------------------------- EPSG:3083 area

// GRS80 (NAD83). EPSG:3083: lat_1=27.5, lat_2=35, lat_0=18, lon_0=-100,
// x_0=1500000, y_0=6000000. Snyder, Map Projections — A Working Manual
// (USGS PP 1395), ellipsoidal Albers, eqs. 14-15 / 3-12 / 14-12.
const GRS80_A = 6378137;
const GRS80_E2 = 0.0066943800229;
const GRS80_E = Math.sqrt(GRS80_E2);
const DEG = Math.PI / 180;

function albersQ(phi: number): number {
  const s = Math.sin(phi);
  return (
    (1 - GRS80_E2) *
    (s / (1 - GRS80_E2 * s * s) -
      (1 / (2 * GRS80_E)) * Math.log((1 - GRS80_E * s) / (1 + GRS80_E * s)))
  );
}

function albersM(phi: number): number {
  const s = Math.sin(phi);
  return Math.cos(phi) / Math.sqrt(1 - GRS80_E2 * s * s);
}

const ALBERS_M1 = albersM(27.5 * DEG);
const ALBERS_M2 = albersM(35 * DEG);
const ALBERS_Q1 = albersQ(27.5 * DEG);
const ALBERS_Q2 = albersQ(35 * DEG);
const ALBERS_N = (ALBERS_M1 ** 2 - ALBERS_M2 ** 2) / (ALBERS_Q2 - ALBERS_Q1);
const ALBERS_C = ALBERS_M1 ** 2 + ALBERS_N * ALBERS_Q1;
const ALBERS_RHO0 = (GRS80_A * Math.sqrt(ALBERS_C - ALBERS_N * albersQ(18 * DEG))) / ALBERS_N;
const ALBERS_LAM0 = -100 * DEG;

/** WGS84/NAD83 lng/lat (degrees) to EPSG:3083 metres. */
export function projectEpsg3083(longitude: number, latitude: number): [number, number] {
  const rho = (GRS80_A * Math.sqrt(ALBERS_C - ALBERS_N * albersQ(latitude * DEG))) / ALBERS_N;
  const theta = ALBERS_N * (longitude * DEG - ALBERS_LAM0);
  return [1500000 + rho * Math.sin(theta), 6000000 + ALBERS_RHO0 - rho * Math.cos(theta)];
}

type Position = [number, number];

function asRing(raw: unknown): Position[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Position[] = [];
  for (const pt of raw) {
    if (
      Array.isArray(pt) &&
      pt.length >= 2 &&
      typeof pt[0] === "number" &&
      typeof pt[1] === "number" &&
      Number.isFinite(pt[0]) &&
      Number.isFinite(pt[1])
    ) {
      out.push([pt[0], pt[1]]);
    }
  }
  return out.length >= 3 ? out : null;
}

/** Polygon/MultiPolygon to a list of polygons (rings), dropping unusable rings. */
function polygonsOf(geometry: GeoJsonGeometry): Position[][][] {
  const polys: Position[][][] = [];
  const takePolygon = (raw: unknown) => {
    if (!Array.isArray(raw)) return;
    const rings: Position[][] = [];
    for (let i = 0; i < raw.length; i++) {
      const ring = asRing(raw[i]);
      if (ring) rings.push(ring);
      else if (i === 0) return; // no usable outer ring: no polygon
    }
    if (rings.length > 0) polys.push(rings);
  };
  if (geometry?.type === "Polygon") takePolygon(geometry.coordinates);
  else if (geometry?.type === "MultiPolygon" && Array.isArray(geometry.coordinates)) {
    for (const p of geometry.coordinates) takePolygon(p);
  }
  return polys;
}

/** Planar shoelace of a ring projected to EPSG:3083, about a local origin. */
function ringAreaM2(ring: readonly Position[]): number {
  const pts = ring.map(([x, y]) => projectEpsg3083(x, y));
  const [ox, oy] = pts[0]!;
  let twice = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xj, yj] = pts[j]!;
    const [xi, yi] = pts[i]!;
    twice += (xj - ox) * (yi - oy) - (xi - ox) * (yj - oy);
  }
  return Math.abs(twice) / 2;
}

function polygonsAreaM2(polys: readonly Position[][][]): number {
  let total = 0;
  for (const rings of polys) {
    let a = ringAreaM2(rings[0]!);
    for (let h = 1; h < rings.length; h++) a -= ringAreaM2(rings[h]!);
    total += Math.max(0, a);
  }
  return total;
}

/**
 * Area of a WGS84 Polygon/MultiPolygon in m², measured in EPSG:3083 the way
 * PostGIS `ST_Area(ST_Transform(g, 3083))` measures it. Holes are subtracted;
 * the geometry is taken as valid (non-overlapping parts).
 */
export function geometryAreaM2(geometry: GeoJsonGeometry): number {
  return polygonsAreaM2(polygonsOf(geometry));
}

/** A jurisdiction polygon the in-process measurement can test. */
export interface JurisdictionPolygon {
  id: string;
  name: string;
  gnis?: string | null;
  geometry: GeoJsonGeometry;
  bbox: GeoBbox;
}

/**
 * Measure a parcel against candidate jurisdiction polygons, in process.
 *
 * Returns null when the parcel has no polygonal area or the clipping engine
 * refuses the geometry (self-intersections it cannot repair): the caller
 * answers "unmeasured" rather than falling back to a point.
 *
 * The parcel's parts are first unioned (a MultiPolygon whose parts overlap,
 * the shape a CAD parcel split across source tiles can take, must not count
 * its overlap twice), exactly as the SQL path unions every fragment of a
 * prop_id before measuring.
 */
export function measureJurisdictionPieces(
  parcel: GeoJsonGeometry,
  candidates: readonly JurisdictionPolygon[],
): { parcelM2: number; pieces: MeasuredJurisdictionPiece[] } | null {
  const parcelPolys = polygonsOf(parcel);
  if (parcelPolys.length === 0) return null;
  const parcelBbox = bboxOfGeometry(parcel);
  if (!parcelBbox) return null;
  try {
    const unioned = polygonClipping.union(
      parcelPolys as unknown as polygonClipping.Geom,
    ) as unknown as Position[][][];
    const parcelM2 = polygonsAreaM2(unioned);
    if (!(parcelM2 > 0)) return null;
    const pieces: MeasuredJurisdictionPiece[] = [];
    for (const c of candidates) {
      if (!bboxesIntersect(parcelBbox, c.bbox)) continue;
      const cityPolys = polygonsOf(c.geometry);
      if (cityPolys.length === 0) continue;
      const inter = polygonClipping.intersection(
        unioned as unknown as polygonClipping.Geom,
        cityPolys as unknown as polygonClipping.Geom,
      ) as unknown as Position[][][];
      const areaM2 = polygonsAreaM2(inter);
      if (areaM2 > 0) pieces.push({ id: c.id, name: c.name, gnis: c.gnis ?? null, areaM2 });
    }
    return { parcelM2, pieces };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- SQL

/**
 * The same measurement in PostGIS, for a county at a time: one row per
 * (parcel, city) overlap with its EPSG:3083 area, plus the parcel's own area;
 * a parcel no city overlaps yields one row with NULL city columns. Rows feed
 * `decideByAreaShare` unchanged (group by prop_id; `parcel_m2` and the
 * pieces' `area_m2`).
 *
 * Parameters: $1 county_fips, $2 prop_id lower bound (inclusive), $3 prop_id
 * upper bound (exclusive, NULL for the last chunk). Chunk by prop_id so no
 * single statement holds a county's worth of unions (production runs with no
 * statement_timeout, so a statement's size is the only bound).
 *
 * THE PARCEL: `ST_MakeValid(ST_Union(geom))` of every txgio_parcel fragment
 * sharing the prop_id, polygonal part only — hauska-factory's
 * `nativeGeomFragmentUnionCte` (`src/lib/parcel-fragment-union.mjs`), the
 * definition whole-parcel flood measures. TxGIO's placeholder prop_id '0' and
 * blank ids are not parcels and are excluded (`area-share-overlay.mjs`
 * PLACEHOLDER_PROP_IDS).
 *
 * THE CITIES: `tx_city_boundary` rows whose bbox meets the county's
 * (`tx_county_boundary`), decoded once and cut with `ST_Subdivide(…, 256)` so
 * each intersection runs against a small piece; pieces of one city do not
 * overlap, so summing them is that city's overlap. SPATIAL selection only:
 * no city is chosen by a name or a county attribute.
 *
 * `withDegreeAreas` adds `parcel_deg2` / `area_deg2` (planar SRID-4326 areas),
 * which only the read-only before/after measurement needs, to reproduce the
 * superseded hauska-factory p2-juris rule (largest overlap with a 1e-8 deg²
 * floor) from the same pieces.
 */
export function cityAreaShareSql({
  withDegreeAreas = false,
}: { withDegreeAreas?: boolean } = {}): string {
  const deg = withDegreeAreas;
  return `WITH county AS MATERIALIZED (
  SELECT west_lng, south_lat, east_lng, north_lat
    FROM tx_county_boundary WHERE county_fips = $1
),
cities AS MATERIALIZED (
  SELECT v.geo_id, v.city_name, v.gnis,
         ST_Subdivide(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(v.geometry::text), 4326)), 3), 256) AS g
    FROM tx_city_boundary v, county co
   WHERE v.geometry IS NOT NULL
     AND v.west_lng <= co.east_lng AND v.east_lng >= co.west_lng
     AND v.south_lat <= co.north_lat AND v.north_lat >= co.south_lat
),
page AS MATERIALIZED (
  SELECT DISTINCT prop_id FROM txgio_parcel
   WHERE county_fips = $1
     AND prop_id IS NOT NULL AND btrim(prop_id) <> '' AND prop_id <> '0'
     AND prop_id >= $2 AND ($3::text IS NULL OR prop_id < $3)
),
parcels AS MATERIALIZED (
  SELECT t.prop_id, ST_CollectionExtract(ST_MakeValid(ST_Union(t.geom)), 3) AS g
    FROM page p
    JOIN txgio_parcel t ON t.county_fips = $1 AND t.prop_id = p.prop_id AND t.geom IS NOT NULL
   GROUP BY t.prop_id
),
cut AS (
  SELECT p.prop_id, c.geo_id, c.city_name, c.gnis,
         ST_CollectionExtract(ST_Intersection(p.g, c.g), 3) AS ig
    FROM parcels p
    JOIN cities c ON c.g && p.g AND ST_Intersects(c.g, p.g)
),
pieces AS (
  SELECT prop_id, geo_id, city_name, gnis,
         sum(ST_Area(ST_Transform(ig, ${EQUAL_AREA_SRID}))) AS area_m2${deg ? `,
         sum(ST_Area(ig)) AS area_deg2` : ""}
    FROM cut
   GROUP BY prop_id, geo_id, city_name, gnis
)
SELECT p.prop_id,
       ST_Area(ST_Transform(p.g, ${EQUAL_AREA_SRID})) AS parcel_m2,${deg ? `
       ST_Area(p.g) AS parcel_deg2,
       pc.area_deg2,` : ""}
       pc.geo_id, pc.city_name, pc.gnis, pc.area_m2
  FROM parcels p
  LEFT JOIN pieces pc ON pc.prop_id = p.prop_id
 ORDER BY p.prop_id, pc.area_m2 DESC NULLS LAST`;
}

/** One row of `cityAreaShareSql`. */
export interface CityAreaShareSqlRow {
  prop_id: string;
  parcel_m2: number | string;
  geo_id: string | null;
  city_name: string | null;
  gnis: string | null;
  area_m2: number | string | null;
  parcel_deg2?: number | string;
  area_deg2?: number | string | null;
}

/** Group `cityAreaShareSql` rows by parcel into `decideByAreaShare` input. */
export function groupCityAreaShareRows(
  rows: readonly CityAreaShareSqlRow[],
): Map<string, { parcelM2: number; pieces: MeasuredJurisdictionPiece[] }> {
  const out = new Map<string, { parcelM2: number; pieces: MeasuredJurisdictionPiece[] }>();
  for (const r of rows) {
    const propId = String(r.prop_id);
    let entry = out.get(propId);
    if (!entry) {
      entry = { parcelM2: Number(r.parcel_m2), pieces: [] };
      out.set(propId, entry);
    }
    if (r.geo_id != null && r.area_m2 != null) {
      entry.pieces.push({
        id: r.geo_id,
        name: r.city_name ?? r.geo_id,
        gnis: r.gnis ?? null,
        areaM2: Number(r.area_m2),
      });
    }
  }
  return out;
}
