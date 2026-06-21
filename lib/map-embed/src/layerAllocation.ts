/**
 * V3 layer allocation resolver — seed config from endstate D binding table.
 * Map-agent owns the live registry; this module is the typed allocation API
 * consumed by Cortex report hosts (R1/R6).
 */

import type {
  AppId,
  LayerAllocation,
  ReportType,
  ResolveLayerAllocationInput,
} from "./contract.js";

type AllocationSeed = Omit<LayerAllocation, "layout"> & {
  layout?: LayerAllocation["layout"];
};

const DEFAULT_LAYOUT: LayerAllocation["layout"] = {
  aspectRatio: "16/9",
  minHeightPx: 320,
};

const REASONING_OVERLAYS_WAVE2 = {
  contestedGround: true,
  triage: true,
  consequenceChoropleth: true,
};

/** Per (appId, reportType) default layer keys — endstate D §5 */
const ALLOCATION_TABLE: Record<string, AllocationSeed> = {
  "cortex:property-brief": {
    visibleLayers: [
      "parcel-polygon",
      "zoning",
      "flood-zone",
      "consequence-choropleth",
      "triage-state",
      "contested-ground",
    ],
    defaultOn: ["parcel-polygon", "flood-zone", "zoning"],
    fuelGated: ["zoning", "consequence-choropleth", "triage-state", "contested-ground"],
    reasoningOverlays: REASONING_OVERLAYS_WAVE2,
  },
  "cortex:site-context": {
    visibleLayers: [
      "flood-zone",
      "topography-contours",
      "parcel-polygon",
    ],
    defaultOn: ["flood-zone", "parcel-polygon", "topography-contours"],
    fuelGated: [],
    reasoningOverlays: {},
  },
  "cortex:hydrology": {
    visibleLayers: [
      "hydrology-flow",
      "flood-zone",
      "topography-contours",
      "contested-ground",
    ],
    defaultOn: ["hydrology-flow", "flood-zone", "topography-contours"],
    fuelGated: ["contested-ground"],
    reasoningOverlays: { contestedGround: true },
    layout: { aspectRatio: "4/3", minHeightPx: 360 },
  },
  "cortex:codex-plan-review": {
    visibleLayers: ["parcel-polygon", "zoning", "buildable-envelope"],
    defaultOn: ["parcel-polygon", "zoning"],
    fuelGated: ["zoning"],
    reasoningOverlays: {},
  },
  "cortex:cortex-deliverable-site-bound": {
    visibleLayers: ["parcel-polygon", "flood-zone", "topography-contours"],
    defaultOn: ["parcel-polygon", "flood-zone"],
    fuelGated: [],
    reasoningOverlays: {},
  },
  "radar:property-brief": {
    visibleLayers: ["parcel-polygon", "flood-zone", "motivated-seller"],
    defaultOn: ["parcel-polygon", "flood-zone"],
    fuelGated: ["motivated-seller"],
    reasoningOverlays: {},
  },
  "radar:radar-baseline": {
    visibleLayers: ["motivated-seller", "opportunity-zone-tract"],
    defaultOn: ["motivated-seller"],
    fuelGated: [],
    reasoningOverlays: {},
  },
  "brief:property-brief": {
    visibleLayers: ["parcel-polygon", "flood-zone", "zoning"],
    defaultOn: ["parcel-polygon", "flood-zone"],
    fuelGated: ["zoning"],
    reasoningOverlays: {},
  },
  "brief:site-context": {
    visibleLayers: ["flood-zone", "parcel-polygon", "topography-contours"],
    defaultOn: ["flood-zone", "parcel-polygon"],
    fuelGated: [],
    reasoningOverlays: {},
  },
  "smartcity-os:property-brief": {
    visibleLayers: ["parcel-polygon", "flood-zone"],
    defaultOn: ["parcel-polygon", "flood-zone"],
    fuelGated: [],
    reasoningOverlays: {},
  },
};

function allocationKeyFor(input: ResolveLayerAllocationInput): string {
  return input.allocationKey ?? `${input.appId}:${input.reportType}`;
}

function filterFuelGatedForTier(
  seed: AllocationSeed,
  tier: ResolveLayerAllocationInput["tier"],
): LayerAllocation {
  const fuelGated =
    tier === "max" ? [] : seed.fuelGated.filter((k) => !seed.defaultOn.includes(k));
  return {
    visibleLayers: [...seed.visibleLayers],
    defaultOn: [...seed.defaultOn],
    fuelGated,
    reasoningOverlays: { ...seed.reasoningOverlays },
    layout: seed.layout ?? DEFAULT_LAYOUT,
  };
}

export function resolveLayerAllocation(
  input: ResolveLayerAllocationInput,
): LayerAllocation {
  const key = allocationKeyFor(input);
  const seed = ALLOCATION_TABLE[key];
  if (!seed) {
    return {
      visibleLayers: ["parcel-polygon"],
      defaultOn: ["parcel-polygon"],
      fuelGated: [],
      reasoningOverlays: {},
      layout: DEFAULT_LAYOUT,
    };
  }
  return filterFuelGatedForTier(seed, input.tier);
}

export function defaultAllocationKey(appId: AppId, reportType: ReportType): string {
  return `${appId}:${reportType}`;
}
