/**
 * ArcGIS GeoJSON feature -> normalized boundary records for
 * `tx_city_boundary` and `tx_county_boundary`.
 *
 * City field names verified live 2026-08-08 against
 * City_Boundaries/Texas_City_Boundaries/MapServer/0:
 *   city_name, geo_id, geo_id_fq, gnis, cenpop2010, popest2020, last_edit
 *
 * County field names verified live 2026-08-08 against
 * TIGERweb/State_County/MapServer/1:
 *   GEOID, NAME, STATE, COUNTY, BASENAME, COUNTYNS
 */

import type { ParseCounters } from "../types";
import { recordSkip } from "../types";
import {
  bboxOfGeometry,
  type GeoBbox,
  type GeoJsonGeometry,
} from "../txgio/geo";

export interface BoundaryFeature {
  geometry?: GeoJsonGeometry | null;
  properties?: Record<string, unknown> | null;
}

function str(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t.length > 0 ? t : null;
}

function polygonGeometry(
  geometry: BoundaryFeature["geometry"],
): GeoJsonGeometry | null {
  if (!geometry || typeof geometry !== "object") return null;
  if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") {
    return geometry;
  }
  return null;
}

export interface TxCityBoundaryRecord {
  geoId: string;
  cityName: string;
  gnis: string | null;
  geometry: GeoJsonGeometry;
  bbox: GeoBbox;
}

export interface TxCountyBoundaryRecord {
  countyFips: string;
  countyName: string;
  stateFips: string;
  geometry: GeoJsonGeometry;
  bbox: GeoBbox;
}

/** Normalize one TxGIO city-boundary GeoJSON feature. */
export function normalizeCityBoundaryFeature(
  feature: BoundaryFeature,
  counters: ParseCounters,
): TxCityBoundaryRecord | null {
  const p = feature.properties ?? {};
  const geoId = str(p.geo_id);
  const cityName = str(p.city_name);
  if (geoId === null) {
    recordSkip(counters, `objectid ${p.objectid ?? "?"}: no geo_id`);
    return null;
  }
  if (cityName === null) {
    recordSkip(counters, `${geoId}: no city_name`);
    return null;
  }
  const geometry = polygonGeometry(feature.geometry);
  if (geometry === null) {
    recordSkip(counters, `${geoId} ${cityName}: no polygon geometry`);
    return null;
  }
  const bbox = bboxOfGeometry(geometry);
  if (bbox === null) {
    recordSkip(counters, `${geoId} ${cityName}: unbounded geometry`);
    return null;
  }
  return {
    geoId,
    cityName,
    gnis: str(p.gnis),
    geometry,
    bbox,
  };
}

/** Normalize one TIGER county-boundary GeoJSON feature. */
export function normalizeCountyBoundaryFeature(
  feature: BoundaryFeature,
  counters: ParseCounters,
): TxCountyBoundaryRecord | null {
  const p = feature.properties ?? {};
  const countyFips = str(p.GEOID);
  const countyName = str(p.NAME);
  const stateFips = str(p.STATE) ?? "48";
  if (countyFips === null) {
    recordSkip(counters, `objectid ${p.OBJECTID ?? "?"}: no GEOID`);
    return null;
  }
  if (countyName === null) {
    recordSkip(counters, `${countyFips}: no NAME`);
    return null;
  }
  const geometry = polygonGeometry(feature.geometry);
  if (geometry === null) {
    recordSkip(counters, `${countyFips} ${countyName}: no polygon geometry`);
    return null;
  }
  const bbox = bboxOfGeometry(geometry);
  if (bbox === null) {
    recordSkip(counters, `${countyFips} ${countyName}: unbounded geometry`);
    return null;
  }
  return {
    countyFips,
    countyName,
    stateFips,
    geometry,
    bbox,
  };
}
