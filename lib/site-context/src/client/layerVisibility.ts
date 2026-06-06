import type { BriefingSourceForOverlays, SiteMapOverlay } from "./overlays";

/** Map palette row id for a briefing source (mirrors SiteTab layer groups). */
export function layerRowIdForBriefingSource(
  source: BriefingSourceForOverlays,
): string | null {
  if (source.supersededAt) return null;
  if (
    source.sourceKind === "local-adapter" ||
    source.sourceKind === "state-adapter" ||
    source.sourceKind === "national-aggregator"
  ) {
    return `local-${source.id}`;
  }
  if (source.sourceKind === "manual-upload") {
    return `manual-${source.id}`;
  }
  if (source.layerKind.startsWith("fema")) return "fed-fema";
  if (source.layerKind.startsWith("epa")) return "fed-ej";
  if (source.layerKind.startsWith("fcc")) return "fed-broadband";
  if (source.layerKind.startsWith("usgs")) return "base-topo";
  return `local-${source.id}`;
}

export function isLayerRowVisible(
  rowId: string | null,
  visibility: Record<string, boolean>,
  initialVisibility: Record<string, boolean>,
): boolean {
  if (!rowId) return true;
  return visibility[rowId] ?? initialVisibility[rowId] ?? false;
}

/** Filter map overlays using the Site tab palette visibility map. */
export function filterOverlaysByLayerVisibility(
  overlays: ReadonlyArray<SiteMapOverlay>,
  sources: ReadonlyArray<BriefingSourceForOverlays>,
  visibility: Record<string, boolean>,
  initialVisibility: Record<string, boolean>,
): SiteMapOverlay[] {
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  return overlays.filter((overlay) => {
    if (overlay.sourceId === "site-topography") {
      return isLayerRowVisible(
        "base-dem-contours",
        visibility,
        initialVisibility,
      );
    }
    if (overlay.sourceId === "site-drainage") {
      if (overlay.layerKind === "rainfall-simulation") {
        return isLayerRowVisible(
          "base-rainfall-sim",
          visibility,
          initialVisibility,
        );
      }
      return isLayerRowVisible(
        "base-drainage-zones",
        visibility,
        initialVisibility,
      );
    }
    const source = sourceById.get(overlay.sourceId);
    const rowId = source ? layerRowIdForBriefingSource(source) : null;
    return isLayerRowVisible(rowId, visibility, initialVisibility);
  });
}
