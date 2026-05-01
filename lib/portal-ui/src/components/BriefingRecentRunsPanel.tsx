import { useEffect, useMemo, useState, type ReactNode } from "react";
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
import { diffWords } from "@workspace/briefing-diff";
// Task #355 — the prior-narrative title row, "Generated <when> by
// <actor>" meta line, and "Copy plain text" button (with its 2 s
// "Copied!" confirmation) live in `@workspace/briefing-prior-snapshot`
// so the testids, copy payload shape, and revert timing stay byte-
// identical with the design-tools surface without copy-pasting two
// parallel JSX subtrees. We accept it via the optional
// `renderPriorSnapshotHeader` render-prop instead of importing it
// directly here because `briefing-prior-snapshot` already imports
// `CopyPlainTextButton` from this package — a direct import would
// create a workspace-level dependency cycle (portal-ui ↔
// briefing-prior-snapshot). Artifact-level consumers
// (plan-review's SubmissionDetailModal / EngagementDetail) supply
// the header from the lib they already depend on.
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
 * Pill rendered next to a run row when it matches one of the
 * "interesting" generation ids the parent passed in (current
 * briefing run vs. the run that produced the submission's BIM
 * model). Both pills can render on the same row when the same
 * generation produced the current narrative AND the submitted BIM
 * model — that's the steady-state "everything's in sync" case.
 *
 * Surfacing these inline on the runs list is the core auditor cue
 * for "is what the reviewer is reading the same body the architect
 * submitted?" — the disclosure stays compact, but a glance at the
 * pills tells them whether the briefing has drifted since
 * submission.
 */
