import { TabHeader, TabShell } from "../cockpit/TabChrome";
import {
  createApiFloorPlanVizService,
  FloorPlanVizWorkspace,
  RenderCreditsBadge,
  type BimStudioCapture,
} from "@workspace/portal-ui";
import { useMemo } from "react";
import { isFloorPlanSheet } from "../../lib/isFloorPlanSheet";
import { RenderWorkbench } from "./RenderWorkbench";
import {
  readFloorPlanSourceFromUrl,
  readRenderModeFromUrl,
  writeRenderModeToUrl,
  type RenderTabMode,
} from "./renderModeUrl";
import { useCallback, useEffect, useState } from "react";

/**
 * Studio → Rendering — model renders, floor plan visualization, or video.
 */
export function DesignToolsTab({
  engagementId,
  snapshotId,
  defaultGlbUrl,
  onOpenBimTab,
  onOpenClientMaterials,
  renderDeepLinkToken = 0,
  initialStudioCapture = null,
  onStudioCaptureConsumed,
}: {
  engagementId: string;
  snapshotId?: string | null;
  defaultGlbUrl?: string | null;
  onOpenBimTab?: () => void;
  onOpenClientMaterials?: () => void;
  /** Bumped when an external entry point deep-links into floor plan mode. */
  renderDeepLinkToken?: number;
  /** One-shot camera + GLB from Snapshots BIM viewer → Studio still kickoff. */
  initialStudioCapture?: BimStudioCapture | null;
  onStudioCaptureConsumed?: () => void;
}) {
  const hasBim = Boolean(defaultGlbUrl);
  const [renderMode, setRenderModeState] = useState<RenderTabMode>(() =>
    readRenderModeFromUrl(),
  );
  const [floorPlanSourceId, setFloorPlanSourceId] = useState<string | null>(() =>
    readFloorPlanSourceFromUrl(),
  );

  const floorPlanService = useMemo(
    () =>
      createApiFloorPlanVizService({
        engagementId,
        snapshotId: snapshotId ?? null,
        filterSheets: isFloorPlanSheet,
      }),
    [engagementId, snapshotId],
  );

  useEffect(() => {
    setRenderModeState(readRenderModeFromUrl());
    setFloorPlanSourceId(readFloorPlanSourceFromUrl());
  }, [renderDeepLinkToken]);

  useEffect(() => {
    if (!initialStudioCapture) return;
    setRenderModeState("model");
    writeRenderModeToUrl("model");
  }, [initialStudioCapture]);

  const setRenderMode = useCallback((mode: RenderTabMode) => {
    setRenderModeState(mode);
    writeRenderModeToUrl(mode);
  }, []);

  const subtitle =
    renderMode === "floorplan"
      ? "Turn a 2D floor plan into a furnished top-down 3D visualization for client presentations."
      : renderMode === "video"
        ? "Queue Kling flythrough clips from a BIM capture or uploaded source."
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
              <button
                type="button"
                role="tab"
                aria-selected={renderMode === "video"}
                data-active={renderMode === "video" ? "true" : "false"}
                className="render-tab-mode-btn"
                data-testid="render-mode-video"
                onClick={() => setRenderMode("video")}
              >
                Video rendering
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
          service={floorPlanService}
          preselectedSourceId={floorPlanSourceId}
          onSendToCanva={
            onOpenClientMaterials
              ? () => onOpenClientMaterials()
              : undefined
          }
        />
      ) : renderMode === "video" ? (
        <RenderWorkbench
          engagementId={engagementId}
          defaultGlbUrl={defaultGlbUrl}
          hasBim={hasBim}
          onOpenBimTab={onOpenBimTab}
          kindFilter="video"
          initialStudioCapture={initialStudioCapture}
          onStudioCaptureConsumed={onStudioCaptureConsumed}
        />
      ) : (
        <RenderWorkbench
          engagementId={engagementId}
          defaultGlbUrl={defaultGlbUrl}
          hasBim={hasBim}
          onOpenBimTab={onOpenBimTab}
          kindFilter="exclude-video"
          initialStudioCapture={initialStudioCapture}
          onStudioCaptureConsumed={onStudioCaptureConsumed}
        />
      )}
    </TabShell>
  );
}
