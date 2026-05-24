import type { EngagementDetail as EngagementDetailType } from "@workspace/api-client-react";
import { RevitBinding } from "../RevitBinding";
import { TabHeader } from "../cockpit/TabChrome";
import { AccessSection } from "./AccessSection";

/**
 * Engagement settings — read-only config display. Edit details and archive
 * live in the page header to avoid duplicate affordances.
 */
export function SettingsTab({
  engagement,
}: {
  engagement: EngagementDetailType;
  /** @deprecated Use page header Edit details — kept for call-site compat. */
  onEdit?: () => void;
}) {
  const isArchived = engagement.status === "archived";

  return (
    <div className="cockpit-tab" data-testid="settings-tab">
      <TabHeader
        overline="Config · group"
        title="Settings"
        subtitle="Revit binding and access for this engagement. Edit details or archive from the project header above."
      />
      <div className="sc-card p-4">
        <div className="sc-label" style={{ marginBottom: 4 }}>
          DETAILS
        </div>
        <p className="sc-meta opacity-70">
          {engagement.name}
          {engagement.address ? ` · ${engagement.address}` : ""}
          {isArchived ? " · Archived" : ""}
        </p>
        <p className="sc-meta opacity-60" style={{ marginTop: 8 }}>
          Use <strong>Edit details</strong> in the header to update name, address,
          and project metadata.
        </p>
      </div>

      <RevitBinding
        revitCentralGuid={engagement.revitCentralGuid}
        revitDocumentPath={engagement.revitDocumentPath}
      />

      <AccessSection />
    </div>
  );
}
