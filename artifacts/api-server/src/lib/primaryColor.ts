const HEX_RE = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;

export function normalizePrimaryColor(
  raw: unknown,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined) {
    return { ok: true, value: null };
  }
  if (raw === null || raw === "") {
    return { ok: true, value: null };
  }
  if (typeof raw !== "string") {
    return { ok: false, error: "invalid_primary_color" };
  }
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  if (!HEX_RE.test(trimmed)) {
    return { ok: false, error: "invalid_primary_color" };
  }
  if (trimmed.length === 4) {
    const r = trimmed[1];
    const g = trimmed[2];
    const b = trimmed[3];
    return { ok: true, value: `#${r}${r}${g}${g}${b}${b}`.toUpperCase() };
  }
  return { ok: true, value: trimmed.toUpperCase() };
}
