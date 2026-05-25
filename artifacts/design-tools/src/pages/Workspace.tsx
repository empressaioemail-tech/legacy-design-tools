import { useEffect, useMemo, useRef, useState } from "react";
import { Building2 } from "lucide-react";
import { US_STATE_OPTIONS } from "../lib/jurisdictionSurfacing";
import { TabHeader } from "../components/cockpit/TabChrome";
import { WorkspaceBrandingCard } from "../components/workspace/WorkspaceBrandingCard";
import { WorkspaceJurisdictionsCard } from "../components/workspace/WorkspaceJurisdictionsCard";
import { WorkspacePresentationCard } from "../components/workspace/WorkspacePresentationCard";
import { WorkspaceStorageCard } from "../components/workspace/WorkspaceStorageCard";
import {
  patchWorkspaceSettings,
} from "../lib/workspaceSettingsApi";
import {
  useApplyWorkspaceAccent,
  useInvalidateWorkspaceSettings,
  useWorkspaceSettings,
} from "../lib/useWorkspaceSettings";

/**
 * Workspace → Product settings (QA-57).
 *
 * Organization + branding persist via /api/workspace/settings.
 */
export function Workspace() {
  const firmNameRef = useRef<HTMLInputElement>(null);
  const { data: settings } = useWorkspaceSettings();
  useApplyWorkspaceAccent(settings);
  const invalidate = useInvalidateWorkspaceSettings();
  const [firmName, setFirmName] = useState("Cortex Workspace");
  const [practiceStates, setPracticeStates] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!settings) return;
    setFirmName(settings.firmDisplayName);
    setPracticeStates(settings.practiceStates ?? []);
  }, [settings]);

  const handleSaveOrg = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await patchWorkspaceSettings({
        firmDisplayName: firmName.trim() || "Cortex Workspace",
        practiceStates,
      });
      await invalidate();
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const togglePracticeState = (code: string) => {
    setPracticeStates((prev) => {
      if (prev.includes(code)) return prev.filter((c) => c !== code);
      if (prev.length >= 10) return prev;
      return [...prev, code];
    });
  };

  const practiceSorted = useMemo(
    () => [...practiceStates].sort(),
    [practiceStates],
  );

  return (
    <div className="cockpit-tab" data-testid="workspace-settings">
      <TabHeader
        overline="Workspace"
        title="Product settings"
        subtitle="Workspace-level branding, layer defaults, PDF export, and storage policy."
      />

      <div className="workspace-grid">
        <article className="workspace-card" data-testid="workspace-org-card">
          <header className="workspace-card-head">
            <span className="workspace-card-icon">
              <Building2 size={14} />
            </span>
            <h2 className="workspace-card-title">Organization</h2>
          </header>
          <label className="sc-meta" htmlFor="workspace-firm-name">
            Firm display name
          </label>
          <input
            ref={firmNameRef}
            id="workspace-firm-name"
            type="text"
            className="sc-input"
            value={firmName}
            onChange={(e) => setFirmName(e.target.value)}
            data-testid="workspace-firm-name-input"
          />
          <p className="sc-meta mt-3 mb-1">Practice regions (US states)</p>
          <p className="sc-meta opacity-60 mb-2">
            Filters Code Library before you have projects. Up to 10 states.
          </p>
          <div
            className="flex flex-wrap gap-1"
            data-testid="workspace-practice-states"
          >
            {US_STATE_OPTIONS.map(({ code, label }) => {
              const on = practiceStates.includes(code);
              return (
                <button
                  key={code}
                  type="button"
                  title={label}
                  data-testid={`workspace-state-${code}`}
                  onClick={() => togglePracticeState(code)}
                  className="workspace-chip"
                  data-active={on ? "true" : "false"}
                >
                  {code}
                </button>
              );
            })}
          </div>
          {practiceSorted.length > 0 && (
            <p className="sc-meta mt-2" data-testid="workspace-practice-selected">
              Selected: {practiceSorted.join(", ")}
            </p>
          )}
          <button
            type="button"
            className="sc-btn-primary sc-btn-sm workspace-card-cta"
            disabled={saving || !firmName.trim()}
            onClick={() => void handleSaveOrg()}
            data-testid="workspace-firm-name-save"
          >
            {saving ? "Saving…" : "Save"}
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

        <WorkspaceBrandingCard
          settings={settings}
          firmDisplayName={firmName}
          onFirmNameHint={() => firmNameRef.current?.focus()}
        />
        <WorkspaceJurisdictionsCard preferences={settings?.preferences} />
        <WorkspacePresentationCard preferences={settings?.preferences} />
        <WorkspaceStorageCard storageDisplay={settings?.storageDisplay} />
      </div>
    </div>
  );
}
