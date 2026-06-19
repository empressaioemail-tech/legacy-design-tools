/**
 * Max-tier map-data GIS proxy — Cotality Spatial Tile parcels (national) + FEMA NFHL flood.
 */

import {
  arcgisEnvelopeQueryGeoJson,
  arcgisPointQueryGeoJson,
  type ArcGisEnvelopeBbox,
  type ArcGisGeoJsonFeatureCollection,
} from "@workspace/adapters/arcgis";
import {
  buildPolygonFeature,
  cotalityGetWithApp,
  cotalitySpatialTileBaseUrl,
  inferPolygonGeomType,
  normalizeGeometryToCoordinates,
  type NormalizedFeature,
} from "@workspace/adapters/national/cotalityClient";
import { AdapterRunError } from "@workspace/adapters/types";
import {
  isFederalGisProxyLayer,
  listFederalGisLayerEndpoints,
  queryFederalGisLayerGeoJson,
  federalGisLayerFixtureGeoJson,
} from "./brokerageGisFederalLayers";
import {
  tileKey,
  normalizeAddrKey,
  getSpatialTile,
  putSpatialTile,
  getPropertyAttr,
  putPropertyAttr,
  getGeocodeClip,
  putGeocodeClip,
} from "./brokerageGisCache";

const FEMA_NFHL_FLOOD_ZONES =
  "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28";

const COTALITY_PARCELS_PATH =
  process.env.COTALITY_SPATIALTILE_POINT_PATH ?? "/parcels";

const VIEWPORT_PAGE_SIZE = 50;
const MAX_VIEWPORT_PAGES = 4;
const ZONING_ENRICH_CONCURRENCY = 20;
const MAX_BBOX_ZONING_ENRICH = 25;

export type GisProxyLayerKey =
  | "fema"
  | "parcels"
  | "ssurgo-soils"
  | "groundwater"
  | "mud-pid"
  | "edwards-aquifer"
  | "texas-rrc";

export type GisLayerEndpoint = {
  layer: GisProxyLayerKey;
  serviceUrl: string;
  provider: string;
  adapterKey: string;
  degraded?: boolean;
  degradedReason?: string;
};

export type GisLayerBbox = ArcGisEnvelopeBbox;

export type GisLayerBboxInput =
  | GisLayerBbox
  | { west: number; south: number; east: number; north: number }
  | { xmin: number; ymin: number; xmax: number; ymax: number };

export function normalizeGisLayerBbox(bbox: GisLayerBboxInput): GisLayerBbox {
  if ("westLng" in bbox) {
    return bbox;
  }
  if ("west" in bbox) {
    return {
      westLng: bbox.west,
      southLat: bbox.south,
      eastLng: bbox.east,
      northLat: bbox.north,
    };
  }
  return {
    westLng: bbox.xmin,
    southLat: bbox.ymin,
    eastLng: bbox.xmax,
    northLat: bbox.ymax,
  };
}

export function listGisLayerEndpoints(): GisLayerEndpoint[] {
  return [
    {
      layer: "fema",
      serviceUrl: FEMA_NFHL_FLOOD_ZONES,
      provider: "FEMA NFHL",
      adapterKey: "fema:nfhl-flood-zone",
    },
    {
      layer: "parcels",
      serviceUrl: cotalitySpatialTileBaseUrl(),
      provider: "Cotality Spatial Tile",
      adapterKey: "cotality:parcels",
    },
    ...listFederalGisLayerEndpoints(),
  ];
}

export function resolveGisLayerEndpoint(
  layer: GisProxyLayerKey,
): GisLayerEndpoint | null {
  return listGisLayerEndpoints().find((l) => l.layer === layer) ?? null;
}

export type GisLayerGeoJsonResult = GisLayerEndpoint & {
  geojson: ArcGisGeoJsonFeatureCollection;
  featureCount: number;
  queryMode: "pin" | "bbox";
  truncated?: boolean;
};

type SpatialParcelRow = Record<string, unknown>;

function spatialParcelRows(json: unknown): SpatialParcelRow[] {
  if (!json || typeof json !== "object") return [];
  const root = json as Record<string, unknown>;
  const list =
    (Array.isArray(root.parcels) ? root.parcels : null) ??
    (Array.isArray(root.items) ? root.items : null) ??
    (Array.isArray(root.features) ? root.features : null);
  return (list ?? []) as SpatialParcelRow[];
}

