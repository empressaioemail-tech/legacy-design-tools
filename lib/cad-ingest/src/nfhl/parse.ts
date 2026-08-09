/**
 * GeoJSON feature -> normalized `tx_fema_nfhl_flood_zone` record.
 *
 * Field names verified live 2026-08-08 against:
 *   - S_FLD_HAZ_AR in NFHL_48_20260101.gdb (ogrinfo -so)
 *   - ArcGIS MapServer/28 sample (FLD_ZONE, ZONE_SUBTY, SFHA_TF,
 *     STATIC_BFE, DFIRM_ID, FLD_AR_ID, OBJECTID)
 *
 * Projection guard: after ogr2ogr emits EPSG:4326, every feature bbox
 * is range-asserted against the plausible Texas WGS84 envelope
 * (`assertTexasWgs84Bbox`, same discipline as txgio/parse.ts PR #396/#397).
 * PROJCS / metre coordinates are refused explicitly.
 */

import type { ParseCounters } from "../types";
import { recordSkip } from "../types";
import {
  bboxOfGeometry,
  type GeoBbox,
  type GeoJsonGeometry,
} from "../txgio/geo";
import { assertTexasWgs84Bbox } from "../txgio/parse";
import { looksLikeProjectedMetres } from "./reproject";
import { NFHL_NULL_NUMERIC } from "./service";

export interface NfhlFeature {
  type?: string;
  geometry?: GeoJsonGeometry | null;
  properties?: Record<string, unknown> | null;
}

export interface TxFemaNfhlFloodZoneRecord {
  zoneRowId: string;
  dfirmId: string;
  fldArId: string;
  fldZone: string | null;
  zoneSubty: string | null;
  sfhaTf: string | null;
  staticBfe: number | null;
  femaObjectId: number | null;
  geometry: GeoJsonGeometry;
  bbox: GeoBbox;
}

function str(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t.length > 0 ? t : null;
}

function numOrNull(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v === NFHL_NULL_NUMERIC) return null;
  return v;
}

function polygonGeometry(
  geometry: NfhlFeature["geometry"],
): GeoJsonGeometry | null {
  if (!geometry || typeof geometry !== "object") return null;
  if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") {
    return geometry;
  }
  return null;
}

/**
 * Refuse coordinates that are clearly projected metres, mirroring the
 * txgio PROJCS guard. Applied by walking the first ring vertex.
 */
export function assertNfhlGeographicCoordinates(
  geometry: GeoJsonGeometry,
  context: string,
): void {
  const sample = firstPosition(geometry);
  if (sample === null) return;
  const [x, y] = sample;
  if (looksLikeProjectedMetres(x, y)) {
    throw new Error(
      `${context}: coordinates [${x}, ${y}] look like projected metres, ` +
        "not WGS84 degrees — refusing to ingest without reprojection",
    );
  }
}

function firstPosition(geometry: GeoJsonGeometry): [number, number] | null {
  function walk(node: unknown): [number, number] | null {
    if (
      Array.isArray(node) &&
      node.length >= 2 &&
      typeof node[0] === "number" &&
      typeof node[1] === "number" &&
      !Array.isArray(node[0])
    ) {
      return [node[0], node[1]];
    }
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = walk(child);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(geometry.coordinates);
}

/** Normalize one S_FLD_HAZ_AR GeoJSON feature. */
export function normalizeNfhlFeature(
  feature: NfhlFeature,
  counters: ParseCounters,
): TxFemaNfhlFloodZoneRecord | null {
  const p = feature.properties ?? {};
  const dfirmId = str(p.DFIRM_ID);
  const fldArId = str(p.FLD_AR_ID);
  if (dfirmId === null) {
    recordSkip(counters, `objectid ${p.OBJECTID ?? "?"}: no DFIRM_ID`);
    return null;
  }
  if (fldArId === null) {
    recordSkip(counters, `${dfirmId}: no FLD_AR_ID`);
    return null;
  }
  const geometry = polygonGeometry(feature.geometry);
  if (geometry === null) {
    recordSkip(counters, `${dfirmId}:${fldArId}: no polygon geometry`);
    return null;
  }
  try {
    assertNfhlGeographicCoordinates(geometry, `${dfirmId}:${fldArId}`);
  } catch (err) {
    recordSkip(
      counters,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
  const bbox = bboxOfGeometry(geometry);
  if (bbox === null) {
    recordSkip(counters, `${dfirmId}:${fldArId}: unbounded geometry`);
    return null;
  }
  try {
    assertTexasWgs84Bbox(bbox, `${dfirmId}:${fldArId}`);
  } catch (err) {
    recordSkip(
      counters,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
  const objectRaw = p.OBJECTID;
  const femaObjectId =
    typeof objectRaw === "number" && Number.isFinite(objectRaw)
      ? objectRaw
      : null;
  return {
    zoneRowId: `${dfirmId}:${fldArId}`,
    dfirmId,
    fldArId,
    fldZone: str(p.FLD_ZONE),
    zoneSubty: str(p.ZONE_SUBTY),
    sfhaTf: str(p.SFHA_TF),
    staticBfe: numOrNull(p.STATIC_BFE),
    femaObjectId,
    geometry,
    bbox,
  };
}
