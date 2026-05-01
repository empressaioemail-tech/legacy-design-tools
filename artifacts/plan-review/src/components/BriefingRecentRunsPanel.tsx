import { useEffect, useMemo, useRef, useState } from "react";
import { useSearch } from "wouter";
import {
  useGetEngagementBriefing,
  useListEngagementBriefingGenerationRuns,
  getGetEngagementBriefingQueryKey,
  getListEngagementBriefingGenerationRunsQueryKey,
  type BriefingGenerationRun,
  type EngagementBriefingNarrative,
} from "@workspace/api-client-react";
// Task #314 — the per-section word-level diff that powers the
// prior-narrative panel was extracted into `@workspace/briefing-diff`
// (originally lifted from `artifacts/design-tools/src/pages/
// EngagementDetail.tsx`, Task #303 B.5) so the Plan Review reviewer
// view can render the same diff without copy-pasting the LCS
// routine. Both artifacts cannot import each other, so the helper
// has to live in a shared lib if both are to use it.
import { diffWords, formatBriefingActor } from "@workspace/briefing-diff";
// Task #332 — the prior-narrative meta line renders the snapshot's
// `generatedAt` as a relative-time string ("5 min ago", "3d ago",
// etc.) instead of a raw locale stamp so an auditor scanning the
// disclosure can tell at a glance how recent the prior body is
// without parsing a full date. The absolute timestamp is preserved
// in the element's `title` attribute for the precise-time tooltip
// (and so a hover still reveals the exact instant a screenshot was
// captured against). Mirrors the per-artifact helper Plan Review
// already uses for submission timestamps; lifting it into a shared
// lib is tracked separately so this task stays focused.
import { relativeTime } from "../lib/relativeTime";

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
 * Section ordering used by the prior-narrative diff block.
 *
 * Mirrors `SECTION_ORDER` in
 * `artifacts/design-tools/src/pages/EngagementDetail.tsx` (Task #303)
 * so the Plan Review-side panel walks the seven A–G section bodies
 * in the same order the architect-facing surface does. Kept inline
 * (rather than lifted into `@workspace/briefing-diff`) because the
 * order is panel-rendering-specific — the diff helper itself is
 * section-agnostic — and a forward-compat addition (Task #303 says
 * sections may eventually grow beyond G) is a one-line edit on this
 * tuple alone.
 */
type BriefingSectionKey = "a" | "b" | "c" | "d" | "e" | "f" | "g";

const SECTION_ORDER: ReadonlyArray<{
  key: BriefingSectionKey;
  label: string;
}> = [
  { key: "a", label: "A — Executive Summary" },
  { key: "b", label: "B — Threshold Issues" },
  { key: "c", label: "C — Regulatory Gates" },
  { key: "d", label: "D — Site Infrastructure" },
  { key: "e", label: "E — Buildable Envelope" },
  { key: "f", label: "F — Neighboring Context" },
  { key: "g", label: "G — Next-Step Checklist" },
];

function pickSection(
  narrative: EngagementBriefingNarrative | null,
  key: BriefingSectionKey,
): string | null {
  if (!narrative) return null;
  switch (key) {
    case "a":
      return narrative.sectionA;
    case "b":
      return narrative.sectionB;
    case "c":
      return narrative.sectionC;
    case "d":
      return narrative.sectionD;
    case "e":
      return narrative.sectionE;
    case "f":
      return narrative.sectionF;
    case "g":
      return narrative.sectionG;
  }
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
 *   4. Task #314 — when the runs envelope carries a
 *      `priorNarrative` payload, the row whose
 *      `[startedAt, completedAt]` interval contains
 *      `priorNarrative.generatedAt` gets a "Prior" pill and an
 *      inline per-A–G-section diff against the current narrative
 *      (mirrors design-tools Task #303 B.5). Sections that are
 *      byte-identical between the prior and current bodies render
 *      a small "(unchanged)" pill in place of the diff so the
 *      auditor isn't asked to re-read identical paragraphs.
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
  // Task #348 — keep the disclosure in sync with the URL on
  // post-mount navigations as well as the initial mount. The original
  // wiring only seeded `open` from the URL once (via `useState`'s
  // initializer); a wouter `Link` click that lands on the same
  // engagement page (e.g. the new "View full briefing" deep-link
  // from the Engagement Context tab in the submission detail modal)
  // would rewrite the search string to `recentRunsOpen=1` but leave
  // the panel collapsed because the panel was already mounted.
  // `useSearch` re-renders on wouter pushState navigations, so this
  // effect picks the new value off the URL and syncs `open` to it.
  // Manual toggle clicks go through `setOpen` (above), which writes
  // via `replaceState` — wouter does not observe `replaceState`, so
  // the user's own toggle does not loop back through this effect.
  const search = useSearch();
  useEffect(() => {
    const next = readRecentRunsOpenFromUrl();
    setOpenState((prev) => (prev === next ? prev : next));
  }, [search]);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  // Task #338 — closes the loop on the "Copy plain text" button
  // (Task #333, mirroring design-tools Task #303 B.4). Clipboard
  // writes are silent on success, so an auditor who clicks the
  // button can't tell whether the copy landed without pasting
  // somewhere else to verify. Tracking the generationId of the row
  // whose copy just resolved lets the button swap its label to
  // "Copied!" for ~2s and then revert, without any modal or toast
  // infrastructure. The 2000 ms duration and `*-copy-confirm-*`
  // testid are kept byte-identical with the design-tools side
  // (`artifacts/design-tools/src/pages/EngagementDetail.tsx`,
  // search for `briefing-run-prior-narrative-copy-confirm-`) so a
  // future shared-lib lift is a no-op and so an auditor moving
  // between the two surfaces sees the same confirmation timing.
  const [copiedRunId, setCopiedRunId] = useState<string | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Clear the pending revert on unmount so a click that races the
  // disclosure being collapsed (or the page being navigated away
  // from) doesn't leak a setTimeout that fires against an
  // already-unmounted tree.
  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    };
  }, []);
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
  // Task #314 — the diff renderer needs the *current* narrative to
  // diff each prior section against. The briefing query is gated on
  // the same `open` flag so a page load that never touches the
  // disclosure costs zero extra round trips, mirroring the runs hook
  // above.
  const briefingQuery = useGetEngagementBriefing(engagementId, {
    query: {
      queryKey: getGetEngagementBriefingQueryKey(engagementId),
      enabled: open,
      refetchOnWindowFocus: false,
    },
  });
  const currentNarrative: EngagementBriefingNarrative | null =
    briefingQuery.data?.briefing?.narrative ?? null;
  const runs: BriefingGenerationRun[] = runsQuery.data?.runs ?? [];
  // Task #314 — the wire envelope also carries the section_a..g
  // backup the briefing held *before* its current narrative was
  // written. There's at most one (the briefing row only retains
  // one snapshot — older runs have already been overwritten by
  // newer regenerations) so we resolve the producing row by
  // matching its [startedAt, completedAt] interval against the
  // backup's `generatedAt` timestamp.
  const priorNarrative: EngagementBriefingNarrative | null =
    runsQuery.data?.priorNarrative ?? null;
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

  // Task #314 — same interval-match shape as design-tools Task #280:
  // resolves to the generationId of the run whose [startedAt,
  // completedAt] window contains `priorNarrative.generatedAt` —
  // i.e. the run that produced the body now living in
  // `prior_section_*`. Older rows in the list whose backups have
  // already been overwritten will not match (the briefing row only
  // retains one snapshot) so they fall through to the existing
  // details branch with no prior body to render. A missing or
  // unparseable timestamp resolves to null so we never pick an
  // arbitrary row.
  const priorGenerationId = useMemo<string | null>(() => {
    if (!priorNarrative || priorNarrative.generatedAt === null) return null;
    // The orval/zod codegen coerces `generatedAt` to a string at
    // the wire layer, but tests + the runtime queryFn pass through
    // ISO strings as well as `Date` instances, so normalize via
    // `new Date(...)` which accepts both shapes and yields `NaN`
    // on garbage.
    const stampedMs = new Date(
      priorNarrative.generatedAt as unknown as Date | string,
    ).getTime();
    if (Number.isNaN(stampedMs)) return null;
    for (const run of runs) {
      if (run.state !== "completed") continue;
      if (run.completedAt === null) continue;
      const startedMs = Date.parse(String(run.startedAt));
      const completedMs = Date.parse(String(run.completedAt));
      if (Number.isNaN(startedMs) || Number.isNaN(completedMs)) continue;
      if (stampedMs >= startedMs && stampedMs <= completedMs) {
        return run.generationId;
      }
    }
    return null;
  }, [priorNarrative, runs]);

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
                // Task #314 — only the row whose interval contains
                // the prior backup's `generatedAt` gets the inline
                // prior body. Older rows (whose backups have already
                // been overwritten by newer regenerations) fall
                // through to the existing details branch with no
                // prior section block — the briefing row only
                // retains one snapshot, so we can't honestly
                // surface anything for them.
                const isPriorRow =
                  priorGenerationId !== null &&
                  run.generationId === priorGenerationId;
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
                      {isPriorRow && (
                        // Task #314 — flag the row that produced
                        // what was on screen *before* the current
                        // narrative so the side-by-side comparison
                        // story reads end-to-end. Mirrors the
                        // design-tools Prior pill (Task #280).
                        <span
                          data-testid={`briefing-run-prior-pill-${run.generationId}`}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            padding: "1px 6px",
                            borderRadius: 4,
                            background: "var(--surface-2, var(--border-subtle))",
                            color: "var(--text-muted)",
                            fontSize: 10,
                            fontWeight: 600,
                            letterSpacing: 0.2,
                            textTransform: "uppercase",
                            lineHeight: 1.4,
                          }}
                        >
                          Prior
                        </span>
                      )}
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
                        {isPriorRow && priorNarrative && (
                          // Task #314 — render the seven A–G section
                          // bodies the briefing held *before* its
                          // current narrative was written, with each
                          // section diffed word-by-word against the
                          // matching current section. Only mounted
                          // on the Prior row so older rows whose
                          // backups have already been overwritten
                          // don't get a misleading "this is the
                          // prior body" block. Mirrors the
                          // design-tools Task #303 B.5 block.
                          // Task #333 — also mirrors the design-tools
                          // Task #303 B.4 "Copy plain text" button so
                          // an auditor on Plan Review can drop the
                          // pre-regeneration snapshot into a Slack
                          // thread or ticket without hand-selecting
                          // each A–G section.
                          // Task #337 — mirrors the design-tools Task
                          // #303 B.3 "Generated [time] by [author]"
                          // meta line so the auditor sees the
                          // snapshot's provenance in-place rather
                          // than having to read it off the producing
                          // run row above. Closes the last remaining
                          // parity gap on the prior-narrative block.
                          <div
                            data-testid={`briefing-run-prior-narrative-${run.generationId}`}
                            style={{
                              marginTop: 6,
                              display: "flex",
                              flexDirection: "column",
                              gap: 4,
                              borderTop: "1px solid var(--border-subtle)",
                              paddingTop: 6,
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                alignItems: "flex-start",
                                justifyContent: "space-between",
                                gap: 12,
                              }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  flexDirection: "column",
                                  gap: 2,
                                  minWidth: 0,
                                }}
                              >
                                <div
                                  style={{
                                    fontSize: 11,
                                    fontWeight: 600,
                                    color: "var(--text-default)",
                                    textTransform: "uppercase",
                                    letterSpacing: 0.3,
                                  }}
                                >
                                  Narrative on screen before this run was
                                  overwritten
                                </div>
                                {/* Task #344 — the meta line itself
                                    lives below the title/Copy-button
                                    flex row (see the
                                    `formatBriefingActor`-driven block
                                    further down). An earlier mirror
                                    pass also rendered it inside this
                                    column with a hardcoded
                                    "system:briefing-engine" ternary,
                                    which (a) duplicated the
                                    `briefing-run-prior-narrative-meta-…`
                                    testid (every test that called
                                    `findByTestId` on it threw on the
                                    duplicate) and (b) re-introduced
                                    the per-surface friendly-label
                                    drift the shared
                                    `@workspace/briefing-diff`
                                    `formatBriefingActor` helper was
                                    extracted to prevent. The single
                                    rendering site below is the
                                    canonical one. */}
                              </div>
                              {/* Task #333 — "Copy plain text" button.
                                  Concatenates the seven A–G bodies as
                                  `Label\n\nbody` blocks separated by
                                  blank lines so the pasted output is
                                  readable in a Slack thread or ticket
                                  without any post-processing. Empty
                                  sections render as "—" so the
                                  pasted snapshot preserves the
                                  panel's own placeholder rather than
                                  leaving the auditor staring at a
                                  blank label. Uses the async
                                  Clipboard API (which the test
                                  environment polyfills via JSDOM's
                                  `navigator.clipboard.writeText`).
                                  Falls back silently when the API is
                                  unavailable so we never throw
                                  inside an event handler. Mirrors
                                  the design-tools `briefing-run-
                                  prior-narrative-copy-${"$"}{
                                  generationId}` testid + payload
                                  shape so a future shared lib lift
                                  is a no-op. */}
                              {/* Task #338 — flip the label to
                                  "Copied!" for ~2s on a successful
                                  write so the auditor sees the copy
                                  landed. The flip only happens once
                                  `writeText` resolves — an
                                  unavailable API or a rejected
                                  promise never shows the
                                  confirmation, so the indicator
                                  can't false-positive. The 2000 ms
                                  duration and the
                                  `*-copy-confirm-*` testid are kept
                                  in lock-step with the design-tools
                                  side (Task #303 B.4 / #338) so a
                                  future shared-lib lift is a no-op
                                  and an auditor moving between the
                                  two surfaces sees the same
                                  confirmation timing. */}
                              {(() => {
                                const COPIED_CONFIRMATION_MS = 2000;
                                const isCopied =
                                  copiedRunId === run.generationId;
                                return (
                                  <button
                                    type="button"
                                    data-testid={`briefing-run-prior-narrative-copy-${run.generationId}`}
                                    onClick={() => {
                                      const text = SECTION_ORDER.map(
                                        ({ key, label }) => {
                                          const body =
                                            pickSection(priorNarrative, key) ??
                                            "";
                                          return `${label}\n\n${body.trim() || "—"}`;
                                        },
                                      ).join("\n\n");
                                      if (
                                        typeof navigator === "undefined" ||
                                        !navigator.clipboard ||
                                        typeof navigator.clipboard
                                          .writeText !== "function"
                                      ) {
                                        return;
                                      }
                                      // Capture the id at click time
                                      // so a fast row-swap doesn't
                                      // confirm the wrong row.
                                      const generationId = run.generationId;
                                      navigator.clipboard
                                        .writeText(text)
                                        .then(() => {
                                          if (
                                            copiedTimerRef.current !== null
                                          ) {
                                            clearTimeout(
                                              copiedTimerRef.current,
                                            );
                                          }
                                          setCopiedRunId(generationId);
                                          copiedTimerRef.current = setTimeout(
                                            () => {
                                              setCopiedRunId(null);
                                              copiedTimerRef.current = null;
                                            },
                                            COPIED_CONFIRMATION_MS,
                                          );
                                        })
                                        .catch(() => {
                                          // Swallow — falls back
                                          // silently when the
                                          // Clipboard API is
                                          // unavailable or rejects,
                                          // so the auditor never
                                          // sees a false-positive
                                          // confirmation.
                                        });
                                    }}
                                    style={{
                                      fontSize: 11,
                                      padding: "2px 8px",
                                      background: "transparent",
                                      border: "1px solid var(--border-subtle)",
                                      borderRadius: 4,
                                      cursor: "pointer",
                                      color: "var(--text-default)",
                                      whiteSpace: "nowrap",
                                    }}
                                  >
                                    {isCopied ? (
                                      <span
                                        data-testid={`briefing-run-prior-narrative-copy-confirm-${run.generationId}`}
                                        aria-live="polite"
                                      >
                                        Copied!
                                      </span>
                                    ) : (
                                      "Copy plain text"
                                    )}
                                  </button>
                                );
                              })()}
                            </div>
                            {/* Task #332 — mirror the design-tools Task #303
                                B.3 meta line onto the Plan Review surface
                                so an external auditor sees who/when produced
                                the prior snapshot in-place, instead of
                                bouncing back to design-tools to investigate
                                the producing actor. The wire envelope's
                                `priorNarrative.generatedAt` and
                                `generatedBy` may be null for legacy backups
                                where the per-row provenance post-dates the
                                section_* columns; render only the half
                                that's set so we never show "by null". The
                                "system:briefing-engine" actor is rewritten
                                to the same friendly "Briefing engine (mock)"
                                label design-tools uses so the two surfaces
                                read identically. */}
                            {(priorNarrative.generatedAt ||
                              priorNarrative.generatedBy) && (
                              <div
                                data-testid={`briefing-run-prior-narrative-meta-${run.generationId}`}
                                style={{
                                  fontSize: 11,
                                  color: "var(--text-muted)",
                                }}
                              >
                                {priorNarrative.generatedAt && (
                                  <span
                                    data-testid={`briefing-run-prior-narrative-generated-at-${run.generationId}`}
                                    // Task #332 — absolute timestamp
                                    // lives in the tooltip so a hover
                                    // still reveals the precise
                                    // instant. The visible text is the
                                    // relative-time string so the
                                    // auditor can tell at a glance how
                                    // recent the prior body is.
                                    title={new Date(
                                      priorNarrative.generatedAt as
                                        | Date
                                        | string,
                                    ).toLocaleString()}
                                  >
                                    Generated{" "}
                                    {relativeTime(
                                      priorNarrative.generatedAt as
                                        | Date
                                        | string,
                                    )}
                                  </span>
                                )}
                                {priorNarrative.generatedBy && (
                                  <>
                                    {priorNarrative.generatedAt ? " " : ""}
                                    <span
                                      data-testid={`briefing-run-prior-narrative-generated-by-${run.generationId}`}
                                    >
                                      by{" "}
                                      {formatBriefingActor(
                                        priorNarrative.generatedBy,
                                      ) ?? priorNarrative.generatedBy}
                                    </span>
                                  </>
                                )}
                              </div>
                            )}
                            {SECTION_ORDER.map(({ key, label }) => {
                              const priorBody = pickSection(
                                priorNarrative,
                                key,
                              );
                              const currentBody = pickSection(
                                currentNarrative,
                                key,
                              );
                              const priorIsEmpty =
                                !priorBody || priorBody.trim().length === 0;
                              // pickSection returns the raw column
                              // value, which can be `null` (column
                              // is NULL) OR `undefined` (the wire
                              // schema marks the field optional and
                              // the test fixture omitted it). Treat
                              // both as "no current body to diff
                              // against" — comparing a string to
                              // undefined would otherwise propagate
                              // through to `diffWords` and crash on
                              // `undefined.split(...)`.
                              const currentBodyStr =
                                typeof currentBody === "string"
                                  ? currentBody
                                  : null;
                              const sameAsCurrent =
                                !priorIsEmpty &&
                                currentBodyStr !== null &&
                                priorBody === currentBodyStr;
                              const shouldDiff =
                                !priorIsEmpty &&
                                currentBodyStr !== null &&
                                !sameAsCurrent;
                              return (
                                <div
                                  key={key}
                                  data-testid={`briefing-run-prior-section-${key}-${run.generationId}`}
                                  style={{
                                    fontSize: 12,
                                    color: priorIsEmpty
                                      ? "var(--text-muted)"
                                      : "var(--text-default)",
                                  }}
                                >
                                  <span
                                    style={{
                                      fontWeight: 600,
                                      marginRight: 6,
                                    }}
                                  >
                                    {label}
                                  </span>
                                  {sameAsCurrent && (
                                    <span
                                      data-testid={`briefing-run-prior-section-unchanged-${key}-${run.generationId}`}
                                      style={{
                                        fontSize: 10,
                                        padding: "1px 6px",
                                        borderRadius: 4,
                                        background:
                                          "var(--surface-2, transparent)",
                                        color: "var(--text-muted)",
                                        marginRight: 6,
                                        textTransform: "uppercase",
                                        letterSpacing: 0.3,
                                      }}
                                    >
                                      unchanged
                                    </span>
                                  )}
                                  <span
                                    style={{
                                      whiteSpace: "pre-wrap",
                                      lineHeight: 1.5,
                                    }}
                                  >
                                    {priorIsEmpty ? (
                                      "—"
                                    ) : shouldDiff ? (
                                      // Word-level diff: render
                                      // surviving tokens plain,
                                      // dropped tokens
                                      // strikethrough/red, and
                                      // inserted tokens
                                      // underlined/green so the
                                      // auditor sees both sides
                                      // of the edit inline. The
                                      // diff is wrapped in a
                                      // single span so the
                                      // white-space rule above
                                      // still applies.
                                      <span
                                        data-testid={`briefing-run-prior-section-diff-${key}-${run.generationId}`}
                                      >
                                        {diffWords(
                                          priorBody,
                                          currentBodyStr as string,
                                        ).map((op, idx) => {
                                          if (op.type === "equal") {
                                            return (
                                              <span key={idx}>{op.text}</span>
                                            );
                                          }
                                          if (op.type === "removed") {
                                            return (
                                              <span
                                                key={idx}
                                                data-testid={`briefing-run-prior-section-diff-removed-${key}-${run.generationId}`}
                                                style={{
                                                  textDecoration:
                                                    "line-through",
                                                  color: "var(--danger-text)",
                                                  background:
                                                    "var(--danger-dim)",
                                                }}
                                              >
                                                {op.text}
                                              </span>
                                            );
                                          }
                                          return (
                                            <span
                                              key={idx}
                                              data-testid={`briefing-run-prior-section-diff-added-${key}-${run.generationId}`}
                                              style={{
                                                textDecoration: "underline",
                                                color: "var(--success-text)",
                                                background:
                                                  "var(--success-dim)",
                                              }}
                                            >
                                              {op.text}
                                            </span>
                                          );
                                        })}
                                      </span>
                                    ) : (
                                      priorBody
                                    )}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
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
