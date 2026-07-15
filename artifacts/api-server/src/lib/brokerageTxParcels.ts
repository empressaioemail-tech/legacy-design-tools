/**
 * Central Texas county-GIS parcels provider — LIVE parcel polygons for the
 * `parcels` gis-layer from public county ArcGIS services, routed IN FRONT
 * of the dormant (dead-keyed) Cotality Spatial Tile branch in
 * `brokerageGisLayers.ts`. Cotality code is untouched and remains the
 * fallback for requests outside the supported counties (or when
 * `TX_PARCEL_PROVIDER=off`).
 *
 * Supported counties (endpoints live-probed 2026-07-13; all serve
 * `f=geojson` with `outSR=4326`):
 *
 *   Travis     48453  TCAD_public MapServer/0        (native SR 2277)
 *   Williamson 48491  county_wcad_parcels MapServer/0 (native SR 3857)
 *   Bexar      48029  Parcels MapServer/0             (native SR 2278)
 *   Bastrop    48021  Bastrop_County_Parcels FS/0     (native SR 2277)
 *   Caldwell   48055  Caldwell_CAD_Parcel_Map FS/1    (attribute-thin)
 *
 * Store-backed counties (feat/txgio-parcel-geometry) — no live county
 * GIS exists, so bbox/pin requests are served from the self-hosted
 * `txgio_parcel` store (TxGIO/StratMap Land Parcels, loaded by the
 * txgio-ingest CLI; `source: "txgio-store"`, provider `"txgio"`):
 *
 *   Hays       48209  txgio_parcel (stratmap25, WGS84)
 *   Comal      48091  txgio_parcel (stratmap25, WGS84)
 *
 * TxGIO carries no land-use attributes, so store-backed features are
 * decorated at serve time with `landUseCode` / `landUseDescription`
 * batch-joined from the local `cad_property` roll (one indexed query
 * per response — see `txgioParcelStore.ts`), matching the normalized
 * shape below. Counties whose roll has no use codes (Comal: no CAD
 * rows; Hays: NULL codes until the Orion Land-file ingest lands) emit
 * no land-use props and render neutral — honest, not fabricated.
 *
 * County attributes are normalized to a compact feature-properties shape
 * (apn / situsAddress / owner / landUseCode / landUseDescription where the
 * county provides them) plus provenance (`provider: "county-gis"`,
 * countyFips, sourceUrl, retrievedAt) and `notSurveyGrade: true` — county
 * appraisal-district GIS parcels are informational, not survey grade, per
 * the counties' own disclaimers. There is no CLIP on this path and none is
 * fabricated.
 *
 * Failure honesty: a county upstream failure propagates as an
 * `AdapterRunError` naming the county service — it does NOT silently fall
 * through to the dead-keyed Cotality branch (whose 502 would misattribute
 * the failure).
 *
 * Caching: read-through via the neutral `tx_parcel_tile_cache` table
 * (0051), keyed `(tile_key, county_fips)` with the same snapped-bbox
 * `tileKey()` helper the Cotality tile cache uses. TTL 30 days
 * (`TX_PARCEL_TILE_CACHE_TTL_MS` to override, `0` disables). Bbox queries
 * only — pin queries are uncached, mirroring the Cotality path.
 */

import {
  arcgisEnvelopeQueryGeoJson,
  arcgisPointQueryGeoJson,
  type ArcGisGeoJsonFeatureCollection,
} from "@workspace/adapters/arcgis";
import { AdapterRunError } from "@workspace/adapters/types";
import { tileKey, getTxParcelTile, putTxParcelTile } from "./brokerageGisCache";
import {
  queryTxgioParcelsGeoJson,
  TXGIO_PARCEL_DISCLAIMER,
} from "./txgioParcelStore";
import type { GisLayerBbox } from "./brokerageGisLayers";

/**
 * Feature cap per request — matches the Cotality parcels path
 * (VIEWPORT_PAGE_SIZE 50 x MAX_VIEWPORT_PAGES 4 = 200).
 */
