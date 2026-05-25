import { useEffect, useState } from "react";

/** App chrome themes — drives `data-theme` on `<html>`. */
export type ChromeThemeId = "dark" | "charcoal" | "soft-light" | "light";

/** Themes exposed in Style Probe (production light stays on header toggle). */
export type StyleProbeThemeId = "dark" | "charcoal" | "soft-light";

/** @deprecated Prefer {@link ChromeThemeId}. */
export type ThemeName = "dark" | "light";

export const STYLE_PROBE_THEMES: ReadonlyArray<{
  id: StyleProbeThemeId;
  label: string;
  description: string;
}> = [
  {
    id: "dark",
    label: "Navy",
    description:
      "Production dark — cool blue undertone on surfaces and borders.",
  },
  {
    id: "charcoal",
    label: "Charcoal",
    description:
      "Near-monochrome deep greys — softened charcoal, not pure black.",
  },
  {
    id: "soft-light",
    label: "Soft light",
    description:
      "Full light UI — warm grey surfaces, sidebar, and panels match the main canvas.",
  },
] as const;

const STORAGE_KEY = "theme";
const LAST_DARK_STORAGE_KEY = "theme-last-dark";

const CHROME_THEMES: ChromeThemeId[] = [
  "dark",
  "charcoal",
  "soft-light",
  "light",
];

function isChromeThemeId(value: string | null | undefined): value is ChromeThemeId {
  return (
    value === "dark" ||
    value === "charcoal" ||
    value === "soft-light" ||
    value === "light"
  );
}

export function isDarkChromeTheme(themeId: ChromeThemeId): boolean {
  return themeId === "dark" || themeId === "charcoal";
}

export function applyChromeTheme(
  html: HTMLElement,
  themeId: ChromeThemeId,
): void {
  html.setAttribute("data-theme", themeId);
  html.classList.toggle("dark", isDarkChromeTheme(themeId));
}

function readStoredChromeTheme(): ChromeThemeId | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isChromeThemeId(stored)) return stored;
  } catch {
    // ignore storage errors (private mode, etc)
  }
  return null;
}

function readLastDarkChromeTheme(): ChromeThemeId {
  if (typeof localStorage === "undefined") return "charcoal";
  try {
    const stored = localStorage.getItem(LAST_DARK_STORAGE_KEY);
    if (stored === "dark" || stored === "charcoal") return stored;
  } catch {
    // ignore
  }
  return "charcoal";
}

function readSystemChromeTheme(): ChromeThemeId {
  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
  ) {
    try {
      if (window.matchMedia("(prefers-color-scheme: light)").matches) {
        return "soft-light";
      }
    } catch {
      // ignore matchMedia errors
    }
  }
  return "dark";
}

/** Persist and apply a chrome theme app-wide. */
export function setChromeTheme(themeId: ChromeThemeId): void {
  if (typeof document === "undefined") return;
  applyChromeTheme(document.documentElement, themeId);
  try {
    localStorage.setItem(STORAGE_KEY, themeId);
    if (isDarkChromeTheme(themeId)) {
      localStorage.setItem(LAST_DARK_STORAGE_KEY, themeId);
    }
  } catch {
    // ignore storage errors (private mode, etc)
  }
}

export function getChromeTheme(): ChromeThemeId {
  if (typeof document === "undefined") return "dark";
  const current = document.documentElement.getAttribute("data-theme");
  if (isChromeThemeId(current)) return current;
  return "dark";
}

/** Back-compat wrapper — maps legacy light/dark to chrome themes. */
export function setTheme(name: ThemeName): void {
  setChromeTheme(name === "light" ? "light" : "dark");
}

/**
 * Apply persisted chrome theme on boot. When nothing is stored, honour
 * OS `prefers-color-scheme` without writing to localStorage.
 */
export function initTheme(): void {
  if (typeof document === "undefined") return;
  const stored = readStoredChromeTheme();
  if (stored) {
    applyChromeTheme(document.documentElement, stored);
    return;
  }
  const fromOs = readSystemChromeTheme();
  applyChromeTheme(document.documentElement, fromOs);
}

/** Back-compat — returns dark unless the active chrome theme is light. */
export function getTheme(): ThemeName {
  const chrome = getChromeTheme();
  return chrome === "light" || chrome === "soft-light" ? "light" : "dark";
}

/**
 * Header toggle: dark family (navy / charcoal) ↔ soft light.
 * Remembers which dark variant was last selected.
 */
export function toggleTheme(): ChromeThemeId {
  const current = getChromeTheme();
  if (isDarkChromeTheme(current)) {
    setChromeTheme("soft-light");
    return "soft-light";
  }
  const next = readLastDarkChromeTheme();
  setChromeTheme(next);
  return next;
}

/** React hook — mirrors `<html data-theme>` for chrome pickers and header. */
export function useChromeTheme(): {
  themeId: ChromeThemeId;
  setThemeId: (id: ChromeThemeId) => void;
} {
  const [themeId, setThemeIdState] = useState<ChromeThemeId>(() =>
    typeof document === "undefined" ? "dark" : getChromeTheme(),
  );

  useEffect(() => {
    setThemeIdState(getChromeTheme());
    if (typeof MutationObserver === "undefined") return;
    const obs = new MutationObserver(() => {
      setThemeIdState(getChromeTheme());
    });
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => obs.disconnect();
  }, []);

  return {
    themeId,
    setThemeId: (id: ChromeThemeId) => {
      setChromeTheme(id);
      setThemeIdState(id);
    },
  };
}

/** @deprecated Use {@link useChromeTheme}. */
export function useStyleProbeThemePreview(
  initial: StyleProbeThemeId = "dark",
): {
  themeId: StyleProbeThemeId;
  setThemeId: (id: StyleProbeThemeId) => void;
} {
  const chrome = useChromeTheme();
  return {
    themeId: (chrome.themeId === "light"
      ? initial
      : chrome.themeId) as StyleProbeThemeId,
    setThemeId: (id: StyleProbeThemeId) => chrome.setThemeId(id),
  };
}
