/**
 * Format an ISO timestamp as a short, human-friendly relative string
 * ("just now", "5 min ago", "3d ago", or a locale date for older dates).
 *
 * Returns `"—"` for `null`, `undefined`, or unparseable input — never
 * `"1970"`-style epoch garbage.
 *
 * Mirrors the per-artifact `relativeTime` helpers in
 * `artifacts/plan-review/src/lib/relativeTime.ts` and
 * `artifacts/design-tools/src/lib/relativeTime.ts`. Lifted into
 * `@workspace/portal-ui` so shared components like
 * `BriefingRecentRunsPanel` can format timestamps without depending
 * on a particular artifact's helper module.
 */
export function relativeTime(input: string | Date | null | undefined): string {
  if (!input) return "—";
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return "—";

  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.round(diffMs / 1000);

  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}
