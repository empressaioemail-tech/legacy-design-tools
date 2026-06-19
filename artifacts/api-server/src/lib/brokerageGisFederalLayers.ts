/**
 * Max map free federal / state GIS proxy layers — bbox GeoJSON for MapLibre.
 *
 * Wired from brokerageGisLayers.ts; does not touch Cotality real-data paths.
 */

import {
  arcgisEnvelopeQueryGeoJson,
  type ArcGisGeoJsonFeatureCollection,
} from "@workspace/adapters/arcgis";
import {
  USDA_SSURGO_MAPUNIT_LAYER,
  foundationRiskScoreFromShrinkSwell,
} from "@workspace/adapters/federal/usda-ssurgo";
import {
  TEXAS_RRC_PIPELINES_LAYER,
  TEXAS_RRC_WELLS_LAYER,
} from "@workspace/adapters/federal/texas-rrc";
import {
  buildNwisGwSiteBboxUrl,
  parseNwisGwSitesFromRdb,
} from "@workspace/adapters/federal/usgs-groundwater";
import {
  EDWARDS_CONTRIBUTING_LAYER_CANDIDATES,
  EDWARDS_RECHARGE_LAYER_CANDIDATES,
  TCEQ_AUSTIN_EDWARDS_RECHARGE_LAYER,
} from "@workspace/adapters/state/texas";
import { AdapterRunError } from "@workspace/adapters/types";
import { loadTxSpecialDistrictRegistry } from "./mudPidRegistry";
import type { GisLayerBbox, GisLayerEndpoint } from "./brokerageGisLayers";

export type FederalGisProxyLayerKey =
  | "ssurgo-soils"
  | "groundwater"
  | "mud-pid"
  | "edwards-aquifer"
  | "texas-rrc";

const FEMA_NWIS_GW_SITES =
  "https://waterservices.usgs.gov/nwis/site/";

const TCEQ_WATER_DISTRICTS_LAYER =
  "https://gisweb.tceq.texas.gov/arcgis/rest/services/Public/WaterDistricts/MapServer/0";

export type FederalGisLayerResult = GisLayerEndpoint & {
  geojson: ArcGisGeoJsonFeatureCollection;
  featureCount: number;
  queryMode: "bbox";
  truncated?: boolean;
};

function endpoint(
  layer: FederalGisProxyLayerKey,
  serviceUrl: string,
  provider: string,
  adapterKey: string,
  meta?: { degraded?: boolean; degradedReason?: string },
): GisLayerEndpoint {
  return { layer, serviceUrl, provider, adapterKey, ...meta };
}

export function listFederalGisLayerEndpoints(): GisLayerEndpoint[] {
  return [
    endpoint(
      "ssurgo-soils",
      USDA_SSURGO_MAPUNIT_LAYER,
      "USDA NRCS gSSURGO",
      "usda:ssurgo-soils",
      {
        degraded: true,
        degradedReason:
          "USDA gSSURGO upstream intermittently unreachable from Cloud Run (TLS ECONNRESET); fixture mode available.",
      },
    ),
    endpoint(
      "groundwater",
      FEMA_NWIS_GW_SITES,
      "USGS NWIS groundwater wells",
      "usgs:groundwater",
    ),
    endpoint(
      "mud-pid",
      TCEQ_WATER_DISTRICTS_LAYER,
      "TCEQ water districts + TX Comptroller SPDPID",
      "tx:mud-pid",
    ),
    endpoint(
      "edwards-aquifer",
      TCEQ_AUSTIN_EDWARDS_RECHARGE_LAYER,
      "TCEQ Edwards Aquifer (Austin COA mirror + contributing fallback)",
      "tceq:edwards-aquifer",
    ),
    endpoint(
      "texas-rrc",
      TEXAS_RRC_WELLS_LAYER,
      "Texas Railroad Commission (RRC) public GIS",
      "texas:rrc-og",
    ),
  ];
}

export function isFederalGisProxyLayer(
  layer: string,
): layer is FederalGisProxyLayerKey {
  return (
    layer === "ssurgo-soils" ||
    layer === "groundwater" ||
    layer === "mud-pid" ||
    layer === "edwards-aquifer" ||
    layer === "texas-rrc"
  );
}

