import { Share2 } from "lucide-react";
import { TabHeader } from "../components/cockpit/TabChrome";

/**
 * Workspace → Shared with me.
 *
 * Empty-state shell for the read-only engagements shared into the
 * current workspace from another team. The list lands when the share
 * backend ships; this page just reserves the IA slot and explains
 * what will appear.
 */
export function SharedWithMe() {
  return (
    <div className="cockpit-tab" data-testid="shared-with-me">
      <TabHeader
        overline="Workspace"
        title="Shared with me"
        subtitle="Read-only engagements other teams have shared into this workspace."
      />

      <div className="shared-empty" data-testid="shared-empty">
        <Share2 size={28} aria-hidden="true" />
        <div className="shared-empty-title">Nothing shared yet</div>
        <p className="shared-empty-body">
          When another team shares one of their engagements with you, it
          will appear here as a read-only entry alongside its source
          workspace. Sharing is coming soon — the IA slot is reserved
          here so the next wave drops in without an IA shift.
        </p>
      </div>
    </div>
  );
}
