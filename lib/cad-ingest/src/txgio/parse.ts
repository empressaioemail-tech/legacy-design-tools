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
  cellKeysForBbox,
  type GeoBbox,
  type GeoJsonGeometry,
} from "./geo";

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
 * WGS84-geographic guard. The land-parcel program publishes
 * GCS_WGS_1984 (verified against the real Hays/Comal .prj files);
 * anything else means TxGIO changed the published SR and this ingest
 * must grow a real reprojection step (proj4 with the exact EPSG)
 * before loading that county — never silently store non-WGS84
 * coordinates.
 */
export function assertWgs84Prj(prjText: string, prjPath: string): void {
  const t = prjText.toUpperCase();
  if (!t.includes("GCS_WGS_1984") && !t.includes('GEOGCS["WGS 84"')) {
    throw new Error(
      `${prjPath} is not GCS_WGS_1984 — refusing to ingest non-WGS84 ` +
        `coordinates without a reprojection step. .prj: ${prjText.slice(0, 200)}`,
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

/**
 * Normalize one shapefile feature. Returns null (and counts a skip)
 * when the feature carries no usable polygon geometry — an
 * attribute-only row cannot serve either read path.
 */
export function normalizeTxgioFeature(
  countyFips: string,
  featureIndex: number,
  feature: TxgioFeature,
  counters: ParseCounters,
): TxgioParcelRecord | null {
  const geometry = feature.geometry;
  if (
    !geometry ||
    (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")
  ) {
    recordSkip(
      counters,
      `feature ${featureIndex}: no polygon geometry (${geometry?.type ?? "null"})`,
    );
    return null;
  }
  const bbox = bboxOfGeometry(geometry);
  if (!bbox) {
    recordSkip(counters, `feature ${featureIndex}: empty geometry`);
    return null;
  }
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
