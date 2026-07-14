/**
 * Central TX county-GIS APN point lookup — the shared point→(countyFips,
 * propId) resolution for the provider-neutral parcel key (#243) and the
 * `cad:*` Property Brief adapters.
 *
 * Moved here verbatim from `artifacts/api-server/src/lib/brokerageParcelApn.ts`
 * (which is now a thin re-export) so the `cad:*` adapters in this package
 * and the api-server parcel-key capture path share ONE county routing
 * table instead of growing a third copy. The map-tile provider
 * (`brokerageTxParcels.ts`) keeps its richer per-county table (tile bbox
 * queries + per-county attribute normalizers, api-server-only concerns);
 * unifying that table onto this module is the follow-up already flagged
 * in its own docstring.
 *
 * Deliberately small and self-contained: point query only, no geometry,
 * no cache, no layer normalization. Endpoint URLs, county FIPS codes,
 * routing bboxes, and APN attribute fields live-probed 2026-07-13 (same
 * probes as the tx-parcels county provider lane).
 *
 * Two lookup backends per county (`lookup` discriminator):
 *   - "arcgis"      — live point query against the county's public
 *                     ArcGIS parcel layer (the original five counties).
 *   - "txgio-store" — counties with NO live queryable county GIS
 *                     (Hays 48209, Comal 48091): resolution runs
 *                     against the self-hosted TxGIO/StratMap parcel
 *                     geometry store via an INJECTED
 *                     `ParcelGeometryPointLookup` (this package stays
 *                     db-free — the api-server supplies the drizzle-
 *                     backed implementation, same pattern as
 *                     `ctx.cadLookup`). Without the injection a
 *                     store-backed county resolves to null and callers
 *                     fall through exactly as if the county were
 *                     unsupported.
 *
 * Provenance: every hit carries its backend (`provider: "county-gis"`
 * or `"txgio"`), the layer/store `sourceUrl`, and `retrievedAt`.
 * Parcels are informational, not survey grade on BOTH paths; no CLIP
 * exists here and none is fabricated.
 */

import { arcgisPointQuery } from "./arcgis";
import type { ParcelGeometryPointLookup } from "./types";

