import { useEffect, useState } from "react";
import { Globe } from "lucide-react";
import {
  FEDERAL_LAYER_OPTIONS,
  type FederalLayerKey,
  type WorkspacePreferencesWire,
} from "../../lib/workspacePreferences";
import { patchWorkspaceSettings } from "../../lib/workspaceSettingsApi";
import { useInvalidateWorkspaceSettings } from "../../lib/useWorkspaceSettings";

export function WorkspaceJurisdictionsCard({
  preferences,
}: {
  preferences: WorkspacePreferencesWire | undefined;
}) {
  const invalidate = useInvalidateWorkspaceSettings();
  const [federalLayers, setFederalLayers] = useState<
    Record<FederalLayerKey, boolean>
  >({
    fema: true,
    usgs: true,
    epa: true,
    fcc: false,
  });
  const [includeSiteLayers, setIncludeSiteLayers] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!preferences) return;
    setFederalLayers({ ...preferences.federalLayers });
    setIncludeSiteLayers(preferences.includeSiteLayers);
  }, [preferences]);

  const toggleFederal = (key: FederalLayerKey) => {
    setFederalLayers((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await patchWorkspaceSettings({
        preferences: { federalLayers, includeSiteLayers },
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
    <article
      className="workspace-card"
      data-testid="workspace-jurisdictions-card"
    >
      <header className="workspace-card-head">
        <span className="workspace-card-icon">
          <Globe size={14} />
        </span>
        <h2 className="workspace-card-title">Default jurisdictions</h2>
      </header>
      <p className="sc-meta opacity-60 mb-2">
        Controls which federal and site GIS layers run when you generate
        layers on a project. Code Library substrate still follows practice
        regions.
      </p>
      <p className="sc-meta mb-1">Federal adapters</p>
      <div className="flex flex-wrap gap-1" data-testid="workspace-federal-layers">
        {FEDERAL_LAYER_OPTIONS.map(({ key, label, hint }) => {
          const on = federalLayers[key];
          return (
            <button
              key={key}
              type="button"
              title={hint}
              data-testid={`workspace-federal-${key}`}
              onClick={() => toggleFederal(key)}
              className="workspace-chip"
              data-active={on ? "true" : "false"}
            >
              {label}
            </button>
          );
        })}
      </div>
      <label className="sc-meta mt-3 flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={includeSiteLayers}
          onChange={(e) => setIncludeSiteLayers(e.target.checked)}
          data-testid="workspace-include-site-layers"
        />
        County &amp; state GIS layers on new projects
      </label>
      <button
        type="button"
        className="sc-btn-primary sc-btn-sm workspace-card-cta"
        disabled={saving}
        onClick={() => void handleSave()}
        data-testid="workspace-jurisdictions-save"
      >
        {saving ? "Saving…" : "Save jurisdictions"}
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
