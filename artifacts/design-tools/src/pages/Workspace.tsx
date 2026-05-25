import { useEffect, useState } from "react";
import { Building2, FolderOpen, Globe, Image as ImageIcon, Palette } from "lucide-react";
import { TabHeader } from "../components/cockpit/TabChrome";
import {
  fetchWorkspaceSettings,
  patchWorkspaceSettings,
} from "../lib/workspaceSettingsApi";

/**
 * Workspace → Product settings (QA-57).
 *
 * Firm display name persists via /api/workspace/settings. Other cards
 * remain honest preview copy until their backends land.
 */
export function Workspace() {
  const [firmName, setFirmName] = useState("Cortex Workspace");
  const [logoUrl, setLogoUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchWorkspaceSettings()
      .then((s) => {
        setFirmName(s.firmDisplayName);
        setLogoUrl(s.logoUrl ?? "");
      })
      .catch(() => {
        /* keep defaults */
      });
  }, []);

  const handleSaveOrg = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await patchWorkspaceSettings({
        firmDisplayName: firmName.trim() || "Cortex Workspace",
        logoUrl: logoUrl.trim() || null,
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="cockpit-tab" data-testid="workspace-settings">
      <TabHeader
        overline="Workspace"
        title="Product settings"
        subtitle="Workspace-level branding and defaults. Firm name is persisted; other controls preview upcoming backends."
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
            id="workspace-firm-name"
            type="text"
            className="sc-input"
            value={firmName}
            onChange={(e) => setFirmName(e.target.value)}
            data-testid="workspace-firm-name-input"
          />
          <label className="sc-meta mt-2" htmlFor="workspace-logo-url">
            Logo URL (optional)
          </label>
          <input
            id="workspace-logo-url"
            type="url"
            className="sc-input"
            value={logoUrl}
            onChange={(e) => setLogoUrl(e.target.value)}
            placeholder="https://…"
            data-testid="workspace-logo-url-input"
          />
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

        <SettingsCard
          icon={<Palette size={14} />}
          title="Branding"
          rows={[
            { label: "Primary color", value: "var(--cyan)" },
            { label: "Letter header", value: "Uses firm name above" },
          ]}
          comingSoon
        />
        <SettingsCard
          icon={<Globe size={14} />}
          title="Default jurisdictions"
          rows={[
            { label: "Federal", value: "FEMA, USGS NED, EPA, FCC" },
            { label: "Local", value: "From Code Library substrate" },
          ]}
          comingSoon
        />
        <SettingsCard
          icon={<ImageIcon size={14} />}
          title="Presentation defaults"
          rows={[
            { label: "Cover template", value: "Cockpit / Cyan" },
            { label: "Watermark", value: "Draft" },
          ]}
          comingSoon
        />
        <SettingsCard
          icon={<FolderOpen size={14} />}
          title="Storage"
          rows={[
            { label: "Uploads bucket", value: "Object storage" },
            { label: "Retention", value: "Indefinite (pilot)" },
          ]}
          comingSoon
        />
      </div>
    </div>
  );
}

function SettingsCard({
  icon,
  title,
  rows,
  comingSoon = false,
}: {
  icon: React.ReactNode;
  title: string;
  rows: Array<{ label: string; value: string }>;
  comingSoon?: boolean;
}) {
  return (
    <article className="workspace-card">
      <header className="workspace-card-head">
        <span className="workspace-card-icon">{icon}</span>
        <h2 className="workspace-card-title">{title}</h2>
      </header>
      <dl className="workspace-card-rows">
        {rows.map((r, i) => (
          <div key={i} className="workspace-card-row">
            <dt className="workspace-card-row-label">{r.label}</dt>
            <dd className="workspace-card-row-value">{r.value}</dd>
          </div>
        ))}
      </dl>
      {comingSoon && (
        <p className="sc-meta opacity-60">More controls coming soon.</p>
      )}
    </article>
  );
}
