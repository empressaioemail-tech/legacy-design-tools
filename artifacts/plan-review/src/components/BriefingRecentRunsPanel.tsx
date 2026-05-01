import { useState } from "react";
import {
  useListEngagementBriefingGenerationRuns,
  getListEngagementBriefingGenerationRunsQueryKey,
  type BriefingGenerationRun,
} from "@workspace/api-client-react";

/**
 * URL helpers — Task #303 B.6.
 *
 * Mirrors the design-tools `BriefingRecentRunsPanel` URL contract
 * (Tasks #262 / #275) onto the Plan Review surface so an auditor
 * who pastes a Plan Review link into Slack lands a teammate on the
 * same disclosure state — open vs collapsed, "All / Failed only /
 * Invalid only" filter — that the original auditor was looking at,
 * instead of an empty default they have to re-derive every time.
 *
 * The two artifacts are deliberately near-identical here: same
 * query-param names, same enum values, same `replaceState` strategy
 * (so flipping the toggle doesn't pollute back-button history with
 * one entry per click). They are NOT shared via a workspace lib —
 * URL helpers are tiny enough that a lib import would be heavier
 * than the duplication, and Plan Review's surface only needs the
 * read+write halves, not the design-tools-specific kickoff wiring.
 */
const RECENT_RUNS_FILTER_QUERY_PARAM = "recentRunsFilter";
const RECENT_RUNS_OPEN_QUERY_PARAM = "recentRunsOpen";

type RecentRunsFilter = "all" | "failed" | "invalid";

function readRecentRunsFilterFromUrl(): RecentRunsFilter {
  if (typeof window === "undefined") return "all";
  const raw = new URLSearchParams(window.location.search).get(
    RECENT_RUNS_FILTER_QUERY_PARAM,
  );
  if (raw === "failed" || raw === "invalid") return raw;
  return "all";
}

function writeRecentRunsFilterToUrl(next: RecentRunsFilter): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (next === "all") {
    url.searchParams.delete(RECENT_RUNS_FILTER_QUERY_PARAM);
  } else {
    url.searchParams.set(RECENT_RUNS_FILTER_QUERY_PARAM, next);
  }
  window.history.replaceState(null, "", url.toString());
}

function readRecentRunsOpenFromUrl(): boolean {
  if (typeof window === "undefined") return false;
  const raw = new URLSearchParams(window.location.search).get(
    RECENT_RUNS_OPEN_QUERY_PARAM,
  );
  return raw === "1";
}

function writeRecentRunsOpenToUrl(next: boolean): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (next) {
    url.searchParams.set(RECENT_RUNS_OPEN_QUERY_PARAM, "1");
  } else {
    url.searchParams.delete(RECENT_RUNS_OPEN_QUERY_PARAM);
  }
  window.history.replaceState(null, "", url.toString());
}

/**
 * Human-readable label for one {@link BriefingGenerationRun}'s state.
 *
 * Mirrors `BRIEFING_RUN_STATE_LABELS` in
 * `artifacts/design-tools/src/pages/EngagementDetail.tsx` (Task #230)
 * so the two surfaces render identical wording. Plan Review and
 * Design Tools live in separate artifacts and cannot import from
 * each other; the `BriefingGenerationRun["state"]` enum keeps the
 * two copies in lock-step via exhaustive `Record` typing.
 */
const BRIEFING_RUN_STATE_LABELS: Record<
  BriefingGenerationRun["state"],
  string
> = {
  pending: "Running",
  completed: "Completed",
  failed: "Failed",
};

const BRIEFING_RUN_STATE_COLORS: Record<
  BriefingGenerationRun["state"],
  { bg: string; fg: string }
> = {
  pending: { bg: "var(--info-dim)", fg: "var(--info-text)" },
  completed: { bg: "var(--success-dim)", fg: "var(--success-text)" },
  failed: { bg: "var(--danger-dim)", fg: "var(--danger-text)" },
};

