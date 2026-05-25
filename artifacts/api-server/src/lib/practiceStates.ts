const STATE_RE = /^[A-Z]{2}$/;

export function normalizePracticeStates(
  raw: unknown,
): { ok: true; value: string[] } | { ok: false; error: string } {
  if (raw === undefined) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, error: "invalid_practice_states" };
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      return { ok: false, error: "invalid_practice_states" };
    }
    const st = entry.trim().toUpperCase();
    if (!st) continue;
    if (!STATE_RE.test(st)) {
      return { ok: false, error: "invalid_practice_state_code" };
    }
    if (!seen.has(st)) {
      seen.add(st);
      out.push(st);
    }
    if (out.length > 10) {
      return { ok: false, error: "practice_states_max_exceeded" };
    }
  }
  return { ok: true, value: out };
}
