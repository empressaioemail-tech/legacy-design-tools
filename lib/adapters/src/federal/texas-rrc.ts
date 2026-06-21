/**
 * Texas Railroad Commission public O&G wells and pipelines — federal/state
 * overlay adapter (bbox-oriented map layer; point adapter returns nearest well).
 */

import { arcgisPointQuery } from "../arcgis";
import {
  AdapterRunError,
  type Adapter,
  type AdapterContext,
  type AdapterResult,
} from "../types";

/** Harris County mirror of RRC public GIS (statewide well/pipeline coverage). */
export const TEXAS_RRC_WELLS_LAYER =
  "https://www.gis.hctx.net/arcgishcpid/rest/services/TXRRC/Wells/MapServer/0";

export const TEXAS_RRC_PIPELINES_LAYER =
  "https://www.gis.hctx.net/arcgishcpid/rest/services/TXRRC/Pipelines/MapServer/0";

export const TEXAS_RRC_PROVIDER_LABEL =
  "Texas Railroad Commission (RRC) public GIS";

export const TEXAS_RRC_FRESHNESS_THRESHOLD_MONTHS = 24;

function nowIso(): string {
  return new Date().toISOString();
}

function texasApplies(ctx: AdapterContext): boolean {
  return ctx.jurisdiction.stateKey === "texas";
}

export const texasRrcOgAdapter: Adapter = {
  adapterKey: "texas:rrc-og",
  tier: "state",
  sourceKind: "state-adapter",
  layerKind: "texas-rrc-og",
  provider: TEXAS_RRC_PROVIDER_LABEL,
  jurisdictionGate: { state: "texas" },
  appliesTo: texasApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const { latitude, longitude } = ctx.parcel;
    const wells = await arcgisPointQuery({
      serviceUrl: TEXAS_RRC_WELLS_LAYER,
      latitude,
      longitude,
      outFields: "*",
      returnGeometry: false,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      upstreamLabel: "Texas RRC wells",
    }).catch(() => ({ features: [], raw: null }));

    const pipelines = await arcgisPointQuery({
      serviceUrl: TEXAS_RRC_PIPELINES_LAYER,
      latitude,
      longitude,
      outFields: "*",
      returnGeometry: false,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      upstreamLabel: "Texas RRC pipelines",
    }).catch(() => ({ features: [], raw: null }));

    if (wells.features.length === 0 && pipelines.features.length === 0) {
      throw new AdapterRunError(
        "no-coverage",
        "No Texas RRC wells or pipelines are mapped at this location.",
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
        kind: "texas-rrc-og",
        wellCount: wells.features.length,
        pipelineCount: pipelines.features.length,
        nearestWell: wells.features[0] ?? null,
        nearestPipeline: pipelines.features[0] ?? null,
      },
    };
  },
};
