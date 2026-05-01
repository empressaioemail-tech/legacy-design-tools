/**
 * FEMA National Flood Hazard Layer (NFHL) — federal flood-zone adapter.
 *
 * FEMA publishes the NFHL as a public ArcGIS MapServer at
 * `https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer`.
 * Layer 28 is the "Flood Hazard Zones" polygon layer — intersecting a
 * point against it yields the parcel's effective FEMA flood zone (e.g.
 * `AE`, `X`, `VE`) plus the supporting attributes (`SFHA_TF`,
 * `STATIC_BFE`, `ZONE_SUBTY`).
 *
 * Tier gating: NFHL is national, not pilot-state-specific, so the
 * adapter applies for any engagement we have a resolved pilot state
 * for (the runner gates non-pilot engagements upstream). We do not
 * require a `localKey` — federal coverage is uniform.
 */

import { arcgisPointQuery } from "../arcgis";
import {
  type Adapter,
  type AdapterContext,
  type AdapterResult,
} from "../types";

const FEMA_NFHL_FLOOD_ZONES =
  "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28";

function federalApplies(ctx: AdapterContext): boolean {
  // Federal adapters cover the entire US. We still gate on a resolved
  // pilot state so an out-of-pilot engagement 422s consistently with
  // the rest of DA-PI-4 — once additional pilots come online the
  // resolver picks up the new state keys and federal adapters follow
  // automatically.
  return ctx.jurisdiction.stateKey !== null;
}

function nowIso(): string {
  return new Date().toISOString();
}

export const femaNfhlAdapter: Adapter = {
  adapterKey: "fema:nfhl-flood-zone",
  tier: "federal",
  sourceKind: "federal-adapter",
  layerKind: "fema-nfhl-flood-zone",
  provider: "FEMA National Flood Hazard Layer (NFHL)",
  jurisdictionGate: {},
  appliesTo: federalApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const result = await arcgisPointQuery({
      serviceUrl: FEMA_NFHL_FLOOD_ZONES,
      latitude: ctx.parcel.latitude,
      longitude: ctx.parcel.longitude,
      outFields: "FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE,DFIRM_ID",
      returnGeometry: true,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
    });
    // Empty features list = parcel is outside any mapped flood zone
    // (effectively Zone X by omission). We still emit a row so the
    // briefing engine can attribute "no FEMA flood risk" to a cited
    // source rather than a blank.
    if (result.features.length === 0) {
      return {
        adapterKey: this.adapterKey,
        tier: this.tier,
        layerKind: this.layerKind,
        sourceKind: this.sourceKind,
        provider: this.provider,
        snapshotDate: nowIso(),
        payload: {
          kind: "flood-zone",
          inSpecialFloodHazardArea: false,
          floodZone: null,
          features: [],
        },
        note: "Parcel does not intersect a mapped FEMA flood zone (treat as Zone X).",
      };
    }
    const top = result.features[0];
    const attrs = top.attributes as {
      FLD_ZONE?: unknown;
      ZONE_SUBTY?: unknown;
      SFHA_TF?: unknown;
      STATIC_BFE?: unknown;
    };
    const floodZone =
      typeof attrs.FLD_ZONE === "string" ? attrs.FLD_ZONE : null;
    // FEMA stamps SFHA_TF as the literal string "T" or "F" — we
    // normalize to a boolean so the briefing engine doesn't have to
    // re-parse upstream's wire convention.
    const inSfha = attrs.SFHA_TF === "T" || attrs.SFHA_TF === true;
    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: this.provider,
      snapshotDate: nowIso(),
      payload: {
        kind: "flood-zone",
        inSpecialFloodHazardArea: inSfha,
        floodZone,
        zoneSubtype:
          typeof attrs.ZONE_SUBTY === "string" ? attrs.ZONE_SUBTY : null,
        baseFloodElevation:
          typeof attrs.STATIC_BFE === "number" ? attrs.STATIC_BFE : null,
        features: result.features,
      },
    };
  },
};
