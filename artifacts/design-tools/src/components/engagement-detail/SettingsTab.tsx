import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useUpdateEngagement,
  getGetEngagementQueryKey,
  getListEngagementsQueryKey,
  type EngagementDetail as EngagementDetailType,
} from "@workspace/api-client-react";
import { RevitBinding } from "../RevitBinding";

export function SettingsTab({
  engagement,
  onEdit,
}: {
  engagement: EngagementDetailType;
  onEdit: () => void;
}) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const archive = useUpdateEngagement({
    mutation: {
      onSuccess: async () => {
        await qc.invalidateQueries({
          queryKey: getGetEngagementQueryKey(engagement.id),
        });
        await qc.invalidateQueries({
          queryKey: getListEngagementsQueryKey(),
        });
        setConfirming(false);
      },
    },
  });
  const isArchived = engagement.status === "archived";

  return (
    <div className="flex flex-col gap-6">
      <div className="sc-card p-4 flex items-center justify-between">
        <div>
          <div className="sc-label" style={{ marginBottom: 4 }}>
            DETAILS
          </div>
          <div className="sc-meta opacity-70">
            Update name, address, project type, zoning, lot area, and status.
          </div>
        </div>
        <button className="sc-btn-primary" onClick={onEdit}>
          Edit details
        </button>
      </div>

      <RevitBinding
        revitCentralGuid={engagement.revitCentralGuid}
        revitDocumentPath={engagement.revitDocumentPath}
      />

      <div
        style={{
          borderTop: "1px solid var(--border-default)",
          paddingTop: 16,
          color: "var(--text-secondary)",
        }}
      >
        <div className="sc-label" style={{ marginBottom: 8 }}>
          DANGER ZONE
        </div>
        {!confirming ? (
          <button
            className="sc-btn-ghost"
            disabled={isArchived || archive.isPending}
            onClick={() => setConfirming(true)}
            style={{
              color: isArchived ? "var(--text-muted)" : "#ef4444",
              borderColor: isArchived
                ? "var(--border-default)"
                : "rgba(239,68,68,0.4)",
            }}
          >
            {isArchived ? "Already archived" : "Archive engagement"}
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <span className="sc-meta">
              Archive {engagement.name}? You can change it back later.
            </span>
            <button
              className="sc-btn-ghost"
              onClick={() => setConfirming(false)}
              disabled={archive.isPending}
            >
              Cancel
            </button>
            <button
              className="sc-btn-primary"
              disabled={archive.isPending}
              onClick={() =>
                archive.mutate({
                  id: engagement.id,
                  data: { status: "archived" },
                })
              }
              style={{ background: "var(--danger)" }}
            >
              {archive.isPending ? "Archiving…" : "Confirm archive"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