export const TX_PARCEL_FEATURE_CAP = 200;

/**
 * Upstream page size. `arcgisEnvelopeQueryGeoJson` pages up to 4 times, so
 * 50/page caps the merge at TX_PARCEL_FEATURE_CAP and sets `truncated`
 * when a 5th page would have been needed.
 */
const TX_PARCEL_PAGE_SIZE = 50;

export const TX_COUNTY_PARCEL_DISCLAIMER =
  "County appraisal-district GIS parcels are informational and not survey grade. Verify boundaries with a licensed surveyor.";

export type TxParcelProviderMode = "county-gis" | "off";

/**
 * Provider selection. Default "county-gis"; `TX_PARCEL_PROVIDER=off`
 * disables the county path without a code redeploy (requests then flow to
 * the existing Cotality branch exactly as before this provider existed).
 */
export function txParcelProviderMode(
  envValue: string | undefined = process.env.TX_PARCEL_PROVIDER,
): TxParcelProviderMode {
  return (envValue ?? "").trim().toLowerCase() === "off" ? "off" : "county-gis";
}

type GeoJsonFeature = {
  type?: string;
  geometry?: unknown;
  properties?: Record<string, unknown>;
};

export interface TxParcelCounty {
  /** Human name, e.g. "Travis". */
  name: string;
  /** Five-digit county FIPS, e.g. "48453". */
  fips: string;
  /**
   * Where the county's parcels come from — a live county ArcGIS
   * service (default) or the self-hosted `txgio_parcel` store.
   */
  source?: "arcgis" | "txgio-store";
  /**
   * "arcgis": layer URL (query endpoint is `<serviceUrl>/query`).
   * "txgio-store": the TxGIO per-county resource URL — provenance only.
   */
  serviceUrl: string;
  /** Generous WGS84 bounding box for county routing. */
  bbox: GisLayerBbox;
  /** Approximate county centroid, for nearest-centroid overlap resolution. */
  centroid: { latitude: number; longitude: number };
  /** True when the service exposes little beyond geometry + parcel id. */
  attributesDegraded?: boolean;
  /** County-specific attribute normalization ("arcgis" only). */
  normalizeProps: (props: Record<string, unknown>) => Record<string, unknown>;
}

