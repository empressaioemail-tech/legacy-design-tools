/**
 * Self-hosted TxGIO parcel geometry store readers
 * (feat/txgio-parcel-geometry).
 *
 * Two reads over `txgio_parcel` (migration 0053; loaded by the
 * `@workspace/cad-ingest` txgio-ingest CLI from the free TxGIO/StratMap
 * statewide Land Parcels program) for counties that have NO live
 * queryable county GIS — v1: Hays (48209) and Comal (48091):
 *
 *   1. `makeTxgioParcelPointLookup` — drizzle-backed implementation of
 *      the `ParcelGeometryPointLookup` injection the `cad:*` Property
 *      Brief adapters and the parcel-key capture path declare
 *      (`lib/adapters` stays db-free, same pattern as `cadLookup`).
 *      Point -> single-cell pk scan -> ray-cast point-in-polygon.
 *
 *   2. `queryTxgioParcelsGeoJson` — bbox/pin GeoJSON for the `parcels`
 *      gis-layer, same result + feature-properties shape as the live
 *      county-GIS provider (`brokerageTxParcels.ts`) with
 *      `provider: "txgio"`. Rows are bucketed one-per-grid-cell at
 *      ingest, so bbox reads are DISTINCT ON (feature_index) scans
 *      over the covering cells' pk prefix; viewports too large for a
 *      sane cell list fall back to the bbox-column scan.
 *
 * No tile cache on this path — the local table IS the store; a cache
 * row would just duplicate it.
 *
 * TxGIO land parcels are informational, not survey grade (the
 * program's own disclaimer) — every feature carries
 * `notSurveyGrade: true` and the layer carries
 * `TXGIO_PARCEL_DISCLAIMER`, mirroring the #242 convention. No CLIP
 * exists on this path and none is fabricated.
 */

import { and, eq, gte, inArray, lte } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db as defaultDb, txgioParcel } from "@workspace/db";
import { AdapterRunError } from "@workspace/adapters/types";
import type { ParcelGeometryPointLookup } from "@workspace/adapters/types";
import {
  bboxesIntersect,
  cellKeyForPoint,
  cellKeysForBbox,
  pointInGeometry,
  type GeoBbox,
  type GeoJsonGeometry,
} from "@workspace/cad-ingest/txgio-geo";
import { normalizeCadPropId } from "./cadPropertyLookup";

export const TXGIO_PARCEL_DISCLAIMER =
  "TxGIO/StratMap land parcels are informational and not survey grade. Verify boundaries with a licensed surveyor.";

/** Feature cap per request — matches the county-GIS provider (#242). */
export const TXGIO_PARCEL_FEATURE_CAP = 200;

/**
 * Covering-cell ceiling for the pk-prefix read. A 256-cell viewport is
 * ~5km x 5km at the 0.02-degree grid — beyond that the reader switches
 * to the bbox-column scan rather than building an enormous IN list.
 */
const TXGIO_MAX_BBOX_CELLS = 256;

/** Narrow db surface, mirroring `CadLookupDb` — injectable for tests. */
export type TxgioStoreDb = Pick<
  NodePgDatabase<Record<string, unknown>>,
  "select" | "selectDistinctOn"
>;

const TXGIO_COLLECTION_ID = "0fa04328-872e-481c-b453-126a74777593";

/** Per-county TxGIO resource URL — provenance on hits and features. */
export function txgioSourceUrl(countyFips: string): string {
  return (
    `https://data.geographic.texas.gov/${TXGIO_COLLECTION_ID}/resources/` +
    `stratmap25-landparcels_${countyFips}_lp.zip`
  );
}

interface TxgioCandidateRow {
  featureIndex: number;
  propId: string | null;
  geoId: string | null;
  ownerName: string | null;
  situsAddress: string | null;
  situsCity: string | null;
  situsZip: string | null;
  geometry: unknown;
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
  sourceVintage: string;
}

const candidateColumns = {
  featureIndex: txgioParcel.featureIndex,
  propId: txgioParcel.propId,
  geoId: txgioParcel.geoId,
  ownerName: txgioParcel.ownerName,
  situsAddress: txgioParcel.situsAddress,
  situsCity: txgioParcel.situsCity,
  situsZip: txgioParcel.situsZip,
  geometry: txgioParcel.geometry,
  westLng: txgioParcel.westLng,
  southLat: txgioParcel.southLat,
  eastLng: txgioParcel.eastLng,
  northLat: txgioParcel.northLat,
  sourceVintage: txgioParcel.sourceVintage,
};

/**
 * Build the injected point->parcel lookup. One single-cell pk scan +
 * in-process ray cast; among containing parcels, the first with a
 * usable prop id wins (a containing parcel without a prop id cannot
 * join the CAD roll, so the search continues past it). Returns null
 * when no ingested parcel contains the point — the caller treats that
 * exactly like an unsupported county.
 */
export function makeTxgioParcelPointLookup(
  database: TxgioStoreDb = defaultDb,
): ParcelGeometryPointLookup {
  return async (countyFips, latitude, longitude) => {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    const cell = cellKeyForPoint(longitude, latitude);
    const rows = (await database
      .select(candidateColumns)
      .from(txgioParcel)
      .where(
        and(
          eq(txgioParcel.countyFips, countyFips.trim()),
          eq(txgioParcel.tileKey, cell),
          // Cheap pre-filter before the ray cast.
          lte(txgioParcel.westLng, longitude),
          gte(txgioParcel.eastLng, longitude),
          lte(txgioParcel.southLat, latitude),
          gte(txgioParcel.northLat, latitude),
        ),
      )) as TxgioCandidateRow[];
    for (const row of rows) {
      if (!row.propId) continue;
      if (pointInGeometry(longitude, latitude, row.geometry as GeoJsonGeometry)) {
        return {
          propId: normalizeCadPropId(row.propId),
          sourceUrl: txgioSourceUrl(countyFips.trim()),
        };
      }
    }
    return null;
  };
}

