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
 * row would just duplicate it. The CAD land-use enrichment (below) is
 * therefore joined at every serve, not cached; there is no cached
 * payload for it to be stale against.
 *
 * Land-use coloring: TxGIO parcel features carry NO land-use code (the
 * StratMap parcel program ships geometry + owner/situs only), so the
 * extension's choropleth renders neutral on the Hays/Comal layer while
 * live county-GIS counties (which return USECD/PropUse) color. To close
 * that gap, `queryTxgioParcelsGeoJson` batch-joins each returned tile's
 * parcel ids to the `cad_property` roll (PR #245) on the SAME key the
 * `cad:*` brief adapters use — `(county_fips, normalizeCadPropId(prop_id))`
 * — and merges the CAD `property_use_code` onto the feature as
 * `landUseCode` plus a mapped `landUseDescription`, the same pair the
 * Williamson county provider emits. The description is NOT cosmetic:
 * the extension's paint expression (`gis-map-paint.js`) exact-matches
 * only zoning-style codes (P-5/SFR/MF/COM/AG...) and otherwise buckets
 * by KEYWORD in `landUseDescription` ("single"/"multi"/"commercial"/
 * "agric"/...), so a PTAD code like `A1` colors only through its
 * description — see `ptadLandUseDescription` for the mapping, derived
 * from the live cad_property code distribution. One query per tile,
 * not per feature. Land-use comes from a DIFFERENT source than
 * geometry (the appraisal roll, not the parcel program), so an
 * enriched feature also carries `landUseSource: "cad-roll"` + the CAD
 * `sourceVintage` as provenance. A county with no CAD roll loaded
 * (Comal today) gets zero join hits and stays honestly neutral —
 * never a fabricated code or description.
 *
 * TxGIO land parcels are informational, not survey grade (the
 * program's own disclaimer) — every feature carries
 * `notSurveyGrade: true` and the layer carries
 * `TXGIO_PARCEL_DISCLAIMER`, mirroring the #242 convention. No CLIP
 * exists on this path and none is fabricated.
 */

import { and, eq, gte, inArray, lte } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db as defaultDb, txgioParcel, cadProperty } from "@workspace/db";
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
import { parcelNodeId } from "./parcelNodeId";
import { ptadLandUseDescription } from "./ptadLandUse";

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

/**
 * PTAD state-classification code -> human land-use description for the
 * map choropleth. Extracted to the dependency-free `./ptadLandUse` module
 * (Wave D3) so the offline PMTiles bake can reuse it without importing
 * this db-backed module; re-exported here so existing import sites (and
 * `__internal` / test references) keep working unchanged.
 */
export { ptadLandUseDescription };

/**
 * Land-use attributes joined out of the CAD roll for one tile's parcels,
 * keyed by the CAD-normalized prop id (leading zeros stripped). Only the
 * cheap attrs the extension colors on are carried.
 */
interface CadLandUse {
  landUseCode: string;
  landUseSource: "cad-roll";
  landUseVintage: string;
}

/**
 * Batch-fetch CAD land-use for the parcel ids in a served tile — ONE
 * query for the whole tile, not one per feature. Joins on the same key
 * the `cad:*` brief adapters use: `(county_fips, normalizeCadPropId(
 * prop_id))`, backed by the `cad_property` primary key. Multiple
 * `tax_year` rows can exist per parcel; the latest wins (matching
 * `makeCadPropertyLookup`). Rows whose `property_use_code` is null (e.g.
 * Hays today — the Orion property export does not carry a state/use
 * code) are dropped so a parcel is enriched only when there is a real
 * code to color on. A county with no CAD roll (Comal) yields an empty
 * `ARRAY[]` predicate -> zero rows -> an empty map -> honest neutral.
 */
async function fetchCadLandUseForTile(
  database: TxgioStoreDb,
  countyFips: string,
  rows: TxgioCandidateRow[],
): Promise<Map<string, CadLandUse>> {
  const out = new Map<string, CadLandUse>();
  // Distinct CAD-normalized prop ids present in this tile.
  const propIds = new Set<string>();
  for (const row of rows) {
    if (row.propId) propIds.add(normalizeCadPropId(row.propId));
  }
  if (propIds.size === 0) return out;

  const cadRows = (await database
    .select({
      propId: cadProperty.propId,
      taxYear: cadProperty.taxYear,
      propertyUseCode: cadProperty.propertyUseCode,
      sourceVintage: cadProperty.sourceVintage,
    })
    .from(cadProperty)
    .where(
      and(
        eq(cadProperty.countyFips, countyFips),
        inArray(cadProperty.propId, [...propIds]),
      ),
    )) as {
    propId: string;
    taxYear: number;
    propertyUseCode: string | null;
    sourceVintage: string;
  }[];

  // Latest tax-year row wins per parcel; keep only rows with a real code.
  const latestYear = new Map<string, number>();
  for (const cad of cadRows) {
    if (!cad.propertyUseCode) continue;
    const prev = latestYear.get(cad.propId);
    if (prev !== undefined && prev >= cad.taxYear) continue;
    latestYear.set(cad.propId, cad.taxYear);
    out.set(cad.propId, {
      landUseCode: cad.propertyUseCode,
      landUseSource: "cad-roll",
      landUseVintage: cad.sourceVintage,
    });
  }
  return out;
}

function toFeature(
  row: TxgioCandidateRow,
  countyFips: string,
  countyName: string,
  retrievedAt: string,
  landUse?: Map<string, CadLandUse>,
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
  // Canonical parcel node identity — the ONE id the browse tile layer and
  // the live-detail layer both key on (feature-state highlight +
  // click-to-resolve). Computed from countyFips + the RAW prop id via the
  // shared helper so a parcel baked from this store and the same parcel
  // fetched live carry the SAME parcel_node_id. Omitted (never faked) when
  // there is no prop id to identify the parcel by.
  const nodeId = parcelNodeId(countyFips, row.propId);
  if (nodeId) properties.parcel_node_id = nodeId;
  if (row.situsAddress) properties.situsAddress = row.situsAddress;
  if (row.ownerName) properties.owner = row.ownerName;
  // Land-use from the CAD roll (different source than the geometry).
  // Keyed by the CAD-normalized prop id; only present when a real code
  // was found, so Comal (no roll) and code-less Hays rows stay neutral.
  if (row.propId && landUse) {
    const hit = landUse.get(normalizeCadPropId(row.propId));
    if (hit) {
      properties.landUseCode = hit.landUseCode;
      // The paint expression buckets PTAD codes by keyword in the
      // description — without it the feature stays neutral (see the
      // ptadLandUseDescription doc). Unknown codes stay code-only.
      const landUseDescription = ptadLandUseDescription(hit.landUseCode);
      if (landUseDescription) {
        properties.landUseDescription = landUseDescription;
      }
      properties.landUseSource = hit.landUseSource;
      properties.landUseVintage = hit.landUseVintage;
    }
  }
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
  // One CAD land-use join for the whole tile (empty map when no roll).
  const landUse = await fetchCadLandUseForTile(
    database,
    input.countyFips,
    rows,
  );
  const features = rows.map((row) =>
    toFeature(row, input.countyFips, input.countyName, retrievedAt, landUse),
  );

  return {
    geojson: { type: "FeatureCollection", features },
    featureCount: features.length,
    queryMode,
    truncated: truncated || undefined,
  };
}

/**
 * Fetch a single parcel's GeoJSON by its RAW appraisal prop id, as the
 * authoritative situs->parcel resolver (F4d) needs: once an address is
 * matched to a prop id via `txgio_parcel.situs_address`, this returns
 * that parcel's polygon + normalized feature (same shape/enrichment as
 * the pin/bbox reads) so the buildable-envelope route can derive the
 * envelope WITHOUT a geocode or point-in-polygon step.
 *
 * Rows are duplicated one-per-tile-cell in the store, so a prop id maps
 * to several identical-geometry rows; the first is taken (all carry the
 * same geometry + attrs). Returns null when the prop id is not present
 * in the county — the caller falls through to the coord/geocode path.
 * Land-use is joined the same single-query way as the tile reads.
 */
export async function queryTxgioParcelByPropId(input: {
  countyFips: string;
  countyName: string;
  propId: string;
  database?: TxgioStoreDb;
}): Promise<TxgioParcelsResult | null> {
  const database = input.database ?? defaultDb;
  const propId = input.propId.trim();
  if (!propId) return null;

  const candidates = (await database
    .select(candidateColumns)
    .from(txgioParcel)
    .where(
      and(
        eq(txgioParcel.countyFips, input.countyFips.trim()),
        eq(txgioParcel.propId, propId),
      ),
    )
    .limit(TXGIO_PARCEL_FEATURE_CAP)) as TxgioCandidateRow[];

  if (candidates.length === 0) return null;

  // All rows for one prop id are per-cell duplicates of the same parcel;
  // dedupe on featureIndex and keep the first.
  const seen = new Set<number>();
  const rows: TxgioCandidateRow[] = [];
  for (const row of candidates) {
    if (seen.has(row.featureIndex)) continue;
    seen.add(row.featureIndex);
    rows.push(row);
  }

  const retrievedAt = new Date().toISOString();
  const landUse = await fetchCadLandUseForTile(
    database,
    input.countyFips,
    rows,
  );
  const features = rows.map((row) =>
    toFeature(row, input.countyFips, input.countyName, retrievedAt, landUse),
  );

  return {
    geojson: { type: "FeatureCollection", features },
    featureCount: features.length,
    queryMode: "pin",
  };
}

/** Exposed for tests. */
export const __internal = { TXGIO_MAX_BBOX_CELLS, fetchCadLandUseForTile };
