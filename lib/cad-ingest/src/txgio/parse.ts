/**
 * TxGIO land-parcel shapefile feature -> normalized `txgio_parcel`
 * record.
 *
 * Field names follow the TNRIS/TxGIO land-parcel schema
 * (cdn.tnris.org/documents/tnris-land-parcel-schema.pdf), verified
 * against the DBF headers of the real stratmap25 Hays (48209) and
 * Comal (48091) downloads 2026-07-13:
 *
 *   Prop_ID, GEO_ID, OWNER_NAME, NAME_CARE, LEGAL_AREA, LGL_AREA_U,
 *   GIS_AREA, GIS_AREA_U, LEGAL_DESC, STAT_LAND_, LOC_LAND_U,
 *   LAND_VALUE, IMP_VALUE, MKT_VALUE, SITUS_ADDR, SITUS_NUM,
 *   SITUS_STRE, SITUS_ST_1, SITUS_ST_2, SITUS_CITY, SITUS_STAT,
 *   SITUS_ZIP, MAIL_*, SOURCE, DATE_ACQ, FIPS, COUNTY, TAX_YEAR,
 *   YEAR_BUILT, OBJECTID_1, Shape_Leng, Shape_Area
 *
 * The store keeps identity + situs (the map layer's display fields
 * and the point->prop_id join); values/owner-mail attributes belong
 * to the `cad_property` roll store and are NOT duplicated here beyond
 * OWNER_NAME (which the #242 county-GIS map providers also expose).
 */

import type { ParseCounters } from "../types";
import { recordSkip } from "../types";
import {
  bboxOfGeometry,
  cellCountForBbox,
  cellKeysForBbox,
  isPlausibleTexasWgs84Bbox,
  TEXAS_WGS84_BOUNDS,
  TXGIO_MAX_FEATURE_CELLS,
  type GeoBbox,
  type GeoJsonGeometry,
} from "./geo";
import { reprojectGeometry, type SupportedSourceCrs } from "./reproject";

/** A normalized parcel feature bound for `txgio_parcel` (pre-bucketing). */
export interface TxgioParcelRecord {
  countyFips: string;
  featureIndex: number;
  propId: string | null;
  geoId: string | null;
  ownerName: string | null;
  situsAddress: string | null;
  situsCity: string | null;
  situsState: string | null;
  situsZip: string | null;
  geometry: GeoJsonGeometry;
  bbox: GeoBbox;
  /** Grid cells the feature's bbox intersects — one row per cell. */
  tileKeys: string[];
}

/** Shapefile sidecar entries we need out of the TxGIO zip's shp/ copy. */
export const TXGIO_ENTRY_FILTER = (name: string): boolean =>
  /\.(shp|dbf|prj)$/i.test(name);

/**
 * WGS84-GEOGRAPHIC guard. The land-parcel program publishes
 * GCS_WGS_1984 (verified against the real Hays/Comal .prj files);
 * anything else means TxGIO changed the published SR and this ingest
 * must grow a real reprojection step (proj4 with the exact EPSG)
 * before loading that county — never silently store non-WGS84
 * coordinates.
 *
 * TWO conditions, and the first one is the fix for the 202505 vintage
 * defect (`_inbox/2026-08-08_SWEEP_statewide_readiness.md` section 3).
 *
 * 1. The CRS must not be PROJECTED. A projected WKT nests its base
 *    datum, so the real 202505 StratMap file —
 *    `PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere",
 *     GEOGCS["GCS_WGS_1984", ...]]` — CONTAINS the `GCS_WGS_1984`
 *    substring and passed the old datum-only test while shipping
 *    coordinates in METERS (EPSG:3857), not degrees. 12 of 12 sampled
 *    202505 counties are Web Mercator; 57 of the 235 unloaded counties
 *    are on that vintage. Projected coordinates are not ingestible
 *    without a reprojection step this pipeline does not have.
 * 2. The datum must be WGS84, as before.
 *
 * This guard is necessary but NOT sufficient — it can only read a
 * declaration, and the `.prj` may be absent entirely. The coordinate
 * range assertion below (`assertTexasWgs84Bbox`, applied per feature in
 * `normalizeTxgioFeature`) is the durable guard because it tests the
 * coordinates themselves.
 */
