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
  USDA_SSURGO_WFS_ENDPOINT,
  fetchSsurgoWfsPolygons,
  foundationRiskScoreFromShrinkSwell,
  querySdaMapunitAttributesByMukeys,
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
import {
  getSpatialTile,
  putSpatialTile,
  tileKey,
  getTileCacheTtlMs,
} from "./brokerageGisCache";
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
      USDA_SSURGO_WFS_ENDPOINT,
      "USDA SDA WFS (SSURGO map units)",
      "usda:ssurgo-soils",
      // Primary source is the SDA WFS on sdmdataaccess (healthy host);
      // the gSSURGO ArcGIS host — which TLS-resets from Cloud Run — is
      // retained only as a fallback, so the layer is no longer statically
      // degraded. Per-request failures still surface as degraded results.
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

// ---------------------------------------------------------------------------
// Per-layer cache freshness (spine freshness-honesty, 55 §7 rule #4)
// ---------------------------------------------------------------------------

/**
 * The default spatial-tile TTL (30d) is correct for near-static layers but
 * would serve stale regulatory data for the volatile ones. Classify each
 * layer:
 *   - ssurgo-soils   : NRCS survey data, ~24-month refresh   -> 30d default
 *   - edwards-aquifer: aquifer zone boundaries, near-static  -> 30d default
 *   - mud-pid        : special-district registry, near-static-> 30d default
 *   - texas-rrc      : O&G wells + pipelines, continuous      -> short TTL
 *   - groundwater    : USGS NWIS well levels, time-varying    -> short TTL
 *
 * "Short" defaults to 24h and is env-overridable via
 * `FEDERAL_GIS_VOLATILE_CACHE_TTL_MS`, matching the env-override pattern the
 * other TTL resolvers use (empty/garbage/negative fall back to the default).
 */
const VOLATILE_FEDERAL_LAYERS: ReadonlySet<FederalGisProxyLayerKey> = new Set([
  "texas-rrc",
  "groundwater",
]);

/** Short TTL for volatile federal layers. 24h; env-overridable. */
export const DEFAULT_FEDERAL_VOLATILE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export function getFederalVolatileCacheTtlMs(
  envValue: string | undefined = process.env.FEDERAL_GIS_VOLATILE_CACHE_TTL_MS,
): number {
  if (envValue === undefined || envValue === "") {
    return DEFAULT_FEDERAL_VOLATILE_CACHE_TTL_MS;
  }
  const parsed = Number(envValue);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_FEDERAL_VOLATILE_CACHE_TTL_MS;
  }
  return Math.floor(parsed);
}

/**
 * Resolve the write TTL for a federal layer. Volatile layers get the short
 * (env-overridable) TTL; static layers get the standard spatial-tile TTL.
 * Both honor a `0` value as "disabled" via the underlying put helper.
 */
export function federalLayerCacheTtlMs(layer: FederalGisProxyLayerKey): number {
  return VOLATILE_FEDERAL_LAYERS.has(layer)
    ? getFederalVolatileCacheTtlMs()
    : getTileCacheTtlMs();
}

/**
 * Read-through cache for the free federal / state GIS proxy layers.
 *
 * These five layers (USDA SSURGO, USGS NWIS groundwater, TCEQ MUD/PID,
 * TCEQ Edwards Aquifer, Texas RRC) hit their upstreams LIVE on every
 * viewport request with zero caching — the same quota/latency problem the
 * Cotality bbox mesh had. This wraps the live fetch in the SAME persistent
 * spatial-tile cache (`cotality_spatial_tile_cache`, migration 0043) the
 * parcels path already uses, with a per-layer key namespace so federal
 * rows never collide with `parcels:` rows: the key is
 * `tileKey(adapterKey, snappedBbox)` where `adapterKey` is the layer's
 * distinct upstream id (e.g. `usda:ssurgo-soils`).
 *
 * Write TTL is per-layer for freshness-honesty (55 §7 rule #4): volatile
 * layers (texas-rrc, groundwater) cache short; near-static layers keep the
 * 30d default. See `federalLayerCacheTtlMs`.
 *
 * Failure isolation is inherited from the cache helpers: a get error
 * returns null (miss -> live fetch), a put error is a no-op, neither ever
 * throws. `forceRefresh` and a `0` TTL both bypass the cache. These layers
 * are all FREE public sources, so no eval-clause / R1 gating applies.
 */
