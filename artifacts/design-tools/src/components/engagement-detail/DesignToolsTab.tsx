import { TabHeader, TabShell } from "../cockpit/TabChrome";
import {
  FloorPlanVizWorkspace,
  RenderCreditsBadge,
} from "@workspace/portal-ui";
import { RenderWorkbench } from "./RenderWorkbench";
import {
  readFloorPlanSourceFromUrl,
  readRenderModeFromUrl,
  writeRenderModeToUrl,
  type RenderTabMode,
} from "./renderModeUrl";
import { useCallback, useEffect, useState } from "react";

/**
 * Studio → Rendering — model renders (GLB/BIM) or floor plan visualization.
 */
export function DesignToolsTab({
  engagementId,
  defaultGlbUrl,
  onOpenBimTab,
  onOpenClientMaterials,
  renderDeepLinkToken = 0,
}: {
  engagementId: string;
  defaultGlbUrl?: string | null;
  onOpenBimTab?: () => void;
  onOpenClientMaterials?: () => void;
  /** Bumped when an external entry point deep-links into floor plan mode. */
  renderDeepLinkToken?: number;
}) {
  const hasBim = Boolean(defaultGlbUrl);
  const [renderMode, setRenderModeState] = useState<RenderTabMode>(() =>
    readRenderModeFromUrl(),
  );
  const [floorPlanSourceId, setFloorPlanSourceId] = useState<string | null>(() =>
    readFloorPlanSourceFromUrl(),
  );

  useEffect(() => {
    setRenderModeState(readRenderModeFromUrl());
    setFloorPlanSourceId(readFloorPlanSourceFromUrl());
  }, [renderDeepLinkToken]);

  const setRenderMode = useCallback((mode: RenderTabMode) => {
    setRenderModeState(mode);
    writeRenderModeToUrl(mode);
  }, []);

  const subtitle =
    renderMode === "floorplan"
      ? "Turn a 2D floor plan into a furnished top-down 3D visualization for client presentations."
      : "Render, compare, and post-process stills from your BIM or uploaded sources.";

  return (
    <TabShell
      testId="design-tools-tab"
      legacyTestId="renders-tab"
      className="render-workbench flex-1 min-h-0"
      style={{ position: "relative", minHeight: 0 }}
    >
      <TabHeader
        overline="Studio"
        title="Rendering"
        subtitle={subtitle}
        testId="design-tools-header"
        actions={
          <>
            <nav
              className="render-tab-mode-switch"
              role="tablist"
              aria-label="Render mode"
              data-testid="render-tab-mode-switch"
            >
              <button
                type="button"
                role="tab"
                aria-selected={renderMode === "model"}
                data-active={renderMode === "model" ? "true" : "false"}
                className="render-tab-mode-btn"
                data-testid="render-mode-model"
                onClick={() => setRenderMode("model")}
              >
                Model renders
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={renderMode === "floorplan"}
                data-active={renderMode === "floorplan" ? "true" : "false"}
                className="render-tab-mode-btn"
                data-testid="render-mode-floorplan"
                onClick={() => setRenderMode("floorplan")}
              >
                Floor plan viz
              </button>
            </nav>
            {onOpenClientMaterials ? (
              <button
                type="button"
                className="sc-btn-ghost sc-btn-sm"
                data-testid="renders-send-to-canva"
                onClick={onOpenClientMaterials}
              >
                Use in client materials
              </button>
            ) : null}
            <RenderCreditsBadge />
          </>
        }
      />

      {renderMode === "floorplan" ? (
        <FloorPlanVizWorkspace
          engagementId={engagementId}
          preselectedSourceId={floorPlanSourceId}
          onSendToCanva={
            onOpenClientMaterials
              ? () => onOpenClientMaterials()
              : undefined
          }
        />
      ) : (
        <RenderWorkbench
          engagementId={engagementId}
          defaultGlbUrl={defaultGlbUrl}
          hasBim={hasBim}
          onOpenBimTab={onOpenBimTab}
        />
      )}
    </TabShell>
  );
}
