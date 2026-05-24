import {
  ConstellationCanvas,
  RenderCreditsBadge,
  RenderGallery,
  RenderKickoffPanel,
} from "@workspace/portal-ui";

/**
 * Architect-only "Renders" tab — a two-column render dashboard:
 * kickoff panel (always visible) + gallery (polling, power tools).
 */
export function RendersTab({
  engagementId,
  defaultGlbUrl,
}: {
  engagementId: string;
  /** Auto-resolved BIM-model GLB URL the kickoff panel defaults
   * to. Null when the engagement has no renderable BIM elements
   * yet — the architect can still paste a URL manually. */
  defaultGlbUrl?: string | null;
}) {
  return (
    <div
      data-testid="renders-tab"
      style={{ display: "flex", flexDirection: "column", gap: 12, position: "relative" }}
    >
      <ConstellationCanvas />
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <span
            className="sc-section-title"
            style={{ color: "var(--text-primary)" }}
          >
            Renders
          </span>
          <span className="sc-meta opacity-70">
            mnml.ai-powered architectural renders for this engagement.
            Configure a new render on the left; results stream into the
            gallery on the right.
          </span>
        </div>
        <RenderCreditsBadge />
      </div>
      <div
        data-testid="renders-tab-dashboard"
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(320px, 400px) minmax(0, 1fr)",
          gap: 16,
          alignItems: "start",
        }}
      >
        <RenderKickoffPanel
          engagementId={engagementId}
          defaultGlbUrl={defaultGlbUrl ?? null}
        />
        <RenderGallery
          engagementId={engagementId}
          canCancel
          showPowerTools
          emptyStateHint="No renders yet. Use the panel on the left to kick off your first one."
        />
      </div>
    </div>
  );
}