function spatialPageHasMore(
  json: unknown,
  pageNumber: number,
  pageSize: number,
): boolean {
  if (!json || typeof json !== "object") return false;
  const root = json as Record<string, unknown>;
  if (root.exceededTransferLimit === true) return true;
  const pageInfo = root.pageInfo as Record<string, unknown> | undefined;
  if (pageInfo) {
    const totalPages = Number(pageInfo.totalPages);
    if (Number.isFinite(totalPages) && totalPages > pageNumber) return true;
  }
  return spatialParcelRows(json).length >= pageSize;
}

function clipFromParcelRow(row: SpatialParcelRow): string | null {
  const clip = row.clip ?? row.CLIP ?? row.parcelClip;
  if (typeof clip === "string" && clip.trim()) return clip.trim();
  if (typeof clip === "number" && Number.isFinite(clip)) return String(clip);
  return null;
}

function normalizeStateCode(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const t = raw.trim();
  if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase();
  const fromZip = t.match(/\b([A-Za-z]{2})\b(?:\s+\d{5})?/)?.[1];
  return fromZip ? fromZip.toUpperCase() : null;
}

function catalogAddressFromSpatialRow(
  row: SpatialParcelRow,
): { streetAddress: string; city: string; state: string } | null {
  const streetRaw = [row.stdAddr, row.stdAddress, row.situsAddress, row.address].find(
    (v) => typeof v === "string" && v.trim(),
  );
  const cityRaw = [row.stdCity, row.city].find(
    (v) => typeof v === "string" && v.trim(),
  );
  const stateRaw = [row.stdState, row.state].find(
    (v) => typeof v === "string" && v.trim(),
  );
  const streetAddress =
    typeof streetRaw === "string" ? streetRaw.trim() : "";
  const city = typeof cityRaw === "string" ? cityRaw.trim() : "";
  const state = normalizeStateCode(stateRaw);
  if (!streetAddress || !city || !state) return null;
  return { streetAddress, city, state };
}

function clipFromGeocodeJson(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const root = json as Record<string, unknown>;
  const lists = [root.items, root.properties, root.results, root.data].filter(
    Array.isArray,
  ) as unknown[][];
  for (const list of lists) {
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const clip = (item as Record<string, unknown>).clip ?? (item as Record<string, unknown>).CLIP;
      if (typeof clip === "string" && clip.trim()) return clip.trim();
      if (typeof clip === "number" && Number.isFinite(clip)) return String(clip);
    }
  }
  const direct = root.clip ?? root.CLIP;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  if (typeof direct === "number" && Number.isFinite(direct)) return String(direct);
  return null;
}

async function resolveClipForSpatialRow(
  row: SpatialParcelRow,
  forceRefresh = false,
): Promise<string | null> {
  const direct = clipFromParcelRow(row);
  if (direct) return direct;
  const catalog = catalogAddressFromSpatialRow(row);
  if (!catalog) return null;

  const ak = normalizeAddrKey(
    catalog.streetAddress,
    catalog.city,
    catalog.state,
  );
  if (!forceRefresh) {
    const cached = await getGeocodeClip(ak);
    if (cached !== null) return cached.clip;
  }

  try {
    const json = await cotalityGetWithApp({
      app: "property",
      path: "/search/geocode",
      query: {
        streetAddress: catalog.streetAddress,
        city: catalog.city,
        state: catalog.state,
        bestMatch: "true",
      },
      adapterKeyForLog: "brokerage:gis-layer-geocode",
      label: "property-geocode",
    });
    const resolved = clipFromGeocodeJson(json);
    await putGeocodeClip(ak, resolved);
    return resolved;
  } catch {
    await putGeocodeClip(ak, null);
    return null;
  }
}

function pickRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function hoaAttrsFromJson(hoaJson: unknown): Record<string, unknown> {
  const rec = pickRecord(hoaJson);
  const hoaName = rec.hoaName ?? rec.associationName ?? rec.name ?? null;
  const hoaFee = rec.hoaFee ?? rec.fee ?? rec.dues ?? null;
  const hasHoaOnRecord = Boolean(hoaName || hoaFee);
  return {
    hoaName,
    hoaFee,
    hasHoaOnRecord,
    noHoaOnRecord: !hasHoaOnRecord,
  };
}

