export type ThemeName = "dark" | "light";

const STORAGE_KEY = "theme";

function readStoredTheme(): ThemeName | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // ignore storage errors (private mode, etc)
  }
  return null;
}

function readSystemTheme(): ThemeName {
  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
  ) {
    try {
      if (window.matchMedia("(prefers-color-scheme: light)").matches) {
        return "light";
      }
    } catch {
      // ignore matchMedia errors
    }
  }
  return "dark";
}

export function setTheme(name: ThemeName): void {
  if (typeof document === "undefined") return;
  const html = document.documentElement;
  html.dataset.theme = name;
  html.classList.toggle("dark", name === "dark");
  try {
    localStorage.setItem(STORAGE_KEY, name);
  } catch {
    // ignore storage errors (private mode, etc)
  }
}

/**
 * Apply the user's persisted theme on app boot. When no preference is
 * stored we honour the OS `prefers-color-scheme` setting so a light-mode
 * user lands on a light dashboard the first time they open it.
 *
 * The OS-derived choice is applied to `data-theme` but intentionally
 * NOT written to localStorage — that way a later OS theme switch still
 * cascades to the dashboard until the user makes an explicit pick via
 * the header toggle.
 */
export function initTheme(): void {
  if (typeof document === "undefined") return;
  const stored = readStoredTheme();
  if (stored) {
    setTheme(stored);
    return;
  }
  const fromOs = readSystemTheme();
  const html = document.documentElement;
  html.dataset.theme = fromOs;
  html.classList.toggle("dark", fromOs === "dark");
}

export function getTheme(): ThemeName {
  if (typeof document === "undefined") return "dark";
  const t = document.documentElement.dataset.theme;
  return t === "light" ? "light" : "dark";
}

export function toggleTheme(): ThemeName {
  const next: ThemeName = getTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}