export async function queryFederalGisLayerGeoJson(input: {
  layer: FederalGisProxyLayerKey;
  bbox?: GisLayerBbox;
  forceRefresh?: boolean;
}): Promise<FederalGisLayerResult> {
  const bbox = requireBbox(input.bbox);
  const meta = listFederalGisLayerEndpoints().find((l) => l.layer === input.layer);
  if (!meta) {
    throw new AdapterRunError("no-coverage", `GIS layer unavailable: ${input.layer}`);
  }

  // Distinct key namespace per federal layer, keyed on the adapterKey so a
  // ssurgo tile can never be served for a groundwater request and neither
  // collides with the parcels spatial-tile rows.
  const key = tileKey(meta.adapterKey ?? `federal:${input.layer}`, bbox);

  // Per-layer freshness: volatile layers cache short, static ones 30d. The
  // same ttlMs gates both read and write, so a `0` (disabled) TTL for a
  // layer skips the cache on both sides rather than reading a row the write
  // side would never have populated at that horizon.
  const ttlMs = federalLayerCacheTtlMs(input.layer);

  if (!input.forceRefresh) {
    const hit = await getSpatialTile(key, { ttlMs });
    if (hit?.payload && typeof hit.payload === "object") {
      const cached = hit.payload as {
        geojson?: ArcGisGeoJsonFeatureCollection;
        featureCount?: number;
        truncated?: boolean;
      };
      if (cached.geojson?.type === "FeatureCollection") {
        return {
          ...meta,
          geojson: cached.geojson,
          featureCount:
            hit.featureCount ??
            cached.featureCount ??
            cached.geojson.features.length,
          queryMode: "bbox",
          truncated: cached.truncated,
        };
      }
    }
  }

  const result = await fetchFederalGisLayerGeoJson({
    layer: input.layer,
    bbox,
    meta,
  });

  // Store just the cacheable payload (geojson + counts) at the per-layer
  // TTL. A put failure is a no-op inside the helper, so it never fails the
  // request.
  await putSpatialTile(
    key,
    {
      geojson: result.geojson,
      featureCount: result.featureCount,
      truncated: result.truncated,
    },
    result.featureCount,
    { ttlMs },
  );

  return result;
}

/**
 * Live upstream fetch for a single federal layer. The read-through cache in
 * `queryFederalGisLayerGeoJson` calls this only on a miss (or forceRefresh).
 * bbox is already validated by the caller.
 */
async function fetchFederalGisLayerGeoJson(input: {
  layer: FederalGisProxyLayerKey;
  bbox: GisLayerBbox;
  meta: GisLayerEndpoint;
}): Promise<FederalGisLayerResult> {
  const { bbox, meta } = input;

  if (input.layer === "ssurgo-soils") {
    // Primary: SDA WFS polygons (sdmdataaccess — the host that actually
    // answers from Cloud Run) + one SDA tabular round trip for muname /
    // shrink-swell / HSG so the foundation-risk choropleth has real
    // inputs. Fallback: the legacy gSSURGO ArcGIS envelope query for
    // networks where that host is reachable.
    try {
      const wfs = await fetchSsurgoWfsPolygons({ bbox });
      if (wfs.features.length === 0) {
        throw new AdapterRunError(
          "no-coverage",
          "No SSURGO map-unit polygons in this viewport.",
        );
      }
      const mukeys = wfs.features
        .map((f) => f.properties.mukey)
        .filter((k): k is string => typeof k === "string" && k.length > 0);
      let attrsByMukey: Awaited<
        ReturnType<typeof querySdaMapunitAttributesByMukeys>
      > = new Map();
      try {
        attrsByMukey = await querySdaMapunitAttributesByMukeys({}, mukeys);
      } catch {
        // Attribute enrichment is best-effort; polygons alone still render.
      }
      const withAttrs = {
        type: "FeatureCollection" as const,
        features: wfs.features.map((f) => {
          const mukey = f.properties.mukey;
          const extra =
            typeof mukey === "string" ? attrsByMukey.get(mukey) : undefined;
          return {
            ...f,
            properties: {
              ...f.properties,
              ...(extra
                ? {
                    muname: extra.muname,
                    MUNAME: extra.muname,
                    shrinkswell: extra.shrinkswell,
                    hydgrp: extra.hydgrp,
                    drainagecl: extra.drainagecl,
                  }
                : {}),
            },
          };
        }),
      };
      const enriched = enrichSsurgoGeoJson(withAttrs);
      return {
        ...meta,
        geojson: enriched,
        featureCount: enriched.features.length,
        queryMode: "bbox",
        truncated: wfs.truncated,
      };
    } catch (err) {
      if (err instanceof AdapterRunError && err.code === "no-coverage") {
        throw err;
      }
      // WFS unavailable — try the legacy ArcGIS host before degrading.
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
