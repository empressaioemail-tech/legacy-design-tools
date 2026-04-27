export type ThemeName = "dark" | "light";

const STORAGE_KEY = "theme";

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

export function initTheme(): void {
  if (typeof document === "undefined") return;
  let saved: ThemeName = "dark";
  try {
    const stored = localStorage.getItem(STORAGE_KEY) as ThemeName | null;
    if (stored === "light" || stored === "dark") {
      saved = stored;
    }
  } catch {
    // ignore storage errors
  }
  setTheme(saved);
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
