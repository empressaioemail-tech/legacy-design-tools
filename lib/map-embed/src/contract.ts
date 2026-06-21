/**
 * R1 — report embedded-map contract (Wave 1 definition, Wave 2 adapter).
 * Coordinated with map-agent V1 renderer + V3 layer registry.
 */

export type AppId =
  | "cortex"
  | "radar"
  | "brief"
  | "smartcity-os"
  | "codex-reviewer";

export type ReportType =
  | "property-brief"
  | "site-context"
  | "hydrology"
  | "codex-plan-review"
  | "cortex-deliverable-site-bound"
  | "radar-baseline"
  | "radar-cotality"
  | "cotality-property-intel"
  | "subsurface"
  | "precedence-jurisdiction"
  | "plan-set-locator";

export interface ParcelSelection {
  placeKey: string;
  parcelId?: string;
}

/** Map-agent V1 — renderer knows nothing about windows or reports */
export interface MapRendererContext {
  center?: { latitude: number; longitude: number };
  address?: string;
  useFixture?: boolean;
  onParcelSelect?: (selection: ParcelSelection) => void;
}

export interface MapRenderer {
  mount(slot: HTMLElement): void;
  resize(width?: number, height?: number): void;
  setLayerVisibility(visible: Set<string>): void;
  bindContext(ctx: MapRendererContext): void;
  getViewState?(): Record<string, unknown>;
  setViewState?(state: Record<string, unknown>): void;
  destroy(): void;
}

export interface ReportEmbedMapHost {
  mountKind: "embedded-static";
  mountSlot: HTMLElement;
  embedId: string;
  appId: AppId;
  reportType: ReportType;
}

export interface ReportEmbedContext extends MapRendererContext {
  appId: AppId;
  reportType: ReportType;
  allocationKey: string;
  placeKey?: string;
  engagementId?: string;
  warmGenerationId?: string;
}

export interface LayerRegistryEntry {
  key: string;
  label: string;
  group: string;
  fixture: boolean;
  live: boolean;
  fuelGated: boolean;
  pending?: boolean;
}

export interface LayerAllocation {
  visibleLayers: string[];
  defaultOn: string[];
  fuelGated: string[];
  reasoningOverlays: {
    contestedGround?: boolean;
    triage?: boolean;
    consequenceChoropleth?: boolean;
  };
  layout: { aspectRatio: "16/9" | "4/3" | "auto"; minHeightPx: number };
}

export interface ResolveLayerAllocationInput {
  appId: AppId;
  reportType: ReportType;
  tier: "free" | "pro" | "max";
  allocationKey?: string;
}

export interface ReportEmbedLifecycle {
  onMount(host: ReportEmbedMapHost, ctx: ReportEmbedContext): MapRenderer;
  onSlotResize(): void;
  onVisibilityChange(visible: boolean): void;
  onUnmount(): void;
}

/** Factory type — map-agent supplies renderer; host supplies lifecycle. */
export type MapRendererFactory = (
  host: ReportEmbedMapHost,
  ctx: ReportEmbedContext,
  allocation: LayerAllocation,
) => MapRenderer;
