/**
 * ArcGIS FeatureServer → GeoJSON proxy for MapLibre (Max tier map-data BFF).
 * Lifts SmartCity-era Bastrop + FEMA layer URLs; ETJ is env-configured.
 */

import { arcgisPointQueryGeoJson, type ArcGisGeoJsonFeatureCollection } from "@workspace/adapters/arcgis";
import { AdapterRunError } from "@workspace/adapters/types";

const FEMA_NFHL_FLOOD_ZONES =
  "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28";

const BASTROP_ENDPOINTS = {
  parcels:
    "https://gis.bastropcountytx.gov/arcgis/rest/services/Cadastral/Parcels/MapServer/0",
  zoning:
    "https://gis.bastropcountytx.gov/arcgis/rest/services/LandUse/Zoning/MapServer/0",
  floodplain:
    "https://gis.bastropcountytx.gov/arcgis/rest/services/Hazards/Floodplain/MapServer/0",
} as const;

export type GisProxyLayerKey = "fema" | "zoning" | "parcels" | "etj" | "floodplain";

export type GisLayerEndpoint = {
  layer: GisProxyLayerKey;
  serviceUrl: string;
  provider: string;
  adapterKey: string;
};

export function listGisLayerEndpoints(): GisLayerEndpoint[] {
  const etjUrl = process.env.BROKERAGE_GIS_ETJ_SERVICE_URL?.trim();
  const layers: GisLayerEndpoint[] = [
    {
      layer: "fema",
      serviceUrl: FEMA_NFHL_FLOOD_ZONES,
      provider: "FEMA NFHL",
      adapterKey: "fema:nfhl-flood-zone",
    },
    {
      layer: "floodplain",
      serviceUrl: BASTROP_ENDPOINTS.floodplain,
      provider: "Bastrop County, TX GIS",
      adapterKey: "bastrop-tx:floodplain",
    },
    {
      layer: "zoning",
      serviceUrl: BASTROP_ENDPOINTS.zoning,
      provider: "Bastrop County, TX GIS",
      adapterKey: "bastrop-tx:zoning",
    },
    {
      layer: "parcels",
      serviceUrl: BASTROP_ENDPOINTS.parcels,
      provider: "Bastrop County, TX GIS",
      adapterKey: "bastrop-tx:parcels",
    },
  ];
  if (etjUrl) {
    layers.push({
      layer: "etj",
      serviceUrl: etjUrl,
      provider: "Municipal ETJ (configured)",
      adapterKey: "local:etj",
    });
  }
  return layers;
}

export function resolveGisLayerEndpoint(
  layer: GisProxyLayerKey,
): GisLayerEndpoint | null {
  return listGisLayerEndpoints().find((l) => l.layer === layer) ?? null;
}

export type GisLayerGeoJsonResult = GisLayerEndpoint & {
  geojson: ArcGisGeoJsonFeatureCollection;
  featureCount: number;
};

export async function queryGisLayerGeoJson(input: {
  layer: GisProxyLayerKey;
  latitude: number;
  longitude: number;
}): Promise<GisLayerGeoJsonResult> {
  const endpoint = resolveGisLayerEndpoint(input.layer);
  if (!endpoint) {
    throw new AdapterRunError(
      "no-coverage",
      input.layer === "etj"
        ? "ETJ layer not configured — set BROKERAGE_GIS_ETJ_SERVICE_URL"
        : `GIS layer unavailable: ${input.layer}`,
    );
  }

  const geojson = await arcgisPointQueryGeoJson({
    serviceUrl: endpoint.serviceUrl,
    latitude: input.latitude,
    longitude: input.longitude,
    returnGeometry: true,
    upstreamLabel: endpoint.provider,
  });

  return {
    ...endpoint,
    geojson,
    featureCount: geojson.features.length,
  };
}