function comparablesAttrsFromJson(compsJson: unknown): Record<string, unknown> {
  const rec = pickRecord(compsJson);
  const list = [rec.comparables, rec.items, rec.results, rec.data].find(
    Array.isArray,
  ) as unknown[] | undefined;
  return {
    comparableCount: Array.isArray(list) ? list.length : 0,
  };
}

async function fetchHoaAttrs(
  clip: string,
  forceRefresh = false,
): Promise<Record<string, unknown>> {
  if (!forceRefresh) {
    const cached = await getPropertyAttr(clip, "hoa");
    if (cached) return hoaAttrsFromJson(cached.payload);
  }

  const hoaJson = await cotalityGetWithApp({
    app: "property",
    path: `/${clip}/home-owners-association`,
    adapterKeyForLog: "brokerage:gis-layer-hoa",
    label: "property-hoa",
  }).catch(() => null);

  if (!hoaJson) {
    const negative = {
      hasHoaOnRecord: false,
      noHoaOnRecord: true,
      hoaName: null,
      hoaFee: null,
    };
    await putPropertyAttr(clip, "hoa", negative);
    return negative;
  }

  await putPropertyAttr(clip, "hoa", hoaJson);
  return hoaAttrsFromJson(hoaJson);
}

async function fetchComparablesAttrs(
  clip: string,
  forceRefresh = false,
): Promise<Record<string, unknown>> {
  if (!forceRefresh) {
    const cached = await getPropertyAttr(clip, "comparables");
    if (cached) return comparablesAttrsFromJson(cached.payload);
  }

  const compsJson = await cotalityGetWithApp({
    app: "property",
    path: `/${clip}/comparables`,
    adapterKeyForLog: "brokerage:gis-layer-comparables",
    label: "property-comparables",
  }).catch(() => null);

  if (!compsJson) {
    const negative = { comparableCount: 0 };
    await putPropertyAttr(clip, "comparables", negative);
    return negative;
  }

  await putPropertyAttr(clip, "comparables", compsJson);
  return comparablesAttrsFromJson(compsJson);
}

function landUseZoningFromSiteLocation(siteJson: unknown): Record<string, unknown> {
  if (!siteJson || typeof siteJson !== "object") return {};
  const root = siteJson as Record<string, unknown>;
  const luz =
    (root.landUseAndZoningCodes as Record<string, unknown> | undefined) ??
    (root.landUseAndZoning as Record<string, unknown> | undefined) ??
    root;
  return {
    zoningCode: luz.zoningCode ?? luz.zoning ?? luz.code ?? null,
    zoningDescription:
      luz.zoningDescription ?? luz.description ?? luz.zoningDesc ?? null,
    landUseCode: luz.landUseCode ?? luz.landUse ?? null,
    landUseDescription: luz.landUseDescription ?? null,
  };
}

async function fetchSiteLocationZoning(
  clip: string,
  forceRefresh = false,
): Promise<Record<string, unknown>> {
  if (!forceRefresh) {
    const cached = await getPropertyAttr(clip, "site-location");
    if (cached) return landUseZoningFromSiteLocation(cached.payload);
  }

  const siteJson = await cotalityGetWithApp({
    app: "property",
    path: `/${clip}/site-location`,
    adapterKeyForLog: "brokerage:gis-layer-zoning",
    label: "property-site-location",
  });
  await putPropertyAttr(clip, "site-location", siteJson);
  return landUseZoningFromSiteLocation(siteJson);
}

async function enrichParcelsWithZoning(
  rows: SpatialParcelRow[],
  maxEnrich = rows.length,
  forceRefresh = false,
): Promise<SpatialParcelRow[]> {
  const out = rows.map((row) => ({ ...row }));
  const limit = Math.min(rows.length, Math.max(0, maxEnrich));
  let index = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = index++;
      if (i >= limit) return;
      const clip = await resolveClipForSpatialRow(out[i], forceRefresh);
      if (clip) {
        try {
          const zoning = await fetchSiteLocationZoning(clip, forceRefresh);
          Object.assign(out[i], zoning);
        } catch {
          /* polygon still renders without zoning attrs */
        }
        try {
          const hoa = await fetchHoaAttrs(clip, forceRefresh);
          Object.assign(out[i], hoa);
        } catch {
          /* polygon still renders without HOA attrs */
        }
        try {
          const comps = await fetchComparablesAttrs(clip, forceRefresh);
          Object.assign(out[i], comps);
        } catch {
          /* polygon still renders without comps attrs */
        }
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(ZONING_ENRICH_CONCURRENCY, limit) },
    () => worker(),
  );
  await Promise.all(workers);
  return out;
}