function str(v: unknown): string | null {
  if (typeof v === "string") {
    const t = v.trim();
    if (!t || t.toUpperCase() === "NULL") return null;
    return t;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** Join situs parts (number, prefix, street, suffix) into one line. */
function joinSitus(...parts: unknown[]): string | null {
  const joined = parts
    .map((p) => str(p))
    .filter((p): p is string => Boolean(p))
    .join(" ")
    .trim();
  return joined || null;
}

function withoutNulls(
  props: Record<string, unknown | null>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Supported counties, live-probed 2026-07-13. Order is the spec table
 * order; bbox overlaps at county lines are resolved by nearest centroid
 * (see `resolveTxParcelCounty`).
 */
export const TX_PARCEL_COUNTIES: readonly TxParcelCounty[] = [
  {
    name: "Travis",
    fips: "48453",
    serviceUrl:
      "https://gis.traviscountytx.gov/server1/rest/services/Boundaries_and_Jurisdictions/TCAD_public/MapServer/0",
    bbox: { westLng: -98.2, southLat: 30.0, eastLng: -97.35, northLat: 30.65 },
    centroid: { latitude: 30.334, longitude: -97.78 },
    // Probed fields: PROP_ID, situs_address, situs_num/situs_street(+prefx/
    // suffix), legal_desc, tcad_acres. Owner (py_owner_name is the display
    // field) is NOT returned by outFields=* on this public layer — omitted.
    normalizeProps: (p) =>
      withoutNulls({
        apn: str(p.PROP_ID) ?? str(p.geo_id),
        situsAddress:
          str(p.situs_address) ??
          joinSitus(
            p.situs_num,
            p.situs_street_prefx,
            p.situs_street,
            p.situs_street_suffix,
          ),
      }),
  },
  {
    name: "Williamson",
    fips: "48491",
    serviceUrl:
      "https://gis.wilco.org/arcgis/rest/services/public/county_wcad_parcels/MapServer/0",
    bbox: { westLng: -98.07, southLat: 30.38, eastLng: -97.0, northLat: 30.93 },
    centroid: { latitude: 30.648, longitude: -97.6 },
    // Probed fields: PropertyNumber, QuickRefID, OWNERNME1/FullName,
    // SITEADDRESS, USECD/USEDSCRP, RESYRBLT, LNDVALUE/CNTASSDVAL, Acres.
    normalizeProps: (p) =>
      withoutNulls({
        apn: str(p.PropertyNumber) ?? str(p.QuickRefID),
        situsAddress:
          str(p.SITEADDRESS) ?? str(p.SitusAddress) ?? str(p.PropertyAddress),
        owner: str(p.OWNERNME1) ?? str(p.FullName),
        landUseCode: str(p.USECD),
        landUseDescription: str(p.USEDSCRP),
      }),
  },
  {
    name: "Bexar",
    fips: "48029",
    serviceUrl:
      "https://maps.bexar.org/arcgis/rest/services/Parcels/MapServer/0",
    bbox: { westLng: -98.85, southLat: 29.15, eastLng: -98.0, northLat: 29.8 },
    centroid: { latitude: 29.449, longitude: -98.52 },
    // Probed fields: PropID, Owner, Situs, LandVal/ImprVal/TotVal, YrBlt,
    // PropUse (numeric code, no description field), Exempts. String "NULL"
    // sentinels are dropped by str().
    normalizeProps: (p) =>
      withoutNulls({
        apn: str(p.PropID),
        situsAddress: str(p.Situs),
        owner: str(p.Owner),
        landUseCode: str(p.PropUse),
      }),
  },
  {
    name: "Bastrop",
    fips: "48021",
    serviceUrl:
      "https://maps.co.bastrop.tx.us/server/rest/services/Cadastral_BP/Bastrop_County_Parcels/FeatureServer/0",
    bbox: { westLng: -97.55, southLat: 29.9, eastLng: -96.95, northLat: 30.45 },
    centroid: { latitude: 30.104, longitude: -97.31 },
    // Probed fields: prop_id, file_as_name (owner), situs_num/situs_street
    // (note county's "situs_street_sufix" spelling), land_val/imprv_val/
    // market, legal_acreage. NOTE: the old host gis.bastropcountytx.gov is
    // DEAD; this is the live maps.co.bastrop.tx.us service.
    normalizeProps: (p) =>
      withoutNulls({
        apn: str(p.prop_id) ?? str(p.prop_id_text),
        situsAddress: joinSitus(
          p.situs_num,
          p.situs_street_prefx,
          p.situs_street,
          p.situs_street_sufix,
        ),
        owner: str(p.file_as_name),
      }),
  },
  {
    name: "Hays",
    fips: "48209",
    source: "txgio-store",
    // No live queryable Hays county GIS — served from the self-hosted
    // TxGIO store. serviceUrl is the program resource (provenance).
    serviceUrl:
      "https://data.geographic.texas.gov/0fa04328-872e-481c-b453-126a74777593/resources/stratmap25-landparcels_48209_lp.zip",
    // Routing bbox from the stratmap25 Hays shapefile header
    // ([-98.2975, 29.7525, -97.7089, 30.3565]), padded. Matches the
    // txCountyApn entry.
    bbox: { westLng: -98.31, southLat: 29.74, eastLng: -97.7, northLat: 30.37 },
    centroid: { latitude: 30.058, longitude: -98.031 },
    normalizeProps: (p) => p,
  },
  {
    name: "Comal",
    fips: "48091",
    source: "txgio-store",
    serviceUrl:
      "https://data.geographic.texas.gov/0fa04328-872e-481c-b453-126a74777593/resources/stratmap25-landparcels_48091_lp.zip",
    // Routing bbox from the stratmap25 Comal shapefile header
    // ([-98.6463, 29.5942, -97.9991, 30.0380]), padded. Matches the
    // txCountyApn entry.
    bbox: { westLng: -98.66, southLat: 29.58, eastLng: -97.99, northLat: 30.05 },
    centroid: { latitude: 29.808, longitude: -98.278 },
    normalizeProps: (p) => p,
  },
  {
    name: "Caldwell",
    fips: "48055",
    serviceUrl:
      "https://services.arcgis.com/rVxY74DxxIDrDbc0/arcgis/rest/services/Caldwell_CAD_Parcel_Map/FeatureServer/1",
    bbox: { westLng: -97.95, southLat: 29.5, eastLng: -97.3, northLat: 30.1 },
    centroid: { latitude: 29.837, longitude: -97.62 },
    // Attribute-thin: geometry + Prop_ID only (probed). Marked degraded so
    // consumers know attributes beyond the parcel id are unavailable.
    attributesDegraded: true,
    normalizeProps: (p) =>
      withoutNulls({
        apn: str(p.Prop_ID) ?? str(p.OLDPROPID),
      }),
  },
];

function bboxContains(bbox: GisLayerBbox, lat: number, lng: number): boolean {
  return (
    lng >= bbox.westLng &&
    lng <= bbox.eastLng &&
    lat >= bbox.southLat &&
    lat <= bbox.northLat
  );
}

/**
 * Resolve which supported county a request falls in: take the bbox
 * centroid (or the pin), collect the counties whose routing bbox contains
 * it, and — since generous county bboxes overlap at county lines — pick
 * the containing county whose centroid is nearest. Null means "not a
 * supported Central TX county" and the caller falls through to the
 * existing Cotality branch.
 */
export function resolveTxParcelCounty(input: {
  bbox?: GisLayerBbox;
  latitude?: number;
  longitude?: number;
}): TxParcelCounty | null {
  let lat: number | undefined;
  let lng: number | undefined;
  if (input.bbox) {
    lat = (input.bbox.southLat + input.bbox.northLat) / 2;
    lng = (input.bbox.westLng + input.bbox.eastLng) / 2;
  } else if (
    Number.isFinite(input.latitude) &&
    Number.isFinite(input.longitude)
  ) {
    lat = input.latitude;
    lng = input.longitude;
  }
  if (lat === undefined || lng === undefined) return null;

  let best: TxParcelCounty | null = null;
  let bestDist = Infinity;
  for (const county of TX_PARCEL_COUNTIES) {
    if (!bboxContains(county.bbox, lat, lng)) continue;
    const dLat = lat - county.centroid.latitude;
    const dLng = lng - county.centroid.longitude;
    const dist = dLat * dLat + dLng * dLng;
    if (dist < bestDist) {
      best = county;
      bestDist = dist;
    }
  }
  return best;
}

export function txCountyProviderLabel(county: TxParcelCounty): string {
  return county.source === "txgio-store"
    ? `${county.name} County parcels (TxGIO/StratMap)`
    : `${county.name} County GIS parcels`;
}

export function txCountyAdapterKey(county: TxParcelCounty): string {
  return county.source === "txgio-store"
    ? `txgio:parcels:${county.fips}`
    : `county-gis:parcels:${county.fips}`;
}

/** Provider-appropriate not-survey-grade disclaimer for the layer result. */
export function txCountyDisclaimer(county: TxParcelCounty): string {
  return county.source === "txgio-store"
    ? TXGIO_PARCEL_DISCLAIMER
    : TX_COUNTY_PARCEL_DISCLAIMER;
}

/**
 * Normalize a county GeoJSON feature: keep the (already WGS84) geometry,
 * replace the raw county attributes with the compact normalized shape plus
 * provenance. No `clip` — there is none on this path.
 */
export function normalizeTxCountyFeatures(
  county: TxParcelCounty,
  features: unknown[],
  retrievedAt: string,
): unknown[] {
  const out: unknown[] = [];
  for (const raw of features) {
    const feature = raw as GeoJsonFeature;
    if (!feature || typeof feature !== "object" || !feature.geometry) continue;
    out.push({
      type: "Feature",
      geometry: feature.geometry,
      properties: {
        ...county.normalizeProps(feature.properties ?? {}),
        provider: "county-gis",
        countyFips: county.fips,
        countyName: county.name,
        sourceUrl: county.serviceUrl,
        retrievedAt,
        notSurveyGrade: true,
        ...(county.attributesDegraded ? { attributesDegraded: true } : {}),
      },
    });
  }
  return out;
}

export interface TxCountyParcelsResult {
  geojson: ArcGisGeoJsonFeatureCollection;
  featureCount: number;
  queryMode: "pin" | "bbox";
  truncated?: boolean;
}

/**
 * Query a supported county's ArcGIS parcel layer for the viewport (bbox)
 * or pin, normalize, and cache (bbox only). Throws `AdapterRunError`
 * naming the county service on upstream failure or empty coverage.
 */
export async function queryTxCountyParcelsGeoJson(input: {
  county: TxParcelCounty;
  bbox?: GisLayerBbox;
  latitude?: number;
  longitude?: number;
  forceRefresh?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<TxCountyParcelsResult> {
  const { county } = input;
  const isBbox = Boolean(input.bbox);
  const label = txCountyProviderLabel(county);

  // Store-backed counties (no live county GIS): serve from the local
  // txgio_parcel table. No tile cache — the table IS the store. The
  // store reader throws the same named AdapterRunError shape on empty
  // coverage, keeping failure honesty identical to the live path.
  if (county.source === "txgio-store") {
    return await queryTxgioParcelsGeoJson({
      countyFips: county.fips,
      countyName: county.name,
      bbox: input.bbox,
      latitude: input.latitude,
      longitude: input.longitude,
    });
  }

  if (isBbox && input.bbox && !input.forceRefresh) {
    const key = tileKey("parcels", input.bbox);
    const hit = await getTxParcelTile(key, county.fips);
    if (hit?.payload && typeof hit.payload === "object") {
      const cached = hit.payload as Partial<TxCountyParcelsResult>;
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

  let upstream: ArcGisGeoJsonFeatureCollection & { truncated?: boolean };
  if (isBbox && input.bbox) {
    upstream = await arcgisEnvelopeQueryGeoJson({
      serviceUrl: county.serviceUrl,
      bbox: input.bbox,
      outFields: "*",
      pageSize: TX_PARCEL_PAGE_SIZE,
      upstreamLabel: label,
      fetchImpl: input.fetchImpl,
    });
  } else {
    if (!Number.isFinite(input.latitude) || !Number.isFinite(input.longitude)) {
      throw new AdapterRunError(
        "parse-error",
        "latitude and longitude are required for pin-intersect parcel queries",
      );
    }
    upstream = await arcgisPointQueryGeoJson({
      serviceUrl: county.serviceUrl,
      latitude: input.latitude!,
      longitude: input.longitude!,
      outFields: "*",
      upstreamLabel: label,
      fetchImpl: input.fetchImpl,
    });
  }

  let truncated = Boolean(upstream.truncated);
  let rawFeatures = upstream.features;
  if (rawFeatures.length > TX_PARCEL_FEATURE_CAP) {
    rawFeatures = rawFeatures.slice(0, TX_PARCEL_FEATURE_CAP);
    truncated = true;
  }

  const retrievedAt = new Date().toISOString();
  const features = normalizeTxCountyFeatures(county, rawFeatures, retrievedAt);

  if (features.length === 0) {
    throw new AdapterRunError(
      "no-coverage",
      `${label} returned no parcel polygons for this query.`,
    );
  }

  const result: TxCountyParcelsResult = {
    geojson: { type: "FeatureCollection", features },
    featureCount: features.length,
    queryMode: isBbox ? "bbox" : "pin",
    truncated: truncated || undefined,
  };

  if (isBbox && input.bbox) {
    const key = tileKey("parcels", input.bbox);
    await putTxParcelTile(key, county.fips, result, result.featureCount);
  }

  return result;
}
