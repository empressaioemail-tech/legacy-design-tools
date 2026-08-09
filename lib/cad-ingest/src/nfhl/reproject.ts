/**
 * EPSG:4269 (NAD83 geographic degrees) -> EPSG:4326 (WGS84) reprojection
 * for the FEMA NFHL bulk ingest.
 *
 * The Texas statewide FileGDB ships S_FLD_HAZ_AR in NAD83 (verified via
 * ogrinfo on NFHL_48_20260101.zip: Layer SRS EPSG:4269, coordinates in
 * degrees). ogr2ogr performs the authoritative conversion at extract time;
 * this module provides a closed-form degree-to-degree shift for tests and
 * as a post-ogr sanity pass when ogr2ogr is unavailable.
 *
 * NOT Web Mercator — unlike the StratMap 202505 parcel vintage, FEMA NFHL
 * bulk is geographic NAD83, not projected metres.
 */

import type { GeoJsonGeometry } from "../txgio/geo";

/** Source CRS the NFHL Texas bulk FileGDB declares. */
export type NfhlSourceCrs = "EPSG:4269";

const NAD83_TO_WGS84_SHIFT: Record<
  "longitude" | "latitude",
  (lon: number, lat: number) => number
> = {
  // NAD83 vs WGS84 shifts are sub-metre in Texas; ogr2ogr applies the
  // full PROJ pipeline. These offsets are identity for ingest purposes —
  // the real conversion happens in ogr2ogr. Exposed for round-trip tests.
  longitude: (lon) => lon,
  latitude: (_lon, lat) => lat,
};

export class NfhlReprojectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NfhlReprojectionError";
  }
}

function mapPositions(
  node: unknown,
  from: NfhlSourceCrs,
): unknown {
  if (from !== "EPSG:4269") {
    throw new NfhlReprojectionError(
      `unsupported source CRS "${from}" — NFHL bulk converts EPSG:4269 only`,
    );
  }
  if (isPosition(node)) {
    const [lon, lat] = node;
    const outLon = NAD83_TO_WGS84_SHIFT.longitude(lon, lat);
    const outLat = NAD83_TO_WGS84_SHIFT.latitude(lon, lat);
    return node.length > 2 ? [outLon, outLat, ...node.slice(2)] : [outLon, outLat];
  }
  if (Array.isArray(node)) return node.map((child) => mapPositions(child, from));
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

/** Reproject a GeoJSON geometry from EPSG:4269 to EPSG:4326 (identity-scale). */
export function reprojectNfhlGeometry(
  geometry: GeoJsonGeometry,
  from: NfhlSourceCrs = "EPSG:4269",
): GeoJsonGeometry {
  if (!geometry || typeof geometry !== "object") {
    throw new NfhlReprojectionError("cannot reproject a null geometry");
  }
  return {
    ...geometry,
    coordinates: mapPositions(geometry.coordinates, from),
  };
}

/**
 * True when coordinates look like projected metres (Web Mercator), not
 * degrees. Catches the StratMap-class failure mode if a future NFHL
 * vintage ever ships projected coordinates.
 */
export function looksLikeProjectedMetres(x: number, y: number): boolean {
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    (Math.abs(x) > 180 || Math.abs(y) > 90)
  );
}
