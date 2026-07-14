/**
 * Minimal county-GIS APN point lookup for the provider-neutral parcel key.
 *
 * Resolves `(apn, countyFips)` for a WGS84 point from public county
 * appraisal-district ArcGIS services, so `captureParcelKey` can mint an
 * `apn:<countyFips>:<apn>` join key when the Cotality CLIP resolver is
 * unavailable (dead credentials, dark vendor) or fails.
 *
 * Deliberately small and self-contained: point query only, no geometry,
 * no cache, no layer normalization. A concurrent lane
 * (`feat/tx-parcels-county-provider`, `brokerageTxParcels.ts`) builds the
 * full county parcels GIS-layer provider against the same live-verified
 * endpoints; when that merges, this module should be unified onto its
 * county table (`TX_PARCEL_COUNTIES`) and deleted down to a thin
 * `resolveCountyApnByPoint` wrapper. Endpoint URLs, county FIPS codes,
 * routing bboxes, and APN attribute fields below intentionally mirror
 * that module's live-probed values (2026-07-13).
 *
 * Provenance: every hit carries `provider: "county-gis"`, the layer
 * `sourceUrl`, and `retrievedAt`. County GIS parcels are informational,
 * not survey grade; no CLIP exists on this path and none is fabricated.
 */

import { arcgisPointQuery } from "@workspace/adapters/arcgis";

export interface CountyApnSource {
  /** Human name, e.g. "Travis". */
  name: string;
  /** Five-digit county FIPS, e.g. "48453". */
  fips: string;
  /** ArcGIS layer URL (query endpoint is `<serviceUrl>/query`). */
  serviceUrl: string;
  /** Generous WGS84 routing bbox (west/south/east/north). */
  bbox: { westLng: number; southLat: number; eastLng: number; northLat: number };
  /** Approximate county centroid, for nearest-centroid overlap resolution. */
  centroid: { latitude: number; longitude: number };
  /** Attribute fields tried in order for the APN / parcel id. */
  apnFields: readonly string[];
}

/**
 * Supported counties. Endpoints and APN fields live-probed 2026-07-13
 * (same probes as the tx-parcels county provider lane).
 */
export const COUNTY_APN_SOURCES: readonly CountyApnSource[] = [
  {
    name: "Travis",
    fips: "48453",
    serviceUrl:
      "https://gis.traviscountytx.gov/server1/rest/services/Boundaries_and_Jurisdictions/TCAD_public/MapServer/0",
    bbox: { westLng: -98.2, southLat: 30.0, eastLng: -97.35, northLat: 30.65 },
    centroid: { latitude: 30.334, longitude: -97.78 },
    apnFields: ["PROP_ID", "geo_id"],
  },
  {
    name: "Williamson",
    fips: "48491",
    serviceUrl:
      "https://gis.wilco.org/arcgis/rest/services/public/county_wcad_parcels/MapServer/0",
    bbox: { westLng: -98.07, southLat: 30.38, eastLng: -97.0, northLat: 30.93 },
    centroid: { latitude: 30.648, longitude: -97.6 },
    apnFields: ["PropertyNumber", "QuickRefID"],
  },
  {
    name: "Bexar",
    fips: "48029",
    serviceUrl:
      "https://maps.bexar.org/arcgis/rest/services/Parcels/MapServer/0",
    bbox: { westLng: -98.85, southLat: 29.15, eastLng: -98.0, northLat: 29.8 },
    centroid: { latitude: 29.449, longitude: -98.52 },
    apnFields: ["PropID"],
  },
  {
    name: "Bastrop",
    fips: "48021",
    serviceUrl:
      "https://maps.co.bastrop.tx.us/server/rest/services/Cadastral_BP/Bastrop_County_Parcels/FeatureServer/0",
    bbox: { westLng: -97.55, southLat: 29.9, eastLng: -96.95, northLat: 30.45 },
    centroid: { latitude: 30.104, longitude: -97.31 },
    apnFields: ["prop_id", "prop_id_text"],
  },
  {
    name: "Caldwell",
    fips: "48055",
    serviceUrl:
      "https://services.arcgis.com/rVxY74DxxIDrDbc0/arcgis/rest/services/Caldwell_CAD_Parcel_Map/FeatureServer/1",
    bbox: { westLng: -97.95, southLat: 29.5, eastLng: -97.3, northLat: 30.1 },
    centroid: { latitude: 29.837, longitude: -97.62 },
    apnFields: ["Prop_ID", "OLDPROPID"],
  },
];

/**
 * Route a point to a supported county: collect the counties whose routing
 * bbox contains the point and pick the one whose centroid is nearest
 * (generous bboxes overlap at county lines). Null means "not a supported
 * county" — the caller falls through to the geo key.
 */
export function resolveCountyApnSource(
  latitude: number,
  longitude: number,
): CountyApnSource | null {
  let best: CountyApnSource | null = null;
  let bestDist = Infinity;
  for (const county of COUNTY_APN_SOURCES) {
    const inBbox =
      longitude >= county.bbox.westLng &&
      longitude <= county.bbox.eastLng &&
      latitude >= county.bbox.southLat &&
      latitude <= county.bbox.northLat;
    if (!inBbox) continue;
    const dLat = latitude - county.centroid.latitude;
    const dLng = longitude - county.centroid.longitude;
    const dist = dLat * dLat + dLng * dLng;
    if (dist < bestDist) {
      best = county;
      bestDist = dist;
    }
  }
  return best;
}

export interface CountyApnResolution {
  apn: string;
  countyFips: string;
  countyName: string;
  provider: "county-gis";
  sourceUrl: string;
  retrievedAt: string;
}

function readApn(
  attributes: Record<string, unknown>,
  fields: readonly string[],
): string | null {
  for (const field of fields) {
    const v = attributes[field];
    if (typeof v === "string") {
      const t = v.trim();
      if (t && t.toUpperCase() !== "NULL") return t;
    }
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

/**
 * Resolve the APN + county FIPS for a point, or null when the point is
 * outside the supported counties or the county returns no parcel there.
 * Upstream failures (HTTP, ArcGIS error envelope) propagate as
 * `AdapterRunError` — the parcel-key capture path catches and falls
 * through to the geo key, so a dark county service never fails capture.
 */
export async function resolveCountyApnByPoint(input: {
  latitude: number;
  longitude: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<CountyApnResolution | null> {
  const county = resolveCountyApnSource(input.latitude, input.longitude);
  if (!county) return null;

  const result = await arcgisPointQuery({
    serviceUrl: county.serviceUrl,
    latitude: input.latitude,
    longitude: input.longitude,
    outFields: "*",
    returnGeometry: false,
    fetchImpl: input.fetchImpl,
    signal: input.signal,
    upstreamLabel: `${county.name} County GIS parcels`,
  });

  for (const feature of result.features) {
    const apn = readApn(feature.attributes ?? {}, county.apnFields);
    if (apn) {
      return {
        apn,
        countyFips: county.fips,
        countyName: county.name,
        provider: "county-gis",
        sourceUrl: county.serviceUrl,
        retrievedAt: new Date().toISOString(),
      };
    }
  }
  return null;
}