export interface CountyApnSource {
  /** Human name, e.g. "Travis". */
  name: string;
  /** Five-digit county FIPS, e.g. "48453". */
  fips: string;
  /**
   * Proper name of the county appraisal district whose GIS layer (and,
   * when ingested, whose `cad_property` roll rows) this county resolves
   * to — e.g. "Travis Central Appraisal District". Used as the cited
   * source label on the `cad:*` Property Brief layers.
   */
  cadName: string;
  /**
   * Which backend resolves a point in this county — "arcgis" (live
   * county service) or "txgio-store" (self-hosted TxGIO geometry via
   * the injected lookup).
   */
  lookup: "arcgis" | "txgio-store";
  /**
   * "arcgis": ArcGIS layer URL (query endpoint is `<serviceUrl>/query`).
   * "txgio-store": the TxGIO per-county resource URL — provenance only.
   */
  serviceUrl: string;
  /** Generous WGS84 routing bbox (west/south/east/north). */
  bbox: { westLng: number; southLat: number; eastLng: number; northLat: number };
  /** Approximate county centroid, for nearest-centroid overlap resolution. */
  centroid: { latitude: number; longitude: number };
  /** "arcgis" only: attribute fields tried in order for the APN / parcel id. */
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
    cadName: "Travis Central Appraisal District",
    lookup: "arcgis",
    serviceUrl:
      "https://gis.traviscountytx.gov/server1/rest/services/Boundaries_and_Jurisdictions/TCAD_public/MapServer/0",
    bbox: { westLng: -98.2, southLat: 30.0, eastLng: -97.35, northLat: 30.65 },
    centroid: { latitude: 30.334, longitude: -97.78 },
    apnFields: ["PROP_ID", "geo_id"],
  },
  {
    name: "Williamson",
    fips: "48491",
    cadName: "Williamson Central Appraisal District",
    lookup: "arcgis",
    serviceUrl:
      "https://gis.wilco.org/arcgis/rest/services/public/county_wcad_parcels/MapServer/0",
    bbox: { westLng: -98.07, southLat: 30.38, eastLng: -97.0, northLat: 30.93 },
    centroid: { latitude: 30.648, longitude: -97.6 },
    apnFields: ["PropertyNumber", "QuickRefID"],
  },
  {
    name: "Bexar",
    fips: "48029",
    cadName: "Bexar Appraisal District",
    lookup: "arcgis",
    serviceUrl:
      "https://maps.bexar.org/arcgis/rest/services/Parcels/MapServer/0",
    bbox: { westLng: -98.85, southLat: 29.15, eastLng: -98.0, northLat: 29.8 },
    centroid: { latitude: 29.449, longitude: -98.52 },
    apnFields: ["PropID"],
  },
  {
    name: "Bastrop",
    fips: "48021",
    cadName: "Bastrop Central Appraisal District",
    lookup: "arcgis",
    serviceUrl:
      "https://maps.co.bastrop.tx.us/server/rest/services/Cadastral_BP/Bastrop_County_Parcels/FeatureServer/0",
    bbox: { westLng: -97.55, southLat: 29.9, eastLng: -96.95, northLat: 30.45 },
    centroid: { latitude: 30.104, longitude: -97.31 },
    apnFields: ["prop_id", "prop_id_text"],
  },
  {
    name: "Hays",
    fips: "48209",
    cadName: "Hays Central Appraisal District",
    lookup: "txgio-store",
    // TxGIO/StratMap Land Parcels per-county resource (public domain) —
    // provenance URL for the self-hosted geometry store; there is no
    // live Hays county GIS to query.
    serviceUrl:
      "https://data.geographic.texas.gov/0fa04328-872e-481c-b453-126a74777593/resources/stratmap25-landparcels_48209_lp.zip",
    // Routing bbox derived from the stratmap25 Hays shapefile header
    // ([-98.2975, 29.7525, -97.7089, 30.3565]), padded.
    bbox: { westLng: -98.31, southLat: 29.74, eastLng: -97.7, northLat: 30.37 },
    centroid: { latitude: 30.058, longitude: -98.031 },
    apnFields: [],
  },
  {
    name: "Comal",
    fips: "48091",
    cadName: "Comal Appraisal District",
    lookup: "txgio-store",
    serviceUrl:
      "https://data.geographic.texas.gov/0fa04328-872e-481c-b453-126a74777593/resources/stratmap25-landparcels_48091_lp.zip",
    // Routing bbox derived from the stratmap25 Comal shapefile header
    // ([-98.6463, 29.5942, -97.9991, 30.0380]), padded.
    bbox: { westLng: -98.66, southLat: 29.58, eastLng: -97.99, northLat: 30.05 },
    centroid: { latitude: 29.808, longitude: -98.278 },
    apnFields: [],
  },
  {
    name: "Caldwell",
    fips: "48055",
    cadName: "Caldwell County Appraisal District",
    lookup: "arcgis",
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
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
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
  /** Which backend resolved the parcel — live county GIS or the self-hosted TxGIO store. */
  provider: "county-gis" | "txgio";
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
 *
 * `parcelPointLookup` is the injected self-hosted-geometry lookup for
 * the "txgio-store" counties (see the module docstring). When a
 * store-backed county routes and no lookup was injected, the point
 * resolves to null — same caller-visible behavior as an unsupported
 * county.
 */
export async function resolveCountyApnByPoint(input: {
  latitude: number;
  longitude: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  parcelPointLookup?: ParcelGeometryPointLookup;
}): Promise<CountyApnResolution | null> {
  const county = resolveCountyApnSource(input.latitude, input.longitude);
  if (!county) return null;

  if (county.lookup === "txgio-store") {
    if (!input.parcelPointLookup) return null;
    const hit = await input.parcelPointLookup(
      county.fips,
      input.latitude,
      input.longitude,
    );
    if (!hit) return null;
    return {
      apn: hit.propId,
      countyFips: county.fips,
      countyName: county.name,
      provider: "txgio",
      sourceUrl: hit.sourceUrl || county.serviceUrl,
      retrievedAt: new Date().toISOString(),
    };
  }

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
