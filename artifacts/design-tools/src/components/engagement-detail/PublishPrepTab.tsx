import type { EngagementDetail } from "@workspace/api-client-react";
import { PublisherIntakeWorkbench } from "./PublisherIntakeWorkbench";
import type { TabId } from "./urlState";

/**
 * Publish prep — ABHP Exhibit C publisher intake with auto-fill from
 * engagement, site, briefing, and model metadata.
 */
export function PublishPrepTab({
  engagement,
  snapshotId,
  onNavigate,
}: {
  engagement: EngagementDetail;
  snapshotId: string | null;
  onNavigate?: (tab: TabId) => void;
}) {
  return (
    <PublisherIntakeWorkbench
      engagement={engagement}
      snapshotId={snapshotId}
      onNavigate={onNavigate}
    />
  );
}