function BriefingRunStateBadge({
  state,
}: {
  state: BriefingGenerationRun["state"];
}) {
  // Defensive narrowing: a forward-compat enum value the FE has not
  // shipped a label for yet falls back to the raw slug so the UI
  // degrades gracefully instead of rendering blank.
  const label = BRIEFING_RUN_STATE_LABELS[state] ?? state;
  const palette =
    BRIEFING_RUN_STATE_COLORS[state] ?? BRIEFING_RUN_STATE_COLORS.pending;
  return (
    <span
      data-testid={`briefing-run-state-badge-${state}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "1px 6px",
        borderRadius: 4,
        background: palette.bg,
        color: palette.fg,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: 0.2,
        textTransform: "uppercase",
        lineHeight: 1.4,
      }}
    >
      {label}
    </span>
  );
}

/**
 * BriefingRecentRunsPanel — Plan Review-side audit view (Task #261).
 *
 * Mirrors the disclosure of the same name in
 * `artifacts/design-tools/src/pages/EngagementDetail.tsx` (Task #230)
 * so external auditors who land in Plan Review can see the same
 * retained briefing-generation history that internal designers see
 * in Design Tools, instead of bouncing across artifacts to
 * investigate a suspicious run.
 *
 * The two copies are intentionally near-identical — both render the
 * same data-testids, badges, and inline drilldown — but they are
 * NOT shared via a workspace lib because the design-tools copy is
 * coupled to the kickoff button's cache invalidation. The Plan
 * Review surface is read-only (auditors don't generate briefings),
 * so no kickoff wiring exists here.
 *
 * Behavior pinned by `BriefingRecentRunsPanel.test.tsx`:
 *   1. Collapsed by default and the runs hook stays disabled until
 *      the toggle flips, saving a round trip on every page load.
 *   2. Once opened, rows render newest-first with state badges and
 *      timestamps. The completed-with-invalid-citations row also
 *      surfaces the count summary in its collapsed header so
 *      auditors can spot the suspicious run without expanding it.
 *   3. Expanding a row reveals its `error` (failed branch) or
 *      `invalidCitationCount` (completed branch) inline. Only one
 *      row may be expanded at a time so the disclosure stays
 *      compact.
 */
export function BriefingRecentRunsPanel({
  engagementId,
}: {
  engagementId: string;
}) {
  // Task #303 B.6 — both the open/closed state of the disclosure and
  // the active filter are mirrored to the URL on every change so an
  // auditor who lands on a suspicious failed-then-rerun pattern can
  // drop a Plan Review link in a Slack thread that lands a teammate
  // on the same filtered, already-open view. The setters below sync
  // to `replaceState` so flipping the toggle doesn't pollute
  // back-button history with one entry per click.
  const [open, setOpenState] = useState<boolean>(() =>
    readRecentRunsOpenFromUrl(),
  );
  const setOpen = (next: boolean): void => {
    setOpenState(next);
    writeRecentRunsOpenToUrl(next);
  };
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [filter, setFilterState] = useState<RecentRunsFilter>(() =>
    readRecentRunsFilterFromUrl(),
  );
  const setFilter = (next: RecentRunsFilter): void => {
    setFilterState(next);
    writeRecentRunsFilterToUrl(next);
  };
  // Only fetch when the disclosure is open — the runs list is the
  // deeper comparison view, not the primary read, so it can stay
  // dormant until the auditor explicitly asks for it. Saves one
  // extra round trip on every page load for a feature most users
  // will not open every visit.
  const runsQuery = useListEngagementBriefingGenerationRuns(engagementId, {
    query: {
      queryKey: getListEngagementBriefingGenerationRunsQueryKey(engagementId),
      enabled: open,
      refetchOnWindowFocus: false,
    },
  });
  const runs: BriefingGenerationRun[] = runsQuery.data?.runs ?? [];
  const count = runs.length;
  // Per-bucket tallies so each filter chip can render a count
  // alongside its label — surfacing the count means an auditor
  // can see at a glance whether the comparison-of-attempts story
  // is even worth opening (e.g. "Failed only (0)" vs "Failed only
  // (3)") without clicking each chip just to discover the empty
  // state. Mirrors the design-tools `filterCounts` shape so any
  // future shared lib lifts trivially.
  const failedCount = runs.filter((run) => run.state === "failed").length;
  const invalidCount = runs.filter(
    (run) =>
      run.state === "completed" && (run.invalidCitationCount ?? 0) > 0,
  ).length;
  const filterCounts: Record<RecentRunsFilter, number> = {
    all: count,
    failed: failedCount,
    invalid: invalidCount,
  };
  const visibleRuns = runs.filter((run) => {
    if (filter === "failed") return run.state === "failed";
    if (filter === "invalid") {
      return run.state === "completed" && (run.invalidCitationCount ?? 0) > 0;
    }
    return true;
  });
  const visibleCount = visibleRuns.length;

  return (
    <div
      data-testid="briefing-recent-runs"
      style={{
        border: "1px solid var(--border-subtle)",
        borderRadius: 6,
        background: "var(--surface-1, transparent)",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="briefing-recent-runs-body"
        data-testid="briefing-recent-runs-toggle"
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600 }}>Recent runs</span>
        <span
          aria-hidden
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            marginLeft: 12,
          }}
        >
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div
          id="briefing-recent-runs-body"
          data-testid="briefing-recent-runs-body"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            padding: "0 12px 12px 12px",
          }}
        >
          {runsQuery.isLoading && (
            <div
              data-testid="briefing-recent-runs-loading"
              style={{ fontSize: 12, color: "var(--text-muted)" }}
            >
              Loading recent runs…
            </div>
          )}
          {runsQuery.isError && !runsQuery.isLoading && (
            <div
              role="alert"
              data-testid="briefing-recent-runs-error"
              style={{ fontSize: 12, color: "var(--danger-text)" }}
            >
              Couldn't load recent runs. Try again.
            </div>
          )}
          {!runsQuery.isLoading && !runsQuery.isError && count === 0 && (
            <div
              data-testid="briefing-recent-runs-empty"
              style={{ fontSize: 12, color: "var(--text-muted)" }}
            >
              No briefing generations have run yet for this engagement.
            </div>
          )}
          {/*
            Task #303 B.6 — filter chips ("All / Failed only / Invalid
            only") with per-bucket counts. Mirrors the design-tools
            disclosure (Task #262) so an auditor can slice the
            retained list down to the suspicious rows on the Plan
            Review side without bouncing back to design-tools. The
            active chip is reflected in the URL (`recentRunsFilter`)
            via `setFilter` so the link can be shared.
          */}
          {count > 0 && (
            <div
              data-testid="briefing-recent-runs-filter"
              role="tablist"
              aria-label="Filter recent runs"
              style={{
                display: "flex",
                gap: 6,
                fontSize: 11,
                marginBottom: 4,
              }}
            >
              {(["all", "failed", "invalid"] as const).map((f) => {
                const selected = filter === f;
                const label =
                  f === "all"
                    ? "All"
                    : f === "failed"
                      ? "Failed only"
                      : "Invalid only";
                return (
                  <button
                    key={f}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    data-testid={`briefing-recent-runs-filter-${f}`}
                    onClick={() => setFilter(f)}
                    style={{
                      padding: "2px 8px",
                      borderRadius: 4,
                      border: selected
                        ? "1px solid var(--accent, #6366f1)"
                        : "1px solid var(--border-subtle)",
                      background: selected
                        ? "var(--accent-dim, transparent)"
                        : "transparent",
                      color: "var(--text-default)",
                      cursor: "pointer",
                      fontSize: 11,
                    }}
                  >
                    {label} ({filterCounts[f]})
                  </button>
                );
              })}
            </div>
          )}
          {count > 0 && visibleCount === 0 && (
            <div
              data-testid="briefing-recent-runs-filtered-empty"
              style={{ fontSize: 12, color: "var(--text-muted)" }}
            >
              No runs match the {filter === "failed" ? "Failed only" : "Invalid only"}{" "}
              filter.
            </div>
          )}
          {visibleCount > 0 && (
            <ul
              data-testid="briefing-recent-runs-list"
              style={{
                listStyle: "none",
                margin: 0,
                padding: 0,
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              {visibleRuns.map((run) => {
                const isExpanded = expandedRunId === run.generationId;
                const startedLabel = new Date(run.startedAt).toLocaleString();
                const detailAvailable =
                  (run.state === "failed" && !!run.error) ||
                  (run.state === "completed" &&
                    (run.invalidCitationCount ?? 0) > 0);
                return (
                  <li
                    key={run.generationId}
                    data-testid={`briefing-run-${run.generationId}`}
                    style={{
                      border: "1px solid var(--border-subtle)",
                      borderRadius: 4,
                      background: "transparent",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedRunId((prev) =>
                          prev === run.generationId ? null : run.generationId,
                        )
                      }
                      aria-expanded={isExpanded}
                      data-testid={`briefing-run-toggle-${run.generationId}`}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "6px 8px",
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                        textAlign: "left",
                        fontSize: 12,
                      }}
                    >
                      <BriefingRunStateBadge state={run.state} />
                      <span style={{ flex: 1, color: "var(--text-default)" }}>
                        {startedLabel}
                      </span>
                      {run.state === "completed" &&
                        (run.invalidCitationCount ?? 0) > 0 && (
                          <span
                            data-testid={`briefing-run-invalid-count-${run.generationId}`}
                            style={{
                              fontSize: 11,
                              color: "var(--warning-text)",
                            }}
                          >
                            {run.invalidCitationCount} invalid citation
                            {run.invalidCitationCount === 1 ? "" : "s"}
                          </span>
                        )}
                      <span
                        aria-hidden
                        style={{ fontSize: 11, color: "var(--text-muted)" }}
                      >
                        {isExpanded ? "▾" : "▸"}
                      </span>
                    </button>
                    {isExpanded && (
                      <div
                        data-testid={`briefing-run-details-${run.generationId}`}
                        style={{
                          padding: "0 8px 8px 8px",
                          fontSize: 12,
                          color: "var(--text-muted)",
                          display: "flex",
                          flexDirection: "column",
                          gap: 2,
                        }}
                      >
                        <div>
                          Started: {new Date(run.startedAt).toLocaleString()}
                        </div>
                        <div>
                          Completed:{" "}
                          {run.completedAt
                            ? new Date(run.completedAt).toLocaleString()
                            : "—"}
                        </div>
                        {run.state === "failed" && (
                          <div
                            data-testid={`briefing-run-error-${run.generationId}`}
                            style={{ color: "var(--danger-text)" }}
                          >
                            Error: {run.error ?? "Unknown error"}
                          </div>
                        )}
                        {run.state === "completed" && (
                          <div
                            data-testid={`briefing-run-invalid-detail-${run.generationId}`}
                          >
                            Invalid citations:{" "}
                            {run.invalidCitationCount ?? 0}
                          </div>
                        )}
                        {!detailAvailable && run.state === "pending" && (
                          <div>Generation in progress…</div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
