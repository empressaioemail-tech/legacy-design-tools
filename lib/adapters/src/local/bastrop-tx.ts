/**
 * Bastrop, TX local adapters — re-keyed from SmartCity OS for the DA
 * tenant context per locked decision #2 ("re-key the SmartCity OS
 * Bastrop adapters for the DA tenant context — do not import from the
 * SmartCity OS package; copy/adapt so DA owns the source").
 *
 * Bastrop County GIS publishes parcels and zoning through the county's
 * ArcGIS server. Flood data comes from the Bastrop County floodplain
 * map service (separate FeatureServer). Three adapters this sprint:
 *
 *   - `bastrop-tx:parcels`
 *   - `bastrop-tx:zoning`
 *   - `bastrop-tx:floodplain`
 *
 * Roads intentionally NOT included here: Bastrop's road network in the
 * SmartCity OS pilot was sourced via OSM directly (the city's GIS roads
 * layer was not in active use), and the Edwards Aquifer Contributing
 * zone (state tier) plus floodplain (this layer) cover the regulatory
 * inputs the briefing engine needs first.
 */

import { arcgisPointQuery } from "../arcgis";
import {
  AdapterRunError,
  type Adapter,
  type AdapterContext,
  type AdapterResult,
} from "../types";

const BASTROP_ENDPOINTS = {
  parcels:
    "https://gis.bastropcountytx.gov/arcgis/rest/services/Cadastral/Parcels/MapServer/0",
  zoning:
    "https://gis.bastropcountytx.gov/arcgis/rest/services/LandUse/Zoning/MapServer/0",
  floodplain:
    "https://gis.bastropcountytx.gov/arcgis/rest/services/Hazards/Floodplain/MapServer/0",
} as const;

function bastropApplies(ctx: AdapterContext): boolean {
  return ctx.jurisdiction.localKey === "bastrop-tx";
}

function nowIso(): string {
  return new Date().toISOString();
}

export const bastropParcelsAdapter: Adapter = {
  adapterKey: "bastrop-tx:parcels",
  tier: "local",
  sourceKind: "local-adapter",
  layerKind: "bastrop-tx-parcels",
  provider: "Bastrop County, TX GIS",
  jurisdictionGate: { local: "bastrop-tx" },
  appliesTo: bastropApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const result = await arcgisPointQuery({
      serviceUrl: BASTROP_ENDPOINTS.parcels,
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
        "No Bastrop County parcel polygon at this lat/lng.",
      );
    }
    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: this.provider,
      snapshotDate: nowIso(),
      payload: { kind: "parcel", parcel: result.features[0] },
    };
  },
};

export const bastropZoningAdapter: Adapter = {
  adapterKey: "bastrop-tx:zoning",
  tier: "local",
  sourceKind: "local-adapter",
  layerKind: "bastrop-tx-zoning",
  provider: "Bastrop County, TX GIS",
  jurisdictionGate: { local: "bastrop-tx" },
  appliesTo: bastropApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const result = await arcgisPointQuery({
      serviceUrl: BASTROP_ENDPOINTS.zoning,
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
        "Lat/lng did not intersect a Bastrop County zoning polygon.",
      );
    }
    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: this.provider,
      snapshotDate: nowIso(),
      payload: { kind: "zoning", zoning: result.features[0] },
    };
  },
};

export const bastropFloodAdapter: Adapter = {
  adapterKey: "bastrop-tx:floodplain",
  tier: "local",
  sourceKind: "local-adapter",
  layerKind: "bastrop-tx-floodplain",
  provider: "Bastrop County, TX GIS (FEMA-derived floodplain)",
  jurisdictionGate: { local: "bastrop-tx" },
  appliesTo: bastropApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const result = await arcgisPointQuery({
      serviceUrl: BASTROP_ENDPOINTS.floodplain,
      latitude: ctx.parcel.latitude,
      longitude: ctx.parcel.longitude,
      outFields: "*",
      returnGeometry: true,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
    });
    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: this.provider,
      snapshotDate: nowIso(),
      payload: {
        kind: "floodplain",
        // Empty features list = parcel is outside the mapped floodplain;
        // we still emit a row so the briefing engine can attribute "no
        // floodplain risk" to a cited source.
        inMappedFloodplain: result.features.length > 0,
        features: result.features,
      },
    };
  },
};
