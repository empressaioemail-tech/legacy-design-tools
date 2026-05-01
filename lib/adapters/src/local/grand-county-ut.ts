/**
 * Grand County, UT (Moab) local adapters.
 *
 * Grand County publishes parcels and zoning through its own ArcGIS
 * server at `https://gis.grandcountyutah.net/arcgis/rest/services/...`.
 * Roads are not consistently published on the county server, so the
 * roads adapter falls back to OpenStreetMap's Overpass API when the
 * primary endpoint returns nothing or fails — per locked decision #2
 * ("fall back to OSM if county GIS isn't usable").
 *
 * Three adapters:
 *   - `grand-county-ut:parcels`
 *   - `grand-county-ut:zoning`
 *   - `grand-county-ut:roads` (with OSM fallback)
 */

import { arcgisPointQuery } from "../arcgis";
import {
  AdapterRunError,
  type Adapter,
  type AdapterContext,
  type AdapterResult,
} from "../types";

const GRAND_COUNTY_ENDPOINTS = {
  parcels:
    "https://gis.grandcountyutah.net/arcgis/rest/services/Cadastral/Parcels/MapServer/0",
  zoning:
    "https://gis.grandcountyutah.net/arcgis/rest/services/LandUse/Zoning/MapServer/0",
  roads:
    "https://gis.grandcountyutah.net/arcgis/rest/services/Transportation/Roads/MapServer/0",
} as const;

const OSM_OVERPASS_URL = "https://overpass-api.de/api/interpreter";

function grandCountyApplies(ctx: AdapterContext): boolean {
  return ctx.jurisdiction.localKey === "grand-county-ut";
}

function nowIso(): string {
  return new Date().toISOString();
}

export const grandCountyParcelsAdapter: Adapter = {
  adapterKey: "grand-county-ut:parcels",
  tier: "local",
  sourceKind: "local-adapter",
  layerKind: "grand-county-ut-parcels",
  provider: "Grand County, UT GIS",
  jurisdictionGate: { local: "grand-county-ut" },
  appliesTo: grandCountyApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const result = await arcgisPointQuery({
      serviceUrl: GRAND_COUNTY_ENDPOINTS.parcels,
      latitude: ctx.parcel.latitude,
      longitude: ctx.parcel.longitude,
      outFields: "*",
      returnGeometry: true,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
    });
    if (result.features.length === 0) {
      throw new AdapterRunError(
        "no-coverage",
        "No Grand County parcel polygon at this lat/lng.",
      );
    }
    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: this.provider,
      snapshotDate: nowIso(),
      payload: {
        kind: "parcel",
        parcel: result.features[0],
      },
    };
  },
};

export const grandCountyZoningAdapter: Adapter = {
  adapterKey: "grand-county-ut:zoning",
  tier: "local",
  sourceKind: "local-adapter",
  layerKind: "grand-county-ut-zoning",
  provider: "Grand County, UT GIS",
  jurisdictionGate: { local: "grand-county-ut" },
  appliesTo: grandCountyApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const result = await arcgisPointQuery({
      serviceUrl: GRAND_COUNTY_ENDPOINTS.zoning,
      latitude: ctx.parcel.latitude,
      longitude: ctx.parcel.longitude,
      outFields: "*",
      returnGeometry: true,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
    });
    if (result.features.length === 0) {
      throw new AdapterRunError(
        "no-coverage",
        "Lat/lng did not intersect a Grand County zoning polygon.",
      );
    }
    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: this.provider,
      snapshotDate: nowIso(),
      payload: {
        kind: "zoning",
        zoning: result.features[0],
      },
    };
  },
};

export const grandCountyRoadsAdapter: Adapter = {
  adapterKey: "grand-county-ut:roads",
  tier: "local",
  sourceKind: "local-adapter",
  layerKind: "grand-county-ut-roads",
  provider: "Grand County, UT GIS / OpenStreetMap (fallback)",
  jurisdictionGate: { local: "grand-county-ut" },
  appliesTo: grandCountyApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    // Try the county GIS first.
    try {
      const result = await arcgisPointQuery({
        serviceUrl: GRAND_COUNTY_ENDPOINTS.roads,
        latitude: ctx.parcel.latitude,
        longitude: ctx.parcel.longitude,
        outFields: "*",
        returnGeometry: false,
        fetchImpl: ctx.fetchImpl,
        signal: ctx.signal,
      });
      if (result.features.length > 0) {
        return {
          adapterKey: this.adapterKey,
          tier: this.tier,
          layerKind: this.layerKind,
          sourceKind: this.sourceKind,
          provider: "Grand County, UT GIS",
          snapshotDate: nowIso(),
          payload: { kind: "roads", source: "county-gis", features: result.features },
        };
      }
      // County returned ok but zero features — fall through to OSM.
    } catch (err) {
      // County GIS unavailable — record reason and fall through to OSM.
      // Anything not an AdapterRunError indicates a programming error
      // we shouldn't swallow.
      if (!(err instanceof AdapterRunError)) throw err;
    }
    return await runOsmRoadsFallback(ctx, this);
  },
};

async function runOsmRoadsFallback(
  ctx: AdapterContext,
  adapter: Adapter,
): Promise<AdapterResult> {
  const fetchFn = ctx.fetchImpl ?? fetch;
  // Overpass: highways within 100m of the point.
  const radius = 100;
  const query = `[out:json][timeout:10];way(around:${radius},${ctx.parcel.latitude},${ctx.parcel.longitude})[highway];out body geom 50;`;
  let res: Response;
  try {
    res = await fetchFn(OSM_OVERPASS_URL, {
      method: "POST",
      body: query,
      headers: { "Content-Type": "text/plain" },
      signal: ctx.signal,
    });
  } catch (err) {
    throw new AdapterRunError(
      "network-error",
      `OSM Overpass request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new AdapterRunError(
      "upstream-error",
      `OSM Overpass returned HTTP ${res.status}`,
    );
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    throw new AdapterRunError(
      "parse-error",
      `OSM Overpass response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const elements = (json as { elements?: unknown }).elements;
  if (!Array.isArray(elements)) {
    throw new AdapterRunError(
      "parse-error",
      "OSM Overpass response missing `elements` array",
    );
  }
  return {
    adapterKey: adapter.adapterKey,
    tier: adapter.tier,
    layerKind: adapter.layerKind,
    sourceKind: adapter.sourceKind,
    provider: "OpenStreetMap (Overpass fallback)",
    snapshotDate: nowIso(),
    payload: { kind: "roads", source: "osm", radiusMeters: radius, elements },
    note: "County GIS roads layer unavailable; fell back to OpenStreetMap Overpass.",
  };
}
