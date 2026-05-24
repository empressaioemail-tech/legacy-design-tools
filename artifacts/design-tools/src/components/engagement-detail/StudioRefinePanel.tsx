import type { ReactNode } from "react";
import { Eraser, Paintbrush, Sparkles, Wand2, ZoomIn } from "lucide-react";
import type { RenderDetailResponse } from "@workspace/api-client-react";
import {
  POWER_TOOLS,
  REFINE_GROUP_LABEL,
  type PowerToolId,
} from "./studioMnmlCatalog";

const TOOL_ICON: Record<PowerToolId, ReactNode> = {
  enhance: <Sparkles size={18} aria-hidden />,
  upscale: <ZoomIn size={18} aria-hidden />,
  erase: <Eraser size={18} aria-hidden />,
  inpaint: <Paintbrush size={18} aria-hidden />,
  style_transfer: <Wand2 size={18} aria-hidden />,
};

export function StudioRefinePanel({
  detail,
  primaryOutputId,
  previewUrl,
  onSelectTool,
}: {
  detail: RenderDetailResponse | undefined;
  primaryOutputId: string | undefined;
  previewUrl: string | null;
  onSelectTool: (tool: PowerToolId) => void;
}) {
  const readyStill =
    detail?.status === "ready" &&
    detail.kind === "still" &&
    primaryOutputId &&
    previewUrl;

  const groups = ["quality", "edit"] as const;

  return (
    <>
      <div className="render-workbench-configure-head">
        <div className="render-workbench-configure-overline">Studio</div>
        <div className="render-workbench-configure-title">Refine output</div>
        <p className="render-workbench-configure-sub">
          Post-process a finished still. Each tool queues a child job (1 credit
          each) linked to the parent output.
        </p>
      </div>
      <div className="render-workbench-configure-scroll sc-scroll">
        {!detail && (
          <p className="sc-prose opacity-70">
            Select a job from History to see available refinements.
          </p>
        )}
        {detail && !readyStill && (
          <div className="studio-refine-blocked sc-prose opacity-80">
            <p>
              <strong>{detail.kind === "still" ? "Still in progress" : "Wrong output type"}</strong>
            </p>
            <p>
              {detail.kind === "elevation-set"
                ? "Elevation sets show all four directions in the canvas. Refine tools apply to a single still output."
                : detail.kind === "video"
                  ? "Video outputs are not supported for mask/edit tools yet."
                  : "Wait until the still is ready, then switch to Refine."}
            </p>
          </div>
        )}
        {readyStill && detail && (
          <div data-testid={`render-power-tools-${detail.id}`}>
            {groups.map((group) => {
              const tools = POWER_TOOLS.filter((t) => t.group === group);
              return (
                <section
                  key={group}
                  className="studio-refine-group"
                  data-testid={`studio-refine-group-${group}`}
                >
                  <h3 className="studio-refine-group-title">
                    {REFINE_GROUP_LABEL[group]}
                  </h3>
                  <div className="studio-refine-tool-list">
                    {tools.map((tool) => (
                      <button
                        key={tool.id}
                        type="button"
                        className="studio-refine-tool-row"
                        data-testid={`render-workbench-tool-${tool.id}`}
                        onClick={() => onSelectTool(tool.id)}
                      >
                        <span className="studio-refine-tool-icon">
                          {TOOL_ICON[tool.id]}
                        </span>
                        <span className="studio-refine-tool-copy">
                          <span className="studio-refine-tool-label">
                            {tool.label}
                          </span>
                          <span className="studio-refine-tool-hint">
                            {tool.short}
                          </span>
                        </span>
                        <span className="studio-refine-tool-cost">
                          {tool.credits} cr
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
