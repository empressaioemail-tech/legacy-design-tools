/**
 * EPSG:3857 (WGS 84 / Pseudo-Mercator, "Web Mercator") -> EPSG:4326
 * (WGS84 geographic degrees) reprojection for the TxGIO/StratMap
 * land-parcel ingest.
 *
 * WHY THIS EXISTS. 57 of the 235 unloaded Texas counties ship the
 * 202505 StratMap vintage, and every 202505 archive sampled ships
 * `PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere", ...]` — coordinates
 * in METERS, not degrees (`_inbox/2026-08-08_SWEEP_statewide_readiness.md`
 * section 3; 12 of 12 sampled projected, 15 of 15 on every other
 * vintage in degrees). `parse.ts` correctly refuses those coordinates,
 * which blocks the natural "start with the small counties" acquisition
 * wave — six of the ten smallest counties are 202505. Operator ruling
 * 2026-08-08: add reprojection, explicitly.
 *
 * WHY NO DEPENDENCY. The repo has no proj4 (or any other geospatial
 * projection library) in any package.json — verified 2026-08-08. The
 * EPSG:3857 inverse is closed-form, two lines of arithmetic, exactly
 * representable in float64, and needs no datum shift, no grid file,
 * and no iteration (unlike an ellipsoidal Mercator inverse, which does
 * iterate). Pulling a projection library and its transitive tree to
 * evaluate `atan(exp(y/R))` would be a larger correctness and supply
 * chain surface than the arithmetic it replaces. If a second projection
 * ever needs support — state plane, UTM, an ellipsoidal Mercator — that
 * calculus flips and proj4 becomes the right answer; this module is
 * deliberately scoped to the ONE projection the source actually ships.
 *
 * THE SPHERE. EPSG:3857 is defined to project the WGS84 ellipsoid AS IF
 * it were a sphere of radius a = 6378137.0 m (the WGS84 semi-major
 * axis). That is not an approximation on our side — it is the
 * definition of the CRS, and it is why the inverse below round-trips
 * ArcGIS output exactly rather than approximately. Using the true
 * ellipsoidal Mercator inverse here would introduce up to ~20 km of
 * latitude error, which is precisely the trap this comment exists to
 * prevent someone from "fixing" us into.
 *
 * NOT A GUARD BYPASS. Reprojection runs BEFORE the Texas WGS84
 * coordinate-range assertion in `parse.ts`, never instead of it. A
 * county that reprojects to somewhere other than Texas still fails
 * closed. See `normalizeTxgioFeature`.
 */

import type { GeoJsonGeometry } from "./geo";

/**
 * WGS84 semi-major axis in metres — the sphere radius EPSG:3857 uses.
 * See "THE SPHERE" above: this is the CRS definition, not a
 * simplification.
 */
export const WEB_MERCATOR_RADIUS_M = 6378137.0;

/** Half the circumference of the Web Mercator sphere: the x/y extent. */
export const WEB_MERCATOR_MAX_M = Math.PI * WEB_MERCATOR_RADIUS_M;

/** Source CRS labels this module can convert FROM. */
export type SupportedSourceCrs = "EPSG:3857";

/**
 * Inverse Web Mercator for one position.
 *
 *   lon = x / R * 180/PI
 *   lat = (2 * atan(exp(y / R)) - PI/2) * 180/PI
 *
 * Pure, total, and allocation-light: it is called once per coordinate
 * of every feature of a county (millions of calls on a large county),
 * so it returns a fresh two-element tuple and does nothing else.
 */
export function webMercatorToWgs84(x: number, y: number): [number, number] {
  const longitude = (x / WEB_MERCATOR_RADIUS_M) * (180 / Math.PI);
  const latitude =
    (2 * Math.atan(Math.exp(y / WEB_MERCATOR_RADIUS_M)) - Math.PI / 2) *
    (180 / Math.PI);
  return [longitude, latitude];
}

/**
 * Forward Web Mercator — the exact inverse of `webMercatorToWgs84`.
 * The ingest never uses it; it exists so the round-trip accuracy test
 * can assert against a closed loop as well as against published
 * reference pairs.
 */
export function wgs84ToWebMercator(
  longitude: number,
  latitude: number,
): [number, number] {
  const x = (longitude * Math.PI) / 180 * WEB_MERCATOR_RADIUS_M;
  const y =
    Math.log(Math.tan(Math.PI / 4 + ((latitude * Math.PI) / 180) / 2)) *
    WEB_MERCATOR_RADIUS_M;
  return [x, y];
}

/**
 * True when a coordinate pair is in the EPSG:3857 valid range. Used to
 * refuse converting something that is not actually Web Mercator (a
 * degree pair fed in by mistake converts to a point a few metres from
 * null island and would then fail the Texas envelope — this catches it
 * earlier and with a better message).
 */
function isWebMercatorPosition(x: number, y: number): boolean {
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Math.abs(x) <= WEB_MERCATOR_MAX_M &&
    Math.abs(y) <= WEB_MERCATOR_MAX_M
  );
}

/** Thrown when a geometry cannot be reprojected at all. */
export class TxgioReprojectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TxgioReprojectionError";
  }
}

/**
 * Reproject a whole GeoJSON geometry from EPSG:3857 to EPSG:4326,
 * preserving its nesting exactly (Polygon rings, MultiPolygon
 * polygons, holes). Returns a NEW geometry; the input is not mutated,
 * so a caller that keeps the source coordinates for provenance can.
 *
 * Positions carrying a third element (Z) keep it untouched — Web
 * Mercator does not transform elevation.
 */
export function reprojectGeometry(
  geometry: GeoJsonGeometry,
  from: SupportedSourceCrs = "EPSG:3857",
): GeoJsonGeometry {
  if (from !== "EPSG:3857") {
    throw new TxgioReprojectionError(
      `unsupported source CRS "${from}" — this ingest converts EPSG:3857 ` +
        `(Web Mercator metres) only`,
    );
  }
  if (!geometry || typeof geometry !== "object") {
    throw new TxgioReprojectionError("cannot reproject a null geometry");
  }
  return {
    ...geometry,
    coordinates: mapPositions(geometry.coordinates),
  };
}

function mapPositions(node: unknown): unknown {
  if (isPosition(node)) {
    const [x, y] = node;
    if (!isWebMercatorPosition(x, y)) {
      throw new TxgioReprojectionError(
        `position [${x}, ${y}] is outside the EPSG:3857 valid extent ` +
          `(+/-${WEB_MERCATOR_MAX_M.toFixed(0)} m) — refusing to reproject ` +
          `coordinates that are not Web Mercator metres`,
      );
    }
    const [longitude, latitude] = webMercatorToWgs84(x, y);
    // Preserve any Z / M trailing components verbatim.
    return node.length > 2
      ? [longitude, latitude, ...node.slice(2)]
      : [longitude, latitude];
  }
  if (Array.isArray(node)) return node.map(mapPositions);
  return node;
}

function isPosition(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.length >= 2 &&
    typeof v[0] === "number" &&
    typeof v[1] === "number"
  );
}
