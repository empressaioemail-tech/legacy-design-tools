/**
 * URL state for Renders tab mode (model vs floor plan visualization).
 *
 * Example: ?view=studio&segment=renders&renderMode=floorplan&floorPlanSource=eng-1-sheet-a101
 */
export type RenderTabMode = "model" | "floorplan";

const RENDER_MODE_PARAM = "renderMode";
const FLOOR_PLAN_SOURCE_PARAM = "floorPlanSource";

export function readRenderModeFromUrl(): RenderTabMode {
  if (typeof window === "undefined") return "model";
  const raw = new URLSearchParams(window.location.search).get(RENDER_MODE_PARAM);
  return raw === "floorplan" ? "floorplan" : "model";
}

export function writeRenderModeToUrl(mode: RenderTabMode): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (mode === "floorplan") {
    url.searchParams.set(RENDER_MODE_PARAM, "floorplan");
  } else {
    url.searchParams.delete(RENDER_MODE_PARAM);
    url.searchParams.delete(FLOOR_PLAN_SOURCE_PARAM);
  }
  window.history.replaceState(null, "", url.toString());
}

export function readFloorPlanSourceFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(FLOOR_PLAN_SOURCE_PARAM);
}

export function writeFloorPlanSourceToUrl(sourceId: string | null): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (sourceId) {
    url.searchParams.set(FLOOR_PLAN_SOURCE_PARAM, sourceId);
  } else {
    url.searchParams.delete(FLOOR_PLAN_SOURCE_PARAM);
  }
  window.history.replaceState(null, "", url.toString());
}

/** Deep-link into floor plan viz with optional preselected source. */
export function writeFloorPlanVizDeepLink(sourceId?: string): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set(RENDER_MODE_PARAM, "floorplan");
  if (sourceId) {
    url.searchParams.set(FLOOR_PLAN_SOURCE_PARAM, sourceId);
  } else {
    url.searchParams.delete(FLOOR_PLAN_SOURCE_PARAM);
  }
  window.history.replaceState(null, "", url.toString());
}

/** Map a sheet row to a stub floor plan source id for deep links. */
export function floorPlanSourceIdForSheet(
  engagementId: string,
  sheetId: string,
): string {
  return `${engagementId}-sheet-${sheetId}`;
}