function parcelRowToFeature(row: SpatialParcelRow): NormalizedFeature | null {
  const geometry = row.geometry ?? (row.parcel as Record<string, unknown> | undefined)?.geometry;
  const coords = normalizeGeometryToCoordinates(geometry);
  if (!coords) return null;
  const geomType = inferPolygonGeomType(coords);
  const { geometry: _g, parcel: _p, ...props } = row;
  return buildPolygonFeature(coords, props, geomType);
}

export function rowsToFeatureCollection(
  rows: SpatialParcelRow[],
): ArcGisGeoJsonFeatureCollection {
  const features: unknown[] = [];
  for (const row of rows) {
    const feature = parcelRowToFeature(row);
    if (feature) features.push(feature);
  }
  return { type: "FeatureCollection", features };
}

async function fetchCotalityParcelsPage(input: {
  bbox?: GisLayerBbox;
  latitude?: number;
  longitude?: number;
  pageNumber: number;
  pageSize: number;
}): Promise<unknown> {
  const query: Record<string, string | number> = {
    pageNumber: input.pageNumber,
    pageSize: input.pageSize,
  };

  if (input.bbox) {
    query.bbox = `${input.bbox.westLng},${input.bbox.southLat},${input.bbox.eastLng},${input.bbox.northLat}`;
  } else if (
    Number.isFinite(input.latitude) &&
    Number.isFinite(input.longitude)
  ) {
    query.lat = input.latitude!;
    query.lon = input.longitude!;
    query.latitude = input.latitude!;
    query.longitude = input.longitude!;
  }

  return cotalityGetWithApp({
    app: "spatialtile",
    path: COTALITY_PARCELS_PATH,
    query,
    adapterKeyForLog: "brokerage:gis-layer-parcels",
    label: "spatialtile-parcels",
  });
}

async function queryCotalityParcelsGeoJson(input: {
  latitude?: number;
  longitude?: number;
  bbox?: GisLayerBbox;
  forceRefresh?: boolean;
}): Promise<{
  geojson: ArcGisGeoJsonFeatureCollection;
  featureCount: number;
  queryMode: "pin" | "bbox";
  truncated?: boolean;
}> {
  const isBbox = Boolean(input.bbox);

  if (isBbox && input.bbox && !input.forceRefresh) {
    const key = tileKey("parcels", input.bbox);
    const hit = await getSpatialTile(key);
    if (hit?.payload && typeof hit.payload === "object") {
      const cached = hit.payload as {
        geojson?: ArcGisGeoJsonFeatureCollection;
        featureCount?: number;
        queryMode?: "pin" | "bbox";
        truncated?: boolean;
      };
      if (cached.geojson?.type === "FeatureCollection") {
        return {
          geojson: cached.geojson,
          featureCount:
            hit.featureCount ??
            cached.featureCount ??
            cached.geojson.features.length,
          queryMode: cached.queryMode ?? "bbox",
          truncated: cached.truncated,
        };
      }
    }
  }

  const pageSize = isBbox ? VIEWPORT_PAGE_SIZE : 1;
  const maxPages = isBbox ? MAX_VIEWPORT_PAGES : 1;
  const rows: SpatialParcelRow[] = [];
  let truncated = false;

  for (let page = 1; page <= maxPages; page++) {
    const json = await fetchCotalityParcelsPage({
      bbox: input.bbox,
      latitude: input.latitude,
      longitude: input.longitude,
      pageNumber: page,
      pageSize,
    });
    rows.push(...spatialParcelRows(json));
    const more = spatialPageHasMore(json, page, pageSize);
    if (!more) break;
    if (page === maxPages) truncated = true;
  }

  if (rows.length === 0) {
    throw new AdapterRunError(
      "no-coverage",
      "Cotality Spatial Tile returned no parcel polygons for this query.",
    );
  }

  const result = await buildParcelsGeoJsonFromSpatialRows({
    rows,
    bbox: input.bbox,
    truncated: truncated || undefined,
    forceRefresh: input.forceRefresh,
  });

  if (isBbox && input.bbox) {
    const key = tileKey("parcels", input.bbox);
    await putSpatialTile(key, result, result.featureCount);
  }

  return result;
}

