/**
 * Friendly-label rewrite for the briefing narrative's `generatedBy`
 * actor token.
 *
 * Both the design-tools `EngagementDetail.tsx` panel (Task #303 B.3
 * meta line) and the Plan Review `BriefingRecentRunsPanel.tsx`
 * mirror (Task #332) render a "Generated <when> by <who>" meta line
 * underneath each prior-narrative block. The mock briefing generator
 * stamps `system:briefing-engine` for that field, which reads as a
 * code-side identifier on either surface — both panels rewrite it
 * to the friendlier `"Briefing engine (mock)"`.
 *
 * Lifting that conditional into a shared helper means a future actor
 * token (e.g. a real LLM provider, a `system:cron` job, or a
 * per-user attribution) gets the friendly rewrite in one place
 * instead of two near-identical inline ternaries that would silently
 * drift when only one side is updated. The helper lives here in
 * `@workspace/briefing-diff` because both panels already depend on
 * this lib for the diff renderer, so no new workspace dependency is
 * needed (Task #340).
 *
 * Contract:
 *   - `null` (and the empty string) — return `null` so callers can
 *     short-circuit the meta line entirely instead of rendering
 *     "by null" / "by ".
 *   - `"system:briefing-engine"` — the friendly mock label both
 *     panels' B.3 tests pin.
 *   - Anything else — return the raw token unchanged so a
 *     newly-introduced producer still attributes itself, just with
 *     a less polished label until a mapping lands.
 */
export function formatBriefingActor(
  generatedBy: string | null | undefined,
): string | null {
  if (generatedBy == null || generatedBy.length === 0) return null;
  if (generatedBy === "system:briefing-engine") return "Briefing engine (mock)";
  return generatedBy;
}