function RunRoleBadge({
  kind,
}: {
  kind: "current" | "submitted";
}) {
  const palette =
    kind === "current"
      ? { bg: "var(--accent-dim, rgba(0,180,216,0.18))", fg: "var(--cyan, #00b4d8)" }
      : { bg: "var(--warning-dim, rgba(245,158,11,0.18))", fg: "var(--warning-text, #f59e0b)" };
  const label = kind === "current" ? "Current" : "Submitted";
  return (
    <span
      data-testid={`briefing-run-role-badge-${kind}`}
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

export interface BriefingRecentRunsPanelProps {
  engagementId: string;
  /**
   * Optional — id of the run that produced the briefing's currently-
   * visible A–G narrative (i.e. `briefing.narrative.generationId`).
   * When provided, the matching row in the runs list is highlighted
   * and tagged with a "Current" pill so auditors can match the on-
   * screen narrative to its producing run by id rather than
   * inferring it from a timestamp window.
   */
  currentGenerationId?: string | null;
  /**
   * Optional — id of the run that produced the BIM model attached to
   * the submission the auditor is investigating. When this differs
   * from `currentGenerationId`, both pills render on different rows,
   * making it visually obvious that the briefing has drifted since
   * submission. This wire field does not exist on
   * `EngagementSubmissionSummary` today; surfaces that don't yet
   * have it should leave this prop unset.
   */
  producingGenerationId?: string | null;
  /**
   * Optional render-prop for the Task #355 prior-narrative header
   * (title row + "Generated <when> by <actor>" meta + "Copy plain
   * text" button). Accepted as a render-prop instead of an inline
   * import because the shared component lives in
   * `@workspace/briefing-prior-snapshot`, which already depends on
   * `@workspace/portal-ui` (for `CopyPlainTextButton`) — importing it
   * here would create a workspace cycle. Consumers that already
   * depend on `briefing-prior-snapshot` (plan-review,
   * design-tools — though design-tools uses its own local panel)
   * pass `BriefingPriorSnapshotHeader` here. When omitted (e.g. in
   * unit tests that don't exercise the prior-narrative branch), the
   * header is simply not rendered above the per-section diff.
   */
  renderPriorSnapshotHeader?: (args: {
    runGenerationId: string;
    priorNarrative: EngagementBriefingNarrative;
  }) => ReactNode;
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
 *   5. Task #305 — when `currentGenerationId` and/or
 *      `producingGenerationId` are passed, the matching row(s) are
 *      highlighted and tagged with "Current" / "Submitted" pills so
 *      the auditor can instantly see whether what the reviewer is
 *      reading matches what the architect submitted.
 */
export function BriefingRecentRunsPanel({
  engagementId,
  currentGenerationId,
  producingGenerationId,
  renderPriorSnapshotHeader,
}: BriefingRecentRunsPanelProps) {
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
  // Task #355 — the title row, the meta line, and the
  // "Copy plain text" button (the latter delegating to the
  // Task #350 `<CopyPlainTextButton />` in `@workspace/portal-ui`
  // for the discriminated success / error pill state, the ~2 s
  // revert timer, the unmount cleanup, and the
  // `briefing-run-prior-narrative-copy-*` testids) now live in
  // the shared `<BriefingPriorSnapshotHeader />` from
  // `@workspace/briefing-prior-snapshot`. The two surfaces
  // consume one implementation so the JSX, testids, friendly
  // actor rewrite, and copy-button timing can never drift.
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

  // Task #305 — the drift summary, rendered in the disclosure header
  // so the auditor sees "current and submitted match" or
  // "current ≠ submitted" without expanding any row. Only meaningful
  // when both ids are known.
  const driftSummary =
    currentGenerationId && producingGenerationId
      ? currentGenerationId === producingGenerationId
        ? "in sync"
        : "drifted"
      : null;

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
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {driftSummary && (
            <span
              data-testid={`briefing-recent-runs-drift-${driftSummary === "in sync" ? "in-sync" : "drifted"}`}
              style={{
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: 0.2,
                textTransform: "uppercase",
                padding: "1px 6px",
                borderRadius: 4,
                background:
                  driftSummary === "in sync"
                    ? "var(--success-dim)"
                    : "var(--warning-dim, rgba(245,158,11,0.18))",
                color:
                  driftSummary === "in sync"
                    ? "var(--success-text)"
                    : "var(--warning-text, #f59e0b)",
              }}
            >
              {driftSummary === "in sync"
                ? "current = submitted"
                : "current ≠ submitted"}
            </span>
          )}
          <span
            aria-hidden
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              marginLeft: 4,
            }}
          >
            {open ? "▾" : "▸"}
          </span>
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
                const isCurrent =
                  !!currentGenerationId &&
                  run.generationId === currentGenerationId;
                const isProducing =
                  !!producingGenerationId &&
                  run.generationId === producingGenerationId;
                const highlight = isCurrent || isProducing;
                return (
                  <li
                    key={run.generationId}
                    data-testid={`briefing-run-${run.generationId}`}
                    data-current={isCurrent ? "true" : undefined}
                    data-producing={isProducing ? "true" : undefined}
                    style={{
                      border: highlight
                        ? "1px solid var(--cyan, #00b4d8)"
                        : "1px solid var(--border-subtle)",
                      borderRadius: 4,
                      background: highlight
                        ? "var(--accent-dim, rgba(0,180,216,0.08))"
                        : "transparent",
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
                      {isCurrent && <RunRoleBadge kind="current" />}
                      {isProducing && <RunRoleBadge kind="submitted" />}
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
                          //
                          // Task #355 — the title row, "Generated
                          // <when> by <actor>" meta line, and "Copy
                          // plain text" button (with its 2 s
                          // "Copied!" confirmation) live in
                          // `@workspace/briefing-prior-snapshot` so
                          // the testids, copy payload shape, and
                          // revert timing stay byte-identical with
                          // the design-tools surface without copy-
                          // pasting two parallel JSX subtrees. Plan
                          // Review still owns its `relativeTime`-vs-
                          // `.toLocaleString()` formatting choice
                          // via the `formatGeneratedAt` prop so the
                          // existing Task #332 test contract ("5 min
                          // ago" with absolute tooltip) still holds.
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
                            {renderPriorSnapshotHeader?.({
                              runGenerationId: run.generationId,
                              priorNarrative,
                            })}
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
