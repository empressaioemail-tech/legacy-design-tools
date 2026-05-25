import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import {
  RETENTION_POLICY_OPTIONS,
  type RetentionPolicyId,
  type WorkspaceStorageDisplayWire,
} from "../../lib/workspacePreferences";
import { patchWorkspaceSettings } from "../../lib/workspaceSettingsApi";
import { useInvalidateWorkspaceSettings } from "../../lib/useWorkspaceSettings";

export function WorkspaceStorageCard({
  storageDisplay,
}: {
  storageDisplay: WorkspaceStorageDisplayWire | undefined;
}) {
  const invalidate = useInvalidateWorkspaceSettings();
  const [retentionPolicy, setRetentionPolicy] =
    useState<RetentionPolicyId>("indefinite");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!storageDisplay) return;
    setRetentionPolicy(storageDisplay.retentionPolicy);
  }, [storageDisplay]);

  const bucketLabel =
    storageDisplay?.uploadsBucket ??
    (storageDisplay ? "Not configured" : "…");
  const providerLabel =
    storageDisplay?.provider === "object-storage"
      ? "Object storage"
      : (storageDisplay?.provider ?? "Object storage");

  const retentionHint = RETENTION_POLICY_OPTIONS.find(
    (o) => o.id === retentionPolicy,
  )?.hint;

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await patchWorkspaceSettings({
        preferences: { storage: { retentionPolicy } },
      });
      await invalidate();
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className="workspace-card" data-testid="workspace-storage-card">
      <header className="workspace-card-head">
        <span className="workspace-card-icon">
          <FolderOpen size={14} />
        </span>
        <h2 className="workspace-card-title">Storage</h2>
      </header>
      <dl className="workspace-card-rows">
        <div className="workspace-card-row">
          <dt className="workspace-card-row-label">Uploads bucket</dt>
          <dd
            className="workspace-card-row-value"
            data-testid="workspace-uploads-bucket"
          >
            {bucketLabel}
          </dd>
        </div>
        <div className="workspace-card-row">
          <dt className="workspace-card-row-label">Provider</dt>
          <dd className="workspace-card-row-value">{providerLabel}</dd>
        </div>
      </dl>
      <p className="sc-meta mb-1">Retention policy</p>
      <select
        className="sc-input mb-1"
        value={retentionPolicy}
        onChange={(e) =>
          setRetentionPolicy(e.target.value as RetentionPolicyId)
        }
        data-testid="workspace-retention-policy"
      >
        {RETENTION_POLICY_OPTIONS.map(({ id, label }) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </select>
      {retentionHint && (
        <p className="sc-meta opacity-60 mb-2">{retentionHint}</p>
      )}
      <button
        type="button"
        className="sc-btn-primary sc-btn-sm workspace-card-cta"
        disabled={saving}
        onClick={() => void handleSave()}
        data-testid="workspace-storage-save"
      >
        {saving ? "Saving…" : "Save storage policy"}
      </button>
      {saved && (
        <span className="sc-meta" style={{ color: "var(--success-text)" }}>
          Saved.
        </span>
      )}
      {error && (
        <span className="sc-meta" style={{ color: "var(--danger-text)" }}>
          {error}
        </span>
      )}
    </article>
  );
}
