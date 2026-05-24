import { STYLE_PROBE_THEMES, useStyleProbeThemePreview } from "../lib/theme";

export function StyleProbeThemePicker() {
  const { themeId, setThemeId } = useStyleProbeThemePreview("dark");
  const active = STYLE_PROBE_THEMES.find((t) => t.id === themeId);

  return (
    <div className="sc-card p-4" data-testid="style-probe-theme-picker">
      <div className="sc-label mb-3">CHROME PREVIEW</div>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Chrome preview theme">
        {STYLE_PROBE_THEMES.map((theme) => (
          <button
            key={theme.id}
            type="button"
            role="radio"
            aria-checked={themeId === theme.id}
            className={themeId === theme.id ? "sc-btn-primary" : "sc-btn-ghost"}
            onClick={() => setThemeId(theme.id)}
          >
            {theme.label}
          </button>
        ))}
      </div>
      {active && (
        <p className="sc-body mt-3" data-testid="style-probe-theme-description">
          {active.description}
        </p>
      )}
      <p className="sc-meta mt-2 opacity-70">
        Preview only — leaving Style Probe restores your saved theme.
      </p>
    </div>
  );
}
