import { Building2 } from "lucide-react";
import type { BuildingOverlayState } from "@workspace/portal-ui";
import { Switch } from "../ui/switch";

const NO_BIM_TOOLTIP =
  "No BIM model yet — push briefing to Revit to enable 3D model overlay.";

export interface SiteContext3DModelToggleProps {
  buildingGlbUrl?: string | null;
  showBuilding?: boolean;
  onToggleShowBuilding?: (next: boolean) => void;
  buildingState?: BuildingOverlayState;
  /** When true, disable until the engagement BIM model query settles. */
  bimModelLoading?: boolean;
}

function resolveDataState(
  showBuilding: boolean,
  buildingState: BuildingOverlayState,
): string {
  if (showBuilding && buildingState === "loading") return "loading";
  if (showBuilding && buildingState === "error") return "error";
  if (buildingState === "loaded" && showBuilding) return "shown";
  if (buildingState === "loaded" && !showBuilding) return "hidden";
  return buildingState;
}

export function SiteContext3DModelToggle({
  buildingGlbUrl,
  showBuilding = false,
  onToggleShowBuilding,
  buildingState = "idle",
  bimModelLoading = false,
}: SiteContext3DModelToggleProps) {
  if (!onToggleShowBuilding) return null;

  const hasGlb = Boolean(buildingGlbUrl);
  const disabled = bimModelLoading || !hasGlb;

  const tooltip = bimModelLoading
    ? "Loading BIM model metadata…"
    : !hasGlb
      ? NO_BIM_TOOLTIP
      : showBuilding
        ? buildingState === "error"
          ? "Building overlay failed to load — toggle off and on to retry."
          : "Hide Revit building massing overlay"
        : "Show Revit building massing overlay on site context";

  const labelSuffix =
    showBuilding && buildingState === "loading"
      ? " · Loading…"
      : showBuilding && buildingState === "error"
        ? " · Load failed"
        : "";

  return (
    <div
      className="site-context-3d-model-toggle"
      data-testid="site-context-3d-model-toggle"
      data-state={resolveDataState(showBuilding, buildingState)}
      data-disabled={disabled ? "true" : "false"}
      title={tooltip}
    >
      <Building2 size={14} aria-hidden className="site-context-3d-model-toggle-icon" />
      <span className="site-context-3d-model-toggle-label">
        3D model{labelSuffix}
      </span>
      <Switch
        checked={showBuilding}
        disabled={disabled}
        onCheckedChange={onToggleShowBuilding}
        aria-label="Show Revit 3D model overlay"
        data-testid="site-context-3d-model-switch"
      />
    </div>
  );
}