function requireBbox(bbox: GisLayerBbox | undefined): GisLayerBbox {
  if (!bbox) {
    throw new AdapterRunError(
      "parse-error",
      "bbox is required for federal GIS layer viewport queries",
    );
  }
  if (bbox.westLng >= bbox.eastLng || bbox.southLat >= bbox.northLat) {
    throw new AdapterRunError(
      "parse-error",
      "bbox must have west < east and south < north",
    );
  }
  return bbox;
}

function shrinkSwellFromProps(props: Record<string, unknown>): string | null {
  for (const key of [
    "shrinkswell",
    "SHRINKSWELL",
    "eng_shrinkswell",
    "ENG_SHRINKSWELL",
  ]) {
    const v = props[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function hydgrpFromProps(props: Record<string, unknown>): string | null {
  for (const key of ["hydgrpdcd", "HYDGRPDCD", "hydgrp", "HYDGRP"]) {
    const v = props[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

export function scoreSsurgoFeatureRisk(
  props: Record<string, unknown>,
): number {
  const shrink = shrinkSwellFromProps(props);
  if (shrink) return foundationRiskScoreFromShrinkSwell(shrink);
  const hydgrp = hydgrpFromProps(props);
  if (hydgrp) {
    const h = hydgrp.toUpperCase();
    if (h.includes("D") || h.includes("E")) return 4;
    if (h.includes("C")) return 3;
    if (h.includes("B")) return 2;
    if (h.includes("A")) return 1;
  }
  return 3;
}

export function enrichSsurgoGeoJson(
  geojson: ArcGisGeoJsonFeatureCollection,
): ArcGisGeoJsonFeatureCollection {
  return {
    type: "FeatureCollection",
    features: geojson.features.map((raw) => {
      const feature = raw as {
        type?: string;
        geometry?: unknown;
        properties?: Record<string, unknown>;
      };
      const props = { ...(feature.properties ?? {}) };
      const foundationRiskScore = scoreSsurgoFeatureRisk(props);
      return {
        ...feature,
        properties: {
          ...props,
          foundationRiskScore,
          foundationRiskBand:
            foundationRiskScore >= 4
              ? "high"
              : foundationRiskScore >= 3
                ? "moderate"
                : "low",
        },
      };
    }),
  };
}

async function fetchNwisGwSitesGeoJson(
  bbox: GisLayerBbox,
): Promise<ArcGisGeoJsonFeatureCollection> {
  const url = buildNwisGwSiteBboxUrl({
    west: bbox.westLng,
    south: bbox.southLat,
    east: bbox.eastLng,
    north: bbox.northLat,
  });

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url.toString(), {
        headers: {
          "User-Agent": "smartcity-plan-review/1.0 (+https://cortex.empressa.io)",
          Accept: "text/plain, application/json",
        },
      });
      if (!res.ok) {
        throw new AdapterRunError(
          "upstream-error",
          `USGS NWIS site responded with HTTP ${res.status}.`,
        );
      }
      const sites = parseNwisGwSitesFromRdb(await res.text());
      const features: unknown[] = sites.map((site) => ({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [site.longitude, site.latitude],
        },
        properties: {
          siteNo: site.siteNo,
          siteName: site.siteName,
          siteType: "GW",
        },
      }));
      return { type: "FeatureCollection", features };
    } catch (err) {
      lastErr = err;
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      }
    }
  }
  if (lastErr instanceof AdapterRunError) throw lastErr;
  throw new AdapterRunError(
    "network-error",
    `USGS NWIS site did not get a response after 3 attempts. ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

async function arcgisEnvelopeWithFallback(input: {
  candidates: readonly string[];
  bbox: GisLayerBbox;
  upstreamLabel: string;
}): Promise<ArcGisGeoJsonFeatureCollection & { truncated?: boolean }> {
  let lastErr: unknown;
  for (const serviceUrl of input.candidates) {
    try {
      return await arcgisEnvelopeQueryGeoJson({
        serviceUrl,
        bbox: input.bbox,
        outFields: "*",
        upstreamLabel: input.upstreamLabel,
      });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function mudPidTypeFromAttrs(attrs: Record<string, unknown>): string | null {
  const type = String(attrs.TYPE ?? attrs.type ?? "").toUpperCase();
  const name = String(attrs.NAME ?? attrs.name ?? "").toUpperCase();
  if (type.includes("MUD") || name.includes("MUD")) return "MUD";
  if (type.includes("PID") || name.includes("PID")) return "PID";
  if (type.includes("PUD") || name.includes("PUD")) return "PUD";
  if (type.includes("WCID") || name.includes("WCID")) return "MUD";
  return null;
}

export function filterMudPidFeatures(
  geojson: ArcGisGeoJsonFeatureCollection,
): ArcGisGeoJsonFeatureCollection {
  const registry = loadTxSpecialDistrictRegistry();
  const registryNames = new Set(
    registry.map((r) => r.name.toLowerCase()).filter(Boolean),
  );

  const features = geojson.features
    .map((raw) => {
      const feature = raw as { properties?: Record<string, unknown> };
      const props = feature.properties ?? {};
      const districtType = mudPidTypeFromAttrs(props);
      if (!districtType) return null;
      const name = String(props.NAME ?? props.name ?? "").toLowerCase();
      const registryMatch =
        registryNames.size === 0 ||
        registryNames.has(name) ||
        registry.some((r) => r.name && name.includes(r.name.toLowerCase()));
      return {
        ...feature,
        properties: {
          ...props,
          districtType,
          registryMatch,
        },
      };
    })
    .filter(Boolean);

  return {
    type: "FeatureCollection",
    features: features as unknown[],
  };
}

function tagEdwardsZone(
  features: unknown[],
  zone: "recharge" | "contributing",
): unknown[] {
  return features.map((raw) => {
    const feature = raw as { properties?: Record<string, unknown> };
    return {
      ...feature,
      properties: {
        ...(feature.properties ?? {}),
        edwardsZone: zone,
      },
    };
  });
}

export async function queryFederalGisLayerGeoJson(input: {
  layer: FederalGisProxyLayerKey;
  bbox?: GisLayerBbox;
}): Promise<FederalGisLayerResult> {
  const bbox = requireBbox(input.bbox);
  const meta = listFederalGisLayerEndpoints().find((l) => l.layer === input.layer);
  if (!meta) {
    throw new AdapterRunError("no-coverage", `GIS layer unavailable: ${input.layer}`);
  }

  if (input.layer === "ssurgo-soils") {
    const geojson = await arcgisEnvelopeQueryGeoJson({
      serviceUrl: USDA_SSURGO_MAPUNIT_LAYER,
      bbox,
      outFields: "*",
      upstreamLabel: "USDA gSSURGO",
    });
    const enriched = enrichSsurgoGeoJson(geojson);
    return {
      ...meta,
      geojson: enriched,
      featureCount: enriched.features.length,
      queryMode: "bbox",
      truncated: geojson.truncated,
    };
  }

  if (input.layer === "groundwater") {
    const geojson = await fetchNwisGwSitesGeoJson(bbox);
    if (geojson.features.length === 0) {
      throw new AdapterRunError(
        "no-coverage",
        "No USGS groundwater monitoring wells in this viewport.",
      );
    }
    return {
      ...meta,
      geojson,
      featureCount: geojson.features.length,
      queryMode: "bbox",
    };
  }

  if (input.layer === "mud-pid") {
    const geojson = await arcgisEnvelopeQueryGeoJson({
      serviceUrl: TCEQ_WATER_DISTRICTS_LAYER,
      bbox,
      outFields: "NAME,TYPE,DISTRICT_ID,COUNTY,STATUS",
      upstreamLabel: "TCEQ water districts",
    });
    const filtered = filterMudPidFeatures(geojson);
    if (filtered.features.length === 0) {
      throw new AdapterRunError(
        "no-coverage",
        "No MUD/PID/PUD special districts in this viewport.",
      );
    }
    return {
      ...meta,
      geojson: filtered,
      featureCount: filtered.features.length,
      queryMode: "bbox",
      truncated: geojson.truncated,
    };
  }

  if (input.layer === "edwards-aquifer") {
    const [recharge, contributing] = await Promise.all([
      arcgisEnvelopeWithFallback({
        candidates: EDWARDS_RECHARGE_LAYER_CANDIDATES,
        bbox,
        upstreamLabel: "TCEQ Edwards recharge",
      }),
      arcgisEnvelopeWithFallback({
        candidates: EDWARDS_CONTRIBUTING_LAYER_CANDIDATES,
        bbox,
        upstreamLabel: "TCEQ Edwards contributing",
      }).catch(() => ({
        type: "FeatureCollection" as const,
        features: [],
        truncated: false as const,
      })),
    ]);
    const merged = {
      type: "FeatureCollection" as const,
      features: [
        ...tagEdwardsZone(recharge.features, "recharge"),
        ...tagEdwardsZone(contributing.features, "contributing"),
      ],
    };
    if (merged.features.length === 0) {
      throw new AdapterRunError(
        "no-coverage",
        "No Edwards Aquifer recharge or contributing polygons in this viewport.",
      );
    }
    return {
      ...meta,
      geojson: merged,
      featureCount: merged.features.length,
      queryMode: "bbox",
      truncated: Boolean(recharge.truncated || contributing.truncated),
    };
  }

  if (input.layer === "texas-rrc") {
    const [wells, pipelines] = await Promise.all([
      arcgisEnvelopeQueryGeoJson({
        serviceUrl: TEXAS_RRC_WELLS_LAYER,
        bbox,
        outFields: "*",
        upstreamLabel: "Texas RRC wells",
      }).catch(() => ({
        type: "FeatureCollection" as const,
        features: [],
        truncated: false,
      })),
      arcgisEnvelopeQueryGeoJson({
        serviceUrl: TEXAS_RRC_PIPELINES_LAYER,
        bbox,
        outFields: "P5_NUM,OPER_NM,SYS_NM,COM_CARRIE",
        upstreamLabel: "Texas RRC pipelines",
      }).catch(() => ({
        type: "FeatureCollection" as const,
        features: [],
        truncated: false,
      })),
    ]);
    const merged = {
      type: "FeatureCollection" as const,
      features: [
        ...wells.features.map((f) => {
          const feature = f as { properties?: Record<string, unknown> };
          return {
            ...feature,
            properties: { ...(feature.properties ?? {}), rrcAsset: "well" },
          };
        }),
        ...pipelines.features.map((f) => {
          const feature = f as { properties?: Record<string, unknown> };
          return {
            ...feature,
            properties: { ...(feature.properties ?? {}), rrcAsset: "pipeline" },
          };
        }),
      ],
    };
    if (merged.features.length === 0) {
      throw new AdapterRunError(
        "no-coverage",
        "No Texas RRC wells or pipelines in this viewport.",
      );
    }
    return {
      ...meta,
      geojson: merged,
      featureCount: merged.features.length,
      queryMode: "bbox",
      truncated: Boolean(wells.truncated || pipelines.truncated),
    };
  }

  throw new AdapterRunError("no-coverage", `GIS layer unavailable: ${input.layer}`);
}

/** Synthetic GeoJSON for federal layer fixture mode (no upstream). */
export function federalGisLayerFixtureGeoJson(
  layer: FederalGisProxyLayerKey,
  bbox: GisLayerBbox,
): ArcGisGeoJsonFeatureCollection {
  const cx = (bbox.westLng + bbox.eastLng) / 2;
  const cy = (bbox.southLat + bbox.northLat) / 2;
  const dx = (bbox.eastLng - bbox.westLng) * 0.2;
  const dy = (bbox.northLat - bbox.southLat) * 0.2;
  const ring = [
    [cx - dx, cy - dy],
    [cx + dx, cy - dy],
    [cx + dx, cy + dy],
    [cx - dx, cy + dy],
    [cx - dx, cy - dy],
  ];

  if (layer === "groundwater") {
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [cx, cy] },
          properties: { siteNo: "fixture-gw-001", siteName: "Fixture GW well" },
        },
      ],
    };
  }

  if (layer === "texas-rrc") {
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [cx, cy] },
          properties: { rrcAsset: "well", API: "fixture" },
        },
        {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: [
              [cx - dx, cy],
              [cx + dx, cy],
            ],
          },
          properties: { rrcAsset: "pipeline", P5_NUM: "FIX001" },
        },
      ],
    };
  }

  const baseProps: Record<string, unknown> =
    layer === "ssurgo-soils"
      ? { MUSYM: "Pf", shrinkswell: "Moderate", foundationRiskScore: 3 }
      : layer === "mud-pid"
        ? { NAME: "Sample Travis MUD No. 1", TYPE: "MUD", districtType: "MUD" }
        : layer === "edwards-aquifer"
          ? { edwardsZone: "contributing" }
          : {};

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [ring] },
        properties: { fixture: true, layer, ...baseProps },
      },
    ],
  };
}
