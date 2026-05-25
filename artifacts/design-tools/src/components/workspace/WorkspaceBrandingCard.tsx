import { useEffect, useMemo, useState } from "react";
import { Palette } from "lucide-react";
import { CortexWordmark } from "../CortexBrand";
import {
  WORKSPACE_ACCENT_PRESETS,
  letterHeaderPreviewStyle,
} from "../../lib/workspaceBranding";
import {
  patchWorkspaceSettings,
  type WorkspaceSettingsWire,
} from "../../lib/workspaceSettingsApi";
import { applyWorkspaceAccent } from "../../lib/workspaceBranding";
import { useInvalidateWorkspaceSettings } from "../../lib/useWorkspaceSettings";

export function WorkspaceBrandingCard({
  settings,
  firmDisplayName,
  onFirmNameHint,
}: {
  settings: WorkspaceSettingsWire | undefined;
  firmDisplayName: string;
  onFirmNameHint?: () => void;
}) {
  const invalidate = useInvalidateWorkspaceSettings();
  const [logoUrl, setLogoUrl] = useState("");
  const [primaryColor, setPrimaryColor] = useState<string | null>(null);
  const [customHex, setCustomHex] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!settings) return;
    setLogoUrl(settings.logoUrl ?? "");
    setPrimaryColor(settings.primaryColor ?? null);
    const preset = WORKSPACE_ACCENT_PRESETS.find(
      (p) => p.value === (settings.primaryColor ?? null),
    );
    if (!preset && settings.primaryColor) {
      setCustomHex(settings.primaryColor);
    } else {
      setCustomHex("");
    }
  }, [settings]);

  const activePresetId = useMemo(() => {
    if (!primaryColor) return "default";
    const match = WORKSPACE_ACCENT_PRESETS.find((p) => p.value === primaryColor);
    return match?.id ?? "custom";
  }, [primaryColor]);

  const accentPreview = primaryColor ?? "var(--cyan)";

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await patchWorkspaceSettings({
        logoUrl: logoUrl.trim() || null,
        primaryColor,
      });
      applyWorkspaceAccent(updated.primaryColor);
      await invalidate();
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className="workspace-card" data-testid="workspace-branding-card">
      <header className="workspace-card-head">
        <span className="workspace-card-icon">
          <Palette size={14} />
        </span>
        <h2 className="workspace-card-title">Branding</h2>
      </header>

      <div className="workspace-branding-field">
        <span className="sc-meta">Primary accent</span>
        <p className="sc-meta opacity-60 mb-2">
          Buttons, links, and highlights across the workspace.
        </p>
        <div className="workspace-accent-presets" data-testid="workspace-accent-presets">
          {WORKSPACE_ACCENT_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="workspace-accent-preset"
              data-active={activePresetId === preset.id ? "true" : "false"}
              data-testid={`workspace-accent-${preset.id}`}
              onClick={() => {
                setPrimaryColor(preset.value);
                setCustomHex("");
              }}
            >
              <span
                className="workspace-accent-swatch"
                style={{
                  background: preset.value ?? "var(--cyan)",
                }}
              />
              <span className="workspace-accent-preset-label">{preset.label}</span>
            </button>
          ))}
          <button
            type="button"
            className="workspace-accent-preset"
            data-active={activePresetId === "custom" ? "true" : "false"}
            data-testid="workspace-accent-custom"
            onClick={() => {
              const hex = customHex.trim() || "#00B4D8";
              setPrimaryColor(hex);
              setCustomHex(hex);
            }}
          >
            <span
              className="workspace-accent-swatch"
              style={{
                background: customHex || accentPreview,
              }}
            />
            <span className="workspace-accent-preset-label">Custom</span>
          </button>
        </div>
        {activePresetId === "custom" && (
          <input
            type="text"
            className="sc-input mt-2"
            placeholder="#00B4D8"
            value={customHex}
            onChange={(e) => {
              const v = e.target.value.trim();
              setCustomHex(v);
              if (/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(v)) {
                setPrimaryColor(v.toUpperCase());
              }
            }}
            data-testid="workspace-primary-color-input"
          />
        )}
      </div>

      <div className="workspace-branding-field">
        <span className="sc-meta">Navigation mark</span>
        <p className="sc-meta opacity-60 mb-2">
          Leave logo URL empty to use the Cortex mark in the left rail.
        </p>
        <div className="workspace-nav-mark-preview" data-testid="workspace-nav-mark-preview">
          {logoUrl.trim() ? (
            <img
              src={logoUrl.trim()}
              alt="Firm logo"
              className="workspace-nav-mark-img"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          ) : (
            <CortexWordmark height={22} />
          )}
        </div>
        <label className="sc-meta mt-2" htmlFor="workspace-branding-logo-url">
          Firm logo URL (optional)
        </label>
        <input
          id="workspace-branding-logo-url"
          type="url"
          className="sc-input"
          value={logoUrl}
          onChange={(e) => setLogoUrl(e.target.value)}
          placeholder="https://…"
          data-testid="workspace-branding-logo-url"
        />
      </div>

      <div className="workspace-branding-field">
        <span className="sc-meta">Letter header</span>
        <p className="sc-meta opacity-60 mb-2">
          Shown on exported letters and PDFs. Uses your firm display name from
          Organization
          {onFirmNameHint ? (
            <>
              {" "}
              (
              <button
                type="button"
                className="workspace-inline-link"
                onClick={onFirmNameHint}
              >
                edit name
              </button>
              ).
            </>
          ) : (
            "."
          )}
        </p>
        <div
          className="workspace-letter-header-preview"
          data-testid="workspace-letter-header-preview"
        >
          <div style={letterHeaderPreviewStyle}>
            {firmDisplayName.trim() || "Your firm name"}
          </div>
        </div>
      </div>

      <button
        type="button"
        className="sc-btn-primary sc-btn-sm workspace-card-cta"
        disabled={saving}
        onClick={() => void handleSave()}
        data-testid="workspace-branding-save"
      >
        {saving ? "Saving…" : "Save branding"}
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
