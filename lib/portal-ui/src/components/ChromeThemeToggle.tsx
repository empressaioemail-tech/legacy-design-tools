import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import {
  getChromeTheme,
  isDarkChromeTheme,
  toggleTheme,
  type ChromeThemeId,
} from "../lib/theme";

/** Sun/moon toggle — dark family (navy / charcoal) ↔ soft light. */
export function ChromeThemeToggle() {
  const [theme, setThemeState] = useState<ChromeThemeId>("dark");

  useEffect(() => {
    setThemeState(getChromeTheme());
    if (typeof MutationObserver === "undefined") return;
    const obs = new MutationObserver(() => setThemeState(getChromeTheme()));
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => obs.disconnect();
  }, []);

  const isDark = isDarkChromeTheme(theme);
  const label = isDark
    ? "Switch to soft light theme"
    : "Switch to dark theme";

  return (
    <button
      type="button"
      onClick={() => setThemeState(toggleTheme())}
      aria-label={label}
      aria-pressed={!isDark}
      title={label}
      data-testid="chrome-theme-toggle"
      className="chrome-theme-toggle"
      style={{
        width: 32,
        height: 32,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        border: "1px solid var(--border-default)",
        borderRadius: 6,
        color: "var(--text-secondary)",
        cursor: "pointer",
        flexShrink: 0,
      }}
    >
      {isDark ? <Sun size={14} /> : <Moon size={14} />}
    </button>
  );
}