export async function buildParcelsGeoJsonFromSpatialRows(input: {
  rows: SpatialParcelRow[];
  bbox?: GisLayerBbox;
  truncated?: boolean;
  forceRefresh?: boolean;
}): Promise<{
  geojson: ArcGisGeoJsonFeatureCollection;
  featureCount: number;
  queryMode: "pin" | "bbox";
  truncated?: boolean;
}> {
  const isBbox = Boolean(input.bbox);
  if (input.rows.length === 0) {
    throw new AdapterRunError(
      "no-coverage",
      "Cotality Spatial Tile returned no parcel polygons for this query.",
    );
  }

  const enriched = await enrichParcelsWithZoning(
    input.rows,
    isBbox ? MAX_BBOX_ZONING_ENRICH : input.rows.length,
    input.forceRefresh,
  );
  const geojson = rowsToFeatureCollection(enriched);

  return {
    geojson,
    featureCount: geojson.features.length,
    queryMode: isBbox ? "bbox" : "pin",
    truncated: input.truncated || undefined,
  };
}

export async function queryGisLayerGeoJson(input: {
  layer: GisProxyLayerKey;
  latitude?: number;
  longitude?: number;
  bbox?: GisLayerBboxInput;
  forceRefresh?: boolean;
}): Promise<GisLayerGeoJsonResult> {
  const endpoint = resolveGisLayerEndpoint(input.layer);
  if (!endpoint) {
    throw new AdapterRunError("no-coverage", `GIS layer unavailable: ${input.layer}`);
  }

  if (isFederalGisProxyLayer(input.layer)) {
    const bbox = input.bbox ? normalizeGisLayerBbox(input.bbox) : undefined;
    const result = await queryFederalGisLayerGeoJson({
      layer: input.layer,
      bbox,
    });
    return {
      ...result,
      queryMode: "bbox",
    };
  }

  if (input.layer === "parcels") {
    const bbox = input.bbox ? normalizeGisLayerBbox(input.bbox) : undefined;
    if (bbox && (bbox.westLng >= bbox.eastLng || bbox.southLat >= bbox.northLat)) {
      throw new AdapterRunError(
        "parse-error",
        "bbox must have west < east and south < north",
      );
    }
    if (!bbox && (!Number.isFinite(input.latitude) || !Number.isFinite(input.longitude))) {
      throw new AdapterRunError(
        "parse-error",
        "latitude and longitude are required for pin-intersect parcel queries",
      );
    }

    const result = await queryCotalityParcelsGeoJson({
      bbox,
      latitude: input.latitude,
      longitude: input.longitude,
      forceRefresh: input.forceRefresh,
    });

    return {
      ...endpoint,
      ...result,
    };
  }

  if (!input.bbox) {
    if (!Number.isFinite(input.latitude) || !Number.isFinite(input.longitude)) {
      throw new AdapterRunError(
        "parse-error",
        "bbox or latitude+longitude required for FEMA flood queries",
      );
    }
    const geojson = await arcgisPointQueryGeoJson({
      serviceUrl: endpoint.serviceUrl,
      latitude: input.latitude!,
      longitude: input.longitude!,
      upstreamLabel: endpoint.provider,
    });
    return {
      ...endpoint,
      geojson,
      featureCount: geojson.features.length,
      queryMode: "pin",
    };
  }

  const bbox = normalizeGisLayerBbox(input.bbox);
  if (bbox.westLng >= bbox.eastLng || bbox.southLat >= bbox.northLat) {
    throw new AdapterRunError(
      "parse-error",
      "bbox must have west < east and south < north",
    );
  }

  const geojson = await arcgisEnvelopeQueryGeoJson({
    serviceUrl: endpoint.serviceUrl,
    bbox,
    upstreamLabel: endpoint.provider,
  });

  return {
    ...endpoint,
    geojson: {
      type: "FeatureCollection",
      features: geojson.features,
    },
    featureCount: geojson.features.length,
    queryMode: "bbox",
    truncated: geojson.truncated,
  };
}
