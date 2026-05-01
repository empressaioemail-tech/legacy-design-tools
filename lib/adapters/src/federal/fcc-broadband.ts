/**
 * FCC Form 477 / National Broadband Map — federal broadband-availability
 * adapter.
 *
 * The FCC publishes census-block level fixed-broadband availability via
 * the National Broadband Map's public ArcGIS feature service. We query
 * the layer by point intersection and pull the deployed-technology +
 * max-downstream-Mbps fields per provider record. The adapter rolls
 * those rows up into one summary payload (number of providers, fastest
 * downstream / upstream tier seen) plus the raw rows so the briefing
 * engine can drill in.
 */

import { arcgisPointQuery } from "../arcgis";
import {
  type Adapter,
  type AdapterContext,
  type AdapterResult,
} from "../types";

/**
 * FCC fixed-broadband deployment layer (Form 477 successor — National
 * Broadband Map fabric). The map server URL is documented at
 * https://broadbandmap.fcc.gov/data-download.
 */
const FCC_BROADBAND_LAYER =
  "https://broadbandmap.fcc.gov/nbm/map/api/published/v1/location/area/feature/0";

/**
 * Freshness window for the FCC National Broadband Map snapshot.
 *
 * The Broadband DATA Collection (BDC, post-Form 477) publishes new
 * fabric versions every six months (June + December filing windows),
 * and ISP deployment churn between filings can move a parcel from
 * "no fixed broadband" to gigabit fiber. 6 months keeps the warning
 * aligned with the publishing cadence — anything older than one BDC
 * cycle is the auditable sweet spot for "you should re-run this".
 */
export const FCC_BROADBAND_FRESHNESS_THRESHOLD_MONTHS = 6;

function federalApplies(ctx: AdapterContext): boolean {
  return ctx.jurisdiction.stateKey !== null;
}

function nowIso(): string {
  return new Date().toISOString();
}

interface FccProviderRow {
  provider: string | null;
  technologyCode: number | null;
  maxAdvertisedDownstreamMbps: number | null;
  maxAdvertisedUpstreamMbps: number | null;
  isResidential: boolean | null;
}

function toProviderRow(attrs: Record<string, unknown>): FccProviderRow {
  return {
    provider: typeof attrs.BrandName === "string" ? attrs.BrandName : null,
    technologyCode:
      typeof attrs.TechCode === "number" ? attrs.TechCode : null,
    maxAdvertisedDownstreamMbps:
      typeof attrs.MaxAdDown === "number" ? attrs.MaxAdDown : null,
    maxAdvertisedUpstreamMbps:
      typeof attrs.MaxAdUp === "number" ? attrs.MaxAdUp : null,
    isResidential:
      typeof attrs.LowLatency === "boolean"
        ? attrs.LowLatency
        : typeof attrs.Residential === "number"
          ? attrs.Residential === 1
          : null,
  };
}

export const fccBroadbandAdapter: Adapter = {
  adapterKey: "fcc:broadband",
  tier: "federal",
  sourceKind: "federal-adapter",
  layerKind: "fcc-broadband-availability",
  provider: "FCC National Broadband Map",
  jurisdictionGate: {},
  appliesTo: federalApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const result = await arcgisPointQuery({
      serviceUrl: FCC_BROADBAND_LAYER,
      latitude: ctx.parcel.latitude,
      longitude: ctx.parcel.longitude,
      outFields:
        "BrandName,TechCode,MaxAdDown,MaxAdUp,LowLatency,Residential",
      returnGeometry: false,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
    });
    if (result.features.length === 0) {
      return {
        adapterKey: this.adapterKey,
        tier: this.tier,
        layerKind: this.layerKind,
        sourceKind: this.sourceKind,
        provider: this.provider,
        snapshotDate: nowIso(),
        payload: {
          kind: "broadband-availability",
          providerCount: 0,
          fastestDownstreamMbps: null,
          fastestUpstreamMbps: null,
          providers: [],
        },
        note: "FCC reports no fixed-broadband deployment at this location.",
      };
    }
    const providers = result.features.map((f) =>
      toProviderRow(f.attributes),
    );
    const downs = providers
      .map((p) => p.maxAdvertisedDownstreamMbps)
      .filter((n): n is number => typeof n === "number");
    const ups = providers
      .map((p) => p.maxAdvertisedUpstreamMbps)
      .filter((n): n is number => typeof n === "number");
    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: this.provider,
      snapshotDate: nowIso(),
      payload: {
        kind: "broadband-availability",
        providerCount: providers.length,
        fastestDownstreamMbps: downs.length > 0 ? Math.max(...downs) : null,
        fastestUpstreamMbps: ups.length > 0 ? Math.max(...ups) : null,
        providers,
      },
    };
  },
};