export function assertWgs84Prj(prjText: string, prjPath: string): void {
  const t = prjText.toUpperCase();
  if (t.trimStart().startsWith("PROJCS")) {
    throw new Error(
      `${prjPath} declares a PROJECTED coordinate system — refusing to ` +
        `ingest projected coordinates (meters/feet) without a reprojection ` +
        `step. Only a geographic WGS84 CRS (degrees) is ingestible. ` +
        `.prj: ${prjText.slice(0, 200)}`,
    );
  }
  if (!t.includes("GCS_WGS_1984") && !t.includes('GEOGCS["WGS 84"')) {
    throw new Error(
      `${prjPath} is not GCS_WGS_1984 — refusing to ingest non-WGS84 ` +
        `coordinates without a reprojection step. .prj: ${prjText.slice(0, 200)}`,
    );
  }
}

/**
 * What a `.prj` declares, as far as this ingest is concerned.
 *
 * `wgs84-geographic`  degrees, ingestible as-is.
 * `web-mercator`      EPSG:3857 metres — ingestible ONLY with an
 *                     explicit `--reproject=3857`.
 * `unsupported`       anything else (state plane, NAD83, a projection
 *                     we have no inverse for). Never ingestible.
 */
export type TxgioPrjKind =
  | "wgs84-geographic"
  | "web-mercator"
  | "unsupported";

/**
 * CLASSIFY a `.prj` rather than merely accepting or refusing it, so the
 * CLI can tell "this county is projected and I know how to convert it"
 * apart from "this county is projected and I do not".
 *
 * `assertWgs84Prj` above is unchanged and still the strict gate: a
 * caller that has not been given explicit operator permission to
 * reproject calls IT, and a PROJCS still throws. This function exists
 * only so that the `--reproject=3857` path can recognize the ONE
 * projection we can invert, and so that a DIFFERENT projection — a
 * state-plane county, say — still fails closed even when the operator
 * passed the flag. The flag authorizes converting Web Mercator; it does
 * not authorize converting whatever happens to show up.
 *
 * The detection is deliberately narrow: `Mercator_Auxiliary_Sphere`
 * with a WGS84 datum and metre units, which is exactly what the 202505
 * StratMap vintage ships. A Mercator on a different sphere or datum is
 * NOT this, and must not be silently swept in.
 */
export function classifyPrj(prjText: string): TxgioPrjKind {
  const t = prjText.toUpperCase();
  const isProjected = t.trimStart().startsWith("PROJCS");
  const isWgs84Datum =
    t.includes("GCS_WGS_1984") || t.includes('GEOGCS["WGS 84"');
  if (!isProjected) {
    return isWgs84Datum ? "wgs84-geographic" : "unsupported";
  }
  const isAuxSphereMercator =
    t.includes("MERCATOR_AUXILIARY_SPHERE") ||
    t.includes("WGS_1984_WEB_MERCATOR") ||
    t.includes("PSEUDO-MERCATOR");
  const isMetres = t.includes('UNIT["METER"') || t.includes('UNIT["METRE"');
  if (isAuxSphereMercator && isWgs84Datum && isMetres) return "web-mercator";
  return "unsupported";
}

/** Thrown when a feature's coordinates are not plausible Texas degrees. */
export class TxgioProjectionError extends Error {
  readonly bbox: GeoBbox;
  constructor(message: string, bbox: GeoBbox) {
    super(message);
    this.name = "TxgioProjectionError";
    this.bbox = bbox;
  }
}

/**
 * THE DURABLE PROJECTION GUARD. Asserts a parsed feature's bbox falls
 * inside the plausible Texas WGS84 degree envelope, and that it buckets
 * into a sane number of grid cells.
 *
 * Unlike `assertWgs84Prj` this depends on no WKT parsing and no sidecar
 * file, so it catches every way the declaration can be wrong or absent:
 * a projected CRS (Web Mercator meters land near x=-11,200,000), a
 * MISSING `.prj` (which the CLI only warns about), a swapped lat/lng
 * axis order, and any future change to what the StratMap program
 * publishes. It is fail-closed by construction: a county whose
 * coordinates are not degrees cannot be loaded at all.
 *
 * This throws rather than counting a skip. A projection error is a
 * WHOLE-COUNTY property, not a per-feature data defect; skipping would
 * silently load zero or a handful of rows and report success.
 */