function toFeature(
  row: TxgioCandidateRow,
  countyFips: string,
  countyName: string,
  retrievedAt: string,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    provider: "txgio",
    countyFips,
    countyName,
    sourceUrl: txgioSourceUrl(countyFips),
    sourceVintage: row.sourceVintage,
    retrievedAt,
    notSurveyGrade: true,
  };
  if (row.propId) properties.apn = row.propId;
  if (row.situsAddress) properties.situsAddress = row.situsAddress;
  if (row.ownerName) properties.owner = row.ownerName;
  return {
    type: "Feature",
    geometry: row.geometry,
    properties,
  };
}

export interface TxgioParcelsResult {
  geojson: { type: "FeatureCollection"; features: unknown[] };
  featureCount: number;
  queryMode: "pin" | "bbox";
  truncated?: boolean;
}

/**
 * Bbox / pin GeoJSON out of the store, result-shape-compatible with
 * `queryTxCountyParcelsGeoJson`. Empty coverage throws the same
 * `no-coverage` AdapterRunError the county provider throws — an
 * un-ingested county never silently serves an empty layer.
 */
export async function queryTxgioParcelsGeoJson(input: {
  countyFips: string;
  countyName: string;
  bbox?: GeoBbox;
  latitude?: number;
  longitude?: number;
  database?: TxgioStoreDb;
}): Promise<TxgioParcelsResult> {
  const database = input.database ?? defaultDb;
  const label = `${input.countyName} County parcels (TxGIO/StratMap)`;

  let rows: TxgioCandidateRow[];
  let queryMode: "pin" | "bbox";

  if (input.bbox) {
    queryMode = "bbox";
    const bbox = input.bbox;
    const intersectsBbox = and(
      eq(txgioParcel.countyFips, input.countyFips),
      lte(txgioParcel.westLng, bbox.eastLng),
      gte(txgioParcel.eastLng, bbox.westLng),
      lte(txgioParcel.southLat, bbox.northLat),
      gte(txgioParcel.northLat, bbox.southLat),
    );
    const cells = cellKeysForBbox(bbox, undefined, TXGIO_MAX_BBOX_CELLS);
    // Rows are duplicated one-per-cell, so read DISTINCT ON the
    // feature id; +1 over the cap detects truncation.
    const query =
      cells !== null
        ? database
            .selectDistinctOn([txgioParcel.featureIndex], candidateColumns)
            .from(txgioParcel)
            .where(and(intersectsBbox, inArray(txgioParcel.tileKey, cells)))
        : database
            .selectDistinctOn([txgioParcel.featureIndex], candidateColumns)
            .from(txgioParcel)
            .where(intersectsBbox);
    rows = (await query
      .orderBy(txgioParcel.featureIndex)
      .limit(TXGIO_PARCEL_FEATURE_CAP + 1)) as TxgioCandidateRow[];
  } else {
    if (!Number.isFinite(input.latitude) || !Number.isFinite(input.longitude)) {
      throw new AdapterRunError(
        "parse-error",
        "latitude and longitude are required for pin-intersect parcel queries",
      );
    }
    queryMode = "pin";
    const latitude = input.latitude!;
    const longitude = input.longitude!;
    const cell = cellKeyForPoint(longitude, latitude);
    const candidates = (await database
      .select(candidateColumns)
      .from(txgioParcel)
      .where(
        and(
          eq(txgioParcel.countyFips, input.countyFips),
          eq(txgioParcel.tileKey, cell),
          lte(txgioParcel.westLng, longitude),
          gte(txgioParcel.eastLng, longitude),
          lte(txgioParcel.southLat, latitude),
          gte(txgioParcel.northLat, latitude),
        ),
      )) as TxgioCandidateRow[];
    rows = candidates.filter((row) =>
      pointInGeometry(longitude, latitude, row.geometry as GeoJsonGeometry),
    );
  }

  let truncated = false;
  if (rows.length > TXGIO_PARCEL_FEATURE_CAP) {
    rows = rows.slice(0, TXGIO_PARCEL_FEATURE_CAP);
    truncated = true;
  }
  // Defensive re-check for the bbox path: bbox-column intersection was
  // already applied in SQL, so this only drops rows on float-edge
  // disagreements.
  if (input.bbox) {
    const bbox = input.bbox;
    rows = rows.filter((row) =>
      bboxesIntersect(
        {
          westLng: row.westLng,
          southLat: row.southLat,
          eastLng: row.eastLng,
          northLat: row.northLat,
        },
        bbox,
      ),
    );
  }

  if (rows.length === 0) {
    throw new AdapterRunError(
      "no-coverage",
      `${label} has no ingested parcel polygons for this query.`,
    );
  }

  const retrievedAt = new Date().toISOString();
  const features = rows.map((row) =>
    toFeature(row, input.countyFips, input.countyName, retrievedAt),
  );

  return {
    geojson: { type: "FeatureCollection", features },
    featureCount: features.length,
    queryMode,
    truncated: truncated || undefined,
  };
}

/** Exposed for tests. */
export const __internal = { TXGIO_MAX_BBOX_CELLS };
