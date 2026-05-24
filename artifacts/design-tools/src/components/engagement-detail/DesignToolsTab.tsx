import { TabHeader, TabShell } from "../cockpit/TabChrome";
import { RenderCreditsBadge } from "@workspace/portal-ui";
import { RenderWorkbench } from "./RenderWorkbench";

/**
 * Studio → Rendering — MyArchitectAI-style workbench: history rail,
 * hero canvas with floating controls, and a persistent configure panel.
 */
export function DesignToolsTab({
  engagementId,
  defaultGlbUrl,
  onOpenBimTab,
}: {
  engagementId: string;
  defaultGlbUrl?: string | null;
  onOpenBimTab?: () => void;
}) {
  const hasBim = Boolean(defaultGlbUrl);

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
        subtitle="Render, compare, and post-process stills from your BIM or uploaded sources."
        testId="design-tools-header"
        actions={<RenderCreditsBadge />}
      />

      <RenderWorkbench
        engagementId={engagementId}
        defaultGlbUrl={defaultGlbUrl}
        hasBim={hasBim}
        onOpenBimTab={onOpenBimTab}
      />
    </TabShell>
  );
}