export function assertTexasWgs84Bbox(
  bbox: GeoBbox,
  context: string,
): void {
  if (!isPlausibleTexasWgs84Bbox(bbox)) {
    throw new TxgioProjectionError(
      `${context}: bbox [${bbox.westLng}, ${bbox.southLat}, ${bbox.eastLng}, ` +
        `${bbox.northLat}] falls outside the plausible Texas WGS84 envelope ` +
        `[${TEXAS_WGS84_BOUNDS.westLng}, ${TEXAS_WGS84_BOUNDS.southLat}, ` +
        `${TEXAS_WGS84_BOUNDS.eastLng}, ${TEXAS_WGS84_BOUNDS.northLat}] — ` +
        `coordinates are not WGS84 degrees (projected meters? swapped axes?). ` +
        `Refusing to ingest.`,
      bbox,
    );
  }
  const cells = cellCountForBbox(bbox);
  if (!Number.isFinite(cells) || cells > TXGIO_MAX_FEATURE_CELLS) {
    throw new TxgioProjectionError(
      `${context}: bbox [${bbox.westLng}, ${bbox.southLat}, ${bbox.eastLng}, ` +
        `${bbox.northLat}] buckets into ${cells} grid cells, above the ` +
        `${TXGIO_MAX_FEATURE_CELLS} per-feature ceiling — no real parcel ` +
        `spans that area. Refusing to ingest.`,
      bbox,
    );
  }
}

function str(v: unknown): string | null {
  if (typeof v !== "string") {
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    return null;
  }
  const t = v.replace(/\s+/g, " ").trim();
  return t.length > 0 ? t : null;
}

export interface TxgioFeature {
  geometry?: GeoJsonGeometry | null;
  properties?: Record<string, unknown> | null;
}

/** Per-run parse options. */
export interface TxgioNormalizeOptions {
  /**
   * Source CRS to convert FROM before the Texas envelope assertion.
   * Undefined (the default) means NO conversion: coordinates are taken
   * as WGS84 degrees and a projected county fails closed, exactly as
   * before. This is opt-in by construction — there is no detection
   * inside the parser that can turn it on.
   */
  reprojectFrom?: SupportedSourceCrs;
}

/**
 * Normalize one shapefile feature. Returns null (and counts a skip)
 * when the feature carries no usable polygon geometry — an
 * attribute-only row cannot serve either read path.
 *
 * REPROJECTION ORDERING. When `opts.reprojectFrom` is set, coordinates
 * are converted FIRST and every downstream step — bbox, the Texas
 * envelope assertion, cell bucketing, the stored geometry — sees only
 * degrees. The assertion therefore still runs, on the CONVERTED
 * coordinates, and a county that reprojects to somewhere other than
 * Texas fails closed exactly as an unconverted projected county does.
 * Reprojection is a step before the guard, never a way around it.
 */
export function normalizeTxgioFeature(
  countyFips: string,
  featureIndex: number,
  feature: TxgioFeature,
  counters: ParseCounters,
  opts: TxgioNormalizeOptions = {},
): TxgioParcelRecord | null {
  const sourceGeometry = feature.geometry;
  if (
    !sourceGeometry ||
    (sourceGeometry.type !== "Polygon" &&
      sourceGeometry.type !== "MultiPolygon")
  ) {
    recordSkip(
      counters,
      `feature ${featureIndex}: no polygon geometry (${sourceGeometry?.type ?? "null"})`,
    );
    return null;
  }
  // Convert BEFORE the guard, never instead of it (see the note above).
  // A throw here is a whole-county property like a projection error, so
  // it propagates rather than counting a skip.
  const geometry = opts.reprojectFrom
    ? reprojectGeometry(sourceGeometry, opts.reprojectFrom)
    : sourceGeometry;
  const bbox = bboxOfGeometry(geometry);
  if (!bbox) {
    recordSkip(counters, `feature ${featureIndex}: empty geometry`);
    return null;
  }
  // Fail-closed projection guard — see assertTexasWgs84Bbox. Throws
  // (does NOT skip): non-degree coordinates are a whole-county
  // property, so the run must abort rather than load a partial county.
  assertTexasWgs84Bbox(bbox, `county ${countyFips} feature ${featureIndex}`);
  const tileKeys = cellKeysForBbox(bbox);
  if (tileKeys === null || tileKeys.length === 0) {
    // Unbounded maxCells is never null; empty means a degenerate bbox.
    recordSkip(counters, `feature ${featureIndex}: degenerate bbox`);
    return null;
  }

  const p = feature.properties ?? {};
  return {
    countyFips,
    featureIndex,
    propId: str(p.Prop_ID),
    geoId: str(p.GEO_ID),
    ownerName: str(p.OWNER_NAME),
    situsAddress: str(p.SITUS_ADDR),
    situsCity: str(p.SITUS_CITY),
    situsState: str(p.SITUS_STAT),
    situsZip: str(p.SITUS_ZIP),
    geometry,
    bbox,
    tileKeys,
  };
}
