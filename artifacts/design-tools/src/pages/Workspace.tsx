import { Building2, FolderOpen, Globe, Image as ImageIcon, Palette } from "lucide-react";
import { TabHeader } from "../components/cockpit/TabChrome";
import { DraftBadge } from "../components/cockpit/QualityChips";

/**
 * Workspace → Product settings (stub).
 *
 * Read-only IA preview of the per-workspace settings the publishing
 * + branding lanes will need. Every form control is disabled with
 * "coming soon" copy — no settings are persisted, no API call is
 * made.
 */
export function Workspace() {
  return (
    <div className="cockpit-tab" data-testid="workspace-stub">
      <TabHeader
        overline="Workspace"
        title="Product settings"
        subtitle="Workspace-level branding, default jurisdictions, and publishing defaults. The Access + Publishing backends will hang off this surface."
        actions={<DraftBadge hint="Workspace settings UI is a preview" />}
      />

      <div className="workspace-grid">
        <SettingsCard
          icon={<Building2 size={14} />}
          title="Organization"
          rows={[
            { label: "Name", value: "SmartCity OS Workspace" },
            { label: "Plan", value: "Pilot" },
            { label: "Members", value: "3 active" },
          ]}
        />
        <SettingsCard
          icon={<Palette size={14} />}
          title="Branding"
          rows={[
            { label: "Logo", value: "smartcity-logo.svg" },
            { label: "Primary color", value: "var(--cyan)" },
            { label: "Letter header", value: "Default template" },
          ]}
        />
        <SettingsCard
          icon={<Globe size={14} />}
          title="Default jurisdictions"
          rows={[
            { label: "Federal", value: "FEMA, USGS NED, EPA, FCC" },
            { label: "State", value: "Utah · Idaho · Texas" },
            { label: "Local", value: "Grand · Lemhi · Bastrop" },
          ]}
        />
        <SettingsCard
          icon={<ImageIcon size={14} />}
          title="Presentation defaults"
          rows={[
            { label: "Cover template", value: "Cockpit / Cyan" },
            { label: "Section order", value: "Cover · Site · Findings · Letters" },
            { label: "Watermark", value: "Draft" },
          ]}
        />
        <SettingsCard
          icon={<FolderOpen size={14} />}
          title="Storage"
          rows={[
            { label: "Uploads bucket", value: "Replit object storage" },
            { label: "Quota", value: "50 GB" },
            { label: "Retention", value: "Indefinite (pilot)" },
          ]}
        />
      </div>

      <div className="workspace-coming-soon-banner">
        Coming soon — the form controls land with the workspace-settings
        backend. The card grid above is the IA preview.
      </div>
    </div>
  );
}

function SettingsCard({
  icon,
  title,
  rows,
}: {
  icon: React.ReactNode;
  title: string;
  rows: Array<{ label: string; value: string }>;
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
      <button
        type="button"
        className="sc-btn-ghost workspace-card-cta"
        disabled
        title="Coming soon"
      >
        Edit (coming soon)
      </button>
    </article>
  );
}
