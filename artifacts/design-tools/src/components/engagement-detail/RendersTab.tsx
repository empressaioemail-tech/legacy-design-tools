import { useState } from "react";
import { RenderGallery, RenderKickoffDialog } from "@workspace/portal-ui";

/**
 * Architect-only "Renders" tab. Wraps the shared `RenderGallery`
 * from portal-ui and mounts `RenderKickoffDialog` behind a "New
 * render" button. The gallery owns polling, cancel confirmation,
 * and downloads; this tab just owns the dialog's open state.
 */
export function RendersTab({
  engagementId,
  defaultGlbUrl,
}: {
  engagementId: string;
  /** Auto-resolved BIM-model GLB URL the kickoff dialog defaults
   * to. Null when the engagement has no renderable BIM elements
   * yet — the architect can still paste a URL manually. */
  defaultGlbUrl?: string | null;
}) {
  const [kickoffOpen, setKickoffOpen] = useState(false);
  return (
    <div
      data-testid="renders-tab"
      style={{ display: "flex", flexDirection: "column", gap: 12 }}
    >
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <span
            className="sc-section-title"
            style={{ color: "var(--text-primary)" }}
          >
            Renders
          </span>
          <span className="sc-meta opacity-70">
            mnml.ai-powered architectural renders for this
            engagement. Stills, 4-direction elevation sets, and
            short videos all run on the same polling worker.
          </span>
        </div>
        <button
          type="button"
          className="sc-btn-primary"
          onClick={() => setKickoffOpen(true)}
          data-testid="renders-tab-new-render"
        >
          New render
        </button>
      </div>
      <RenderGallery
        engagementId={engagementId}
        canCancel
        emptyStateHint="No renders yet. Click 'New render' to kick off your first one."
      />
      <RenderKickoffDialog
        engagementId={engagementId}
        defaultGlbUrl={defaultGlbUrl ?? null}
        isOpen={kickoffOpen}
        onClose={() => setKickoffOpen(false)}
      />
    </div>
  );
}
