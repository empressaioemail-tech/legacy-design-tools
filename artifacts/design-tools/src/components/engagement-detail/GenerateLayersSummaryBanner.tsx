import type { GenerateLayersOutcome } from "@workspace/api-client-react";

/**
 * "x ago" label for the {@link GenerateLayersSummaryBanner} top-of-list
 * summary banner. Mirrors the row-level cache pill's clamping rules
 * (future timestamps collapse to "just now" so client/server clock
 * skew never reads as a confusing negative) but uses long-form
 * units ("12 minutes ago", "2 hours ago") because the banner sits
 * in a sentence — "Last run 12 minutes ago — …" — instead of the
 * tight pill the row-level helper feeds.
 */
function formatRunAgeLabel(at: Date): string {
  const diffMs = Date.now() - at.getTime();
  if (diffMs < 60_000) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) {
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/**
 * Task #229 — top-of-list summary banner for the most recent
 * Generate Layers run. Surfaces three things in one line so an
 * architect can answer at a glance:
 *
 *   - When the last run resolved on the client ("Last run
 *     12 minutes ago" via {@link formatRunAgeLabel}).
 *   - How many of the run's persisted layers came from the
 *     federal-adapter response cache vs. a live upstream
 *     fetch ("4 of 5 layers served from cache"). Only
 *     `status=ok` outcomes count as "layers" — `failed` and
 *     `no-coverage` are excluded from both numerator and
 *     denominator so the ratio always reads against actual
 *     persisted rows.
 *   - A "Force refresh" CTA wired to the same forceRefresh
 *     mutation the controls header already exposes.
 *
 * Hides itself entirely when there are no outcomes yet so a
 * first-time visitor isn't confused by an empty placeholder.
 * Exported so the SiteContextTab unit test can render it in
 * isolation against a fixture outcomes array.
 */
export function GenerateLayersSummaryBanner({
  outcomes,
  lastRunAt,
  isRefreshing,
  onForceRefresh,
}: {
  outcomes: GenerateLayersOutcome[];
  lastRunAt: Date | null;
  isRefreshing: boolean;
  onForceRefresh: () => void;
}) {
  if (lastRunAt === null || outcomes.length === 0) return null;

  const layerCount = outcomes.filter((o) => o.status === "ok").length;
  const cachedCount = outcomes.filter(
    (o) => o.status === "ok" && o.fromCache,
  ).length;
  const ageLabel = formatRunAgeLabel(lastRunAt);

  return (
    <div
      data-testid="generate-layers-summary-banner"
      role="status"
      style={{
        fontSize: 12,
        color: "var(--text-secondary)",
        background: "var(--info-dim)",
        padding: "8px 12px",
        borderRadius: 4,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <div
        data-testid="generate-layers-summary-banner-text"
        style={{ display: "flex", flexWrap: "wrap", gap: 6 }}
      >
        <span style={{ fontWeight: 600 }}>Last run {ageLabel}</span>
        {layerCount > 0 && (
          <span data-testid="generate-layers-summary-banner-cache-count">
            — {cachedCount} of {layerCount}{" "}
            {layerCount === 1 ? "layer" : "layers"} served from cache.
          </span>
        )}
      </div>
      <button
        type="button"
        className="sc-btn-link"
        onClick={onForceRefresh}
        disabled={isRefreshing}
        data-testid="generate-layers-summary-banner-force-refresh"
        title="Re-run every adapter live, bypassing the federal-adapter response cache for this one run."
        style={{
          fontSize: 12,
          color: "var(--text-link, var(--cyan, #06b6d4))",
          background: "transparent",
          border: "none",
          padding: "2px 4px",
          cursor: isRefreshing ? "not-allowed" : "pointer",
          textDecoration: "underline",
          opacity: isRefreshing ? 0.5 : 1,
          flexShrink: 0,
        }}
      >
        Force refresh
      </button>
    </div>
  );
}
