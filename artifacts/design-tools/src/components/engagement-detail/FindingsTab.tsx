import { ChevronDown, ChevronRight, PanelRightClose, PanelRightOpen, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  FindingCategory,
  useCreateEngagementSubmission,
  useGenerateSubmissionFindings,
  useGetSubmissionFindingsGenerationStatus,
  useListEngagementSubmissions,
  useListSubmissionFindings,
  useOverrideFinding,
  getGetSubmissionFindingsGenerationStatusQueryKey,
  getListEngagementSubmissionsQueryKey,
  getListSubmissionFindingsQueryKey,
  type EngagementSubmissionSummary,
  type Finding,
} from "@workspace/api-client-react";
import { TabHeader } from "../cockpit/TabChrome";
import { SubmissionSelector } from "./SubmissionSelector";
import {
  ADDRESS_WITH_NEXT_REVISION_REVIEWER_COMMENT,
  CodeAtomDetailModal,
  FindingDetailPanel,
  FindingsList,
  countUnaddressedFindings,
} from "@workspace/portal-ui";
import {
  readFindingsCategoryFilterFromUrl,
  readFindingsSeverityFilterFromUrl,
  readFindingsShowAddressedFromUrl,
  writeFindingsCategoryFilterToUrl,
  writeFindingsSeverityFilterToUrl,
  writeFindingsShowAddressedToUrl,
  type FindingsCategoryFilter,
  type FindingsSeverityFilter,
} from "./urlState";

const FINDINGS_SEVERITY_CHIP_LABELS: Record<FindingsSeverityFilter, string> = {
  all: "All severities",
  blocker: "Blocker",
  concern: "Concern",
  advisory: "Advisory",
};

const FINDINGS_CATEGORY_CHIP_LABELS: Record<FindingCategory, string> = {
  setback: "Setback",
  height: "Height",
  coverage: "Coverage",
  egress: "Egress",
  use: "Use",
  "overlay-conflict": "Overlay conflict",
  "divergence-related": "Divergence",
  other: "Other",
};

/**
 * Filter chip strip for the Triage Inbox. Kept as three labelled rows
 * (severity / category / addressed) so the existing
 * `findings-tab-filter-*` testids continue to resolve. Renders inside
 * the left pane below the Open / All / Overridden tab strip.
 */
function FindingsFilterChips({
  severityFilter,
  onSeverityChange,
  categoryFilter,
  onCategoryChange,
  showAddressed,
  onShowAddressedChange,
}: {
  severityFilter: FindingsSeverityFilter;
  onSeverityChange: (next: FindingsSeverityFilter) => void;
  categoryFilter: FindingsCategoryFilter;
  onCategoryChange: (next: FindingsCategoryFilter) => void;
  showAddressed: boolean;
  onShowAddressedChange: (next: boolean) => void;
}) {
  const severityOptions: FindingsSeverityFilter[] = [
    "all",
    "blocker",
    "concern",
    "advisory",
  ];
  const categoryOptions: FindingsCategoryFilter[] = [
    "all",
    ...(Object.keys(FindingCategory) as FindingCategory[]),
  ];
  const chipStyle = (active: boolean): React.CSSProperties => ({
    padding: "2px 8px",
    borderRadius: 999,
    border: active
      ? "1px solid var(--cyan)"
      : "1px solid var(--border-default)",
    background: active ? "var(--cyan-accent-bg)" : "transparent",
    color: active ? "var(--cyan)" : "var(--text-secondary)",
    fontSize: 10,
    cursor: "pointer",
    fontFamily: "inherit",
  });
  return (
    <div
      data-testid="findings-tab-filters"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "8px 12px",
        borderBottom: "1px solid var(--border-subtle)",
      }}
    >
      <div
        data-testid="findings-tab-filters-severity"
        style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4 }}
      >
        <span
          className="sc-label"
          style={{ minWidth: 56, fontSize: 9, opacity: 0.6 }}
        >
          SEVERITY
        </span>
        {severityOptions.map((opt) => {
          const active = severityFilter === opt;
          return (
            <button
              key={opt}
              type="button"
              data-testid={`findings-tab-filter-severity-${opt}`}
              data-active={active ? "true" : "false"}
              onClick={() => onSeverityChange(opt)}
              style={chipStyle(active)}
            >
              {FINDINGS_SEVERITY_CHIP_LABELS[opt]}
            </button>
          );
        })}
      </div>
      <div
        data-testid="findings-tab-filters-category"
        style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4 }}
      >
        <span
          className="sc-label"
          style={{ minWidth: 56, fontSize: 9, opacity: 0.6 }}
        >
          CATEGORY
        </span>
        {categoryOptions.map((opt) => {
          const active = categoryFilter === opt;
          return (
            <button
              key={opt}
              type="button"
              data-testid={`findings-tab-filter-category-${opt}`}
              data-active={active ? "true" : "false"}
              onClick={() => onCategoryChange(opt)}
              style={chipStyle(active)}
            >
              {opt === "all" ? "All categories" : FINDINGS_CATEGORY_CHIP_LABELS[opt]}
            </button>
          );
        })}
      </div>
      <div
        data-testid="findings-tab-filters-addressed"
        style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4 }}
      >
        <span
          className="sc-label"
          style={{ minWidth: 56, fontSize: 9, opacity: 0.6 }}
        >
          ADDRESSED
        </span>
        <button
          type="button"
          data-testid="findings-tab-filter-show-addressed"
          data-active={!showAddressed ? "true" : "false"}
          aria-pressed={!showAddressed}
          onClick={() => onShowAddressedChange(!showAddressed)}
          style={chipStyle(!showAddressed)}
        >
          {showAddressed ? "Show addressed" : "Hide addressed"}
        </button>
      </div>
    </div>
  );
}

/**
 * Map a thrown re-run error to a user-facing string. Mirrors the
 * reviewer-side helper in
 * `artifacts/plan-review/src/pages/ComplianceEngine.tsx` — we keep
 * the architect-side surface in the same idiom so the strings stay
 * close in tone even if they diverge in wording.
 */
function describeRerunError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) {
      return "A finding-engine run is already in flight for this submission.";
    }
    if (err.status === 403) {
      return "Findings require internal audience.";
    }
    if (err.status === 404) {
      return "Submission not found.";
    }
    return err.message ?? "Failed to start plan review run.";
  }
  return "Failed to start plan review run.";
}

type TriageScope = "open" | "all" | "overridden";

/**
 * Horizontal progress bar used in the right-pane Findings Summary
 * block. Reads palette tokens (`--danger-text`, `--warning-text`,
 * `--info-text`) from the active theme so the bar tints stay in
 * sync with the rest of the cockpit.
 */
function SummaryBar({
  label,
  count,
  total,
  color,
}: {
  label: string;
  count: number;
  total: number;
  color: string;
}) {
  const pct = total <= 0 ? 0 : Math.min(100, Math.round((count / total) * 100));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 11,
          color: "var(--text-secondary)",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              background: color,
              display: "inline-block",
            }}
          />
          {label}
        </span>
        <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>
          {count} open
        </span>
      </div>
      <div
        style={{
          width: "100%",
          height: 4,
          borderRadius: 999,
          background: "var(--border-subtle)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: color,
            borderRadius: 999,
          }}
        />
      </div>
    </div>
  );
}

const TRIAGE_TAB_OPTIONS: { id: TriageScope; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "all", label: "All" },
  { id: "overridden", label: "Overridden" },
];

/**
 * Architect-side "Findings" tab (Task #421 / V1-1 / V1-7).
 *
 * Owns the per-engagement submission picker, the per-submission
 * findings query, and the override mutation. The list + detail
 * card themselves live in `lib/portal-ui` so any future reviewer
 * audit surface can render the same chrome — this component is the
 * thin data-layer adapter that wires those views to the engagement
 * page.
 *
 * Layout — Triage Inbox (graduated from the
 * `review-workspace/SplitInbox.tsx` canvas mockup):
 *
 *   - LEFT pane: submission picker + Open/All/Overridden tab strip +
 *     severity/category/addressed filter chips + scrolling
 *     `FindingsList`. The Open/All tabs are syntactic sugar over the
 *     existing `showAddressed` URL state (Open = hide overridden,
 *     All = show overridden too). The Overridden tab is a local-only
 *     view that forces show-addressed on and filters down to rows
 *     whose status is `overridden`.
 *   - CENTER pane: `FindingDetailPanel` (kept intact so the address /
 *     override / element-ref / citations behaviors and all
 *     `architect-finding-detail-*` testids continue to resolve).
 *   - RIGHT pane: submission context — status pill, submitted /
 *     responded timestamps, reviewer comment placeholder, findings
 *     summary bars (blockers / concerns / advisory), the rerun CTA,
 *     and the failure / error banners that used to live in the top
 *     strip.
 *
 * Selection rules:
 *   - Submission picker defaults to the engagement's most-recent
 *     submission (passed in by the parent so the badge fetch and
 *     this fetch share the same id without two reductions).
 *   - Selected finding clears whenever the submission switches —
 *     a finding from a different submission would render stale
 *     citations / CAD ref against the wrong drawings.
 *   - On submission switch we wait for the new findings list to
 *     resolve and then auto-select the first row in severity order
 *     so the detail panel is never blank when the architect first
 *     lands on a submission with at least one finding.
 *
 * The override mutation calls `useOverrideFinding` with the
 * existing row's text/severity/category preserved (the wire treats
 * an override as a same-content revision under a fresh reviewer
 * comment) and stamps {@link ADDRESS_WITH_NEXT_REVISION_REVIEWER_COMMENT}
 * so the reviewer-side timeline can render the "addressed in next
 * revision" affordance. On success we invalidate
 * `getListSubmissionFindingsQueryKey` for the active submission so
 * the row's status flips to `overridden` (which dims it via
 * {@link FindingsList}'s addressed branch) without a manual reload.
 */
export function FindingsTab({
  engagementId,
  initialSubmissionId,
  engagementJurisdiction,
  onElementRefClick,
}: {
  engagementId: string;
  initialSubmissionId: string | null;
  /** Used to gate self-run plan review when jurisdiction is unknown. */
  engagementJurisdiction?: string | null;
  /**
   * Invoked when the architect clicks the CAD `elementRef` chip on a
   * finding. The page wires this to swing the tab strip over to the
   * Site Context (3D BIM) tab and pre-select the element so the
   * "tap citation, see the wall" loop closes without manual tab juggling.
   */
  onElementRefClick?: (elementRef: string) => void;
}) {
  const queryClient = useQueryClient();
  const codeLibraryBase = `${import.meta.env.BASE_URL}code-library`;
  const [codeAtomModalId, setCodeAtomModalId] = useState<string | null>(null);

  const {
    data: submissions,
    isLoading: submissionsLoading,
    error: submissionsError,
  } = useListEngagementSubmissions(engagementId, {
    query: {
      enabled: !!engagementId,
      queryKey: getListEngagementSubmissionsQueryKey(engagementId),
    },
  });

  const sortedSubmissions = useMemo<EngagementSubmissionSummary[]>(() => {
    if (!submissions) return [];
    return [...submissions].sort(
      (a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt),
    );
  }, [submissions]);

  const [selectedSubmissionId, setSelectedSubmissionId] = useState<
    string | null
  >(initialSubmissionId);
  // Once submissions resolve, fall back to the freshest one so the
  // picker always has a valid selection — we do NOT overwrite an
  // explicit user pick once they touch the dropdown.
  useEffect(() => {
    if (selectedSubmissionId !== null) return;
    if (sortedSubmissions.length === 0) return;
    setSelectedSubmissionId(sortedSubmissions[0].id);
  }, [selectedSubmissionId, sortedSubmissions]);

  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(
    null,
  );
  // Drop the active selection whenever the submission changes —
  // citations and CAD refs would render against the wrong drawings.
  useEffect(() => {
    setSelectedFindingId(null);
  }, [selectedSubmissionId]);

  // Filter chips state (Task #436). Mirrored to the URL via the
  // helpers above so a deep-link survives a refresh, matching the
  // ?tab= and backfill-filter conventions.
  const [severityFilter, setSeverityFilterState] =
    useState<FindingsSeverityFilter>(() => readFindingsSeverityFilterFromUrl());
  const setSeverityFilter = (next: FindingsSeverityFilter): void => {
    setSeverityFilterState(next);
    writeFindingsSeverityFilterToUrl(next);
  };
  const [categoryFilter, setCategoryFilterState] =
    useState<FindingsCategoryFilter>(() => readFindingsCategoryFilterFromUrl());
  const setCategoryFilter = (next: FindingsCategoryFilter): void => {
    setCategoryFilterState(next);
    writeFindingsCategoryFilterToUrl(next);
  };
  const [showAddressed, setShowAddressedState] = useState<boolean>(() =>
    readFindingsShowAddressedFromUrl(),
  );

  // Triage-inbox tab strip. Open = hide overridden (the existing
  // `showAddressed=false` URL state). All = show overridden too
  // (showAddressed=true). Overridden is a local-only view that
  // filters down to status==='overridden' rows and is intentionally
  // NOT written to the URL — existing deep links and tests only
  // know about the show-addressed toggle, so the URL contract is
  // limited to Open/All.
  const [triageScope, setTriageScope] = useState<TriageScope>(() =>
    readFindingsShowAddressedFromUrl() ? "all" : "open",
  );
  const [filtersExpanded, setFiltersExpanded] = useState(true);
  const [contextOpen, setContextOpen] = useState(true);
  // Single setter for the addressed URL state so both the
  // Open/All tab clicks and the Hide-addressed chip flow through
  // the same place; keeps the tab strip and the chip in lockstep
  // without either one being "the source of truth" the other has
  // to read from.
  const setShowAddressed = (next: boolean): void => {
    setShowAddressedState(next);
    writeFindingsShowAddressedToUrl(next);
    // If the user toggles the addressed chip directly we keep the
    // tab strip coherent: false -> Open, true -> All. We do not
    // touch the scope when the user is parked on Overridden — that
    // tab manages its own filter and should not flip when the chip
    // moves under it.
    setTriageScope((scope) =>
      scope === "overridden" ? scope : next ? "all" : "open",
    );
  };
  const handleTriageScopeChange = (next: TriageScope) => {
    setTriageScope(next);
    // Open / All write to the URL via the existing show-addressed
    // contract. Overridden is purely local; we do NOT mutate the
    // URL when entering or leaving it so the deep-link behavior
    // matches what the existing tests and bookmarks expect.
    if (next === "open") {
      setShowAddressedState(false);
      writeFindingsShowAddressedToUrl(false);
    } else if (next === "all") {
      setShowAddressedState(true);
      writeFindingsShowAddressedToUrl(true);
    }
  };

  const findingsQueryKey = selectedSubmissionId
    ? getListSubmissionFindingsQueryKey(selectedSubmissionId)
    : (["findings", "none"] as const);
  const {
    data: findingsData,
    isLoading: findingsLoading,
    error: findingsError,
  } = useListSubmissionFindings(selectedSubmissionId ?? "", {
    query: {
      enabled: !!selectedSubmissionId,
      queryKey: findingsQueryKey,
    },
  });
  const findings = findingsData?.findings ?? [];

  // PL-02 — manual plan-review trigger. Status query polls
  // `/findings/status` at 1.5s while a run is pending, idle otherwise,
  // matching the reviewer-side ComplianceEngine cadence. The mutation
  // hits POST `/findings/generate`; on success we invalidate the
  // findings list + status so the list pops in the moment the engine
  // settles. Error copy is mapped through `describeRerunError`.
  const statusQuery = useGetSubmissionFindingsGenerationStatus(
    selectedSubmissionId ?? "",
    {
      query: {
        enabled: !!selectedSubmissionId,
        queryKey: selectedSubmissionId
          ? getGetSubmissionFindingsGenerationStatusQueryKey(
              selectedSubmissionId,
            )
          : (["findings-status", "none"] as const),
        refetchInterval: (q: { state: { data?: { state?: string } } }) =>
          q.state.data?.state === "pending" ? 1500 : false,
      },
    },
  );
  const [rerunError, setRerunError] = useState<string | null>(null);
  const [selfRunError, setSelfRunError] = useState<string | null>(null);
  const createSubmission = useCreateEngagementSubmission({
    mutation: {
      onSuccess: async (receipt) => {
        setSelfRunError(null);
        await queryClient.invalidateQueries({
          queryKey: getListEngagementSubmissionsQueryKey(engagementId),
        });
        setSelectedSubmissionId(receipt.submissionId);
      },
      onError: (err) => {
        setSelfRunError(
          err instanceof Error
            ? err.message
            : "Could not start self-run plan review.",
        );
      },
    },
  });
  const generate = useGenerateSubmissionFindings({
    mutation: {
      onSuccess: () => {
        if (!selectedSubmissionId) return;
        queryClient.invalidateQueries({
          queryKey: getListSubmissionFindingsQueryKey(selectedSubmissionId),
        });
        queryClient.invalidateQueries({
          queryKey: getGetSubmissionFindingsGenerationStatusQueryKey(
            selectedSubmissionId,
          ),
        });
        setRerunError(null);
      },
      onError: (err) => {
        setRerunError(describeRerunError(err));
      },
    },
  });
  const runState = statusQuery.data?.state ?? null;
  const isRunning = runState === "pending" || generate.isPending;
  const handleRerun = () => {
    if (!selectedSubmissionId || isRunning) return;
    if (runState === "completed" || runState === "failed") {
      const ok =
        typeof window === "undefined"
          ? true
          : window.confirm(
              "Re-run AI plan review? Prior runs are preserved.",
            );
      if (!ok) return;
    }
    setRerunError(null);
    generate.mutate({ submissionId: selectedSubmissionId, data: {} });
  };

  // Apply the active filter chips (Task #436) before handing the list
  // to FindingsList. The "X unaddressed of Y" counter above keeps
  // reading from the unfiltered list so the architect always sees
  // the submission's true size, even when the filters are narrow.
  const filteredFindings = useMemo<Finding[]>(() => {
    return findings.filter((f) => {
      if (severityFilter !== "all" && f.severity !== severityFilter) {
        return false;
      }
      if (categoryFilter !== "all" && f.category !== categoryFilter) {
        return false;
      }
      if (triageScope === "overridden" && f.status !== "overridden") {
        return false;
      }
      if (
        triageScope !== "overridden" &&
        !showAddressed &&
        f.status === "overridden"
      ) {
        return false;
      }
      return true;
    });
  }, [findings, severityFilter, categoryFilter, showAddressed, triageScope]);

  // Counts for the right-pane Findings Summary bars and tab badges.
  // Driven off the unfiltered list so summary numbers always reflect
  // the submission, not the active drill-down.
  const severityCounts = useMemo(() => {
    let blocker = 0;
    let concern = 0;
    let advisory = 0;
    let overridden = 0;
    for (const f of findings) {
      if (f.status === "overridden") overridden += 1;
      if (f.severity === "blocker") blocker += 1;
      else if (f.severity === "concern") concern += 1;
      else if (f.severity === "advisory") advisory += 1;
    }
    return {
      blocker,
      concern,
      advisory,
      overridden,
      open: findings.length - overridden,
      total: findings.length,
    };
  }, [findings]);

  // Auto-select the highest-severity row in the filtered list when it
  // resolves so the right pane is never blank if there is anything to
  // triage. Re-runs when the filter set changes — if the active row
  // gets filtered out we fall through to the next visible blocker.
  useEffect(() => {
    if (selectedFindingId !== null) {
      const stillVisible = filteredFindings.some(
        (f) => f.id === selectedFindingId,
      );
      if (stillVisible) return;
    }
    if (filteredFindings.length === 0) {
      if (selectedFindingId !== null) setSelectedFindingId(null);
      return;
    }
    const sorted = [...filteredFindings].sort((a, b) => {
      const order = { blocker: 0, concern: 1, advisory: 2 } as const;
      const delta = order[a.severity] - order[b.severity];
      if (delta !== 0) return delta;
      return Date.parse(a.aiGeneratedAt) - Date.parse(b.aiGeneratedAt);
    });
    setSelectedFindingId(sorted[0].id);
  }, [filteredFindings, selectedFindingId]);

  const selectedFinding =
    filteredFindings.find((f) => f.id === selectedFindingId) ?? null;
  const activeSubmission =
    sortedSubmissions.find((s) => s.id === selectedSubmissionId) ?? null;

  const overrideMutation = useOverrideFinding();
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const handleAddressWithRevision = (finding: Finding) => {
    setOverrideError(null);
    overrideMutation.mutate(
      {
        findingId: finding.id,
        data: {
          text: finding.text,
          severity: finding.severity,
          category: finding.category,
          reviewerComment: ADDRESS_WITH_NEXT_REVISION_REVIEWER_COMMENT,
        },
      },
      {
        onSuccess: () => {
          if (selectedSubmissionId) {
            queryClient.invalidateQueries({
              queryKey: getListSubmissionFindingsQueryKey(
                selectedSubmissionId,
              ),
            });
          }
        },
        onError: (err: unknown) => {
          if (err instanceof ApiError) {
            setOverrideError(err.message);
          } else if (err instanceof Error) {
            setOverrideError(err.message);
          } else {
            setOverrideError("Could not address finding. Try again.");
          }
        },
      },
    );
  };

  if (submissionsLoading) {
    return (
      <div className="sc-prose opacity-60" data-testid="findings-tab-loading">
        Loading submissions…
      </div>
    );
  }
  if (submissionsError) {
    return (
      <div
        className="alert-block warning"
        data-testid="findings-tab-error"
      >
        Could not load submissions for this engagement.
      </div>
    );
  }
  if (sortedSubmissions.length === 0) {
    const canSelfRun = Boolean(engagementJurisdiction?.trim());
    const selfRunBusy = createSubmission.isPending;
    return (
      <div className="cockpit-tab findings-triage-tab" data-testid="findings-tab">
        <TabHeader
          overline="Review"
          title="Findings"
          subtitle="Run a pre-submittal compliance review on this engagement without recording a jurisdiction submission."
        />
        <div
          className="sc-card p-6 flex flex-col gap-4"
          data-testid="findings-tab-empty-no-submissions"
        >
          <div className="sc-prose opacity-80">
            {canSelfRun ? (
              <p>
                Start a one-click AI plan review on the current model and site
                context. You can still{" "}
                <strong>Submit to jurisdiction</strong> from the header when
                ready for formal submittal.
              </p>
            ) : (
              <p>
                Add a project address (so jurisdiction resolves) before running
                a plan review. You can also{" "}
                <strong>Submit to jurisdiction</strong> once the address is set.
              </p>
            )}
          </div>
          {selfRunError ? (
            <p className="text-sm" style={{ color: "var(--danger-text)" }}>
              {selfRunError}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="sc-btn-primary"
              data-testid="findings-tab-self-run"
              disabled={!canSelfRun || selfRunBusy}
              onClick={() =>
                createSubmission.mutate({
                  id: engagementId,
                  data: {
                    note: "Pre-submittal self-review (architect-initiated)",
                    discipline: "building",
                  },
                })
              }
            >
              {selfRunBusy ? "Starting review…" : "Run plan review"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const rerunCtaLabel = isRunning
    ? "Running…"
    : runState
      ? "Re-run plan review"
      : "Run plan review";

  const submissionLabelShort = activeSubmission
    ? `#${activeSubmission.id.slice(-4).toUpperCase()}`
    : "—";
  const submissionStatusLabel = activeSubmission?.status
    ? activeSubmission.status.replace(/_/g, " ").toUpperCase()
    : null;

  return (
    <div className="cockpit-tab findings-triage-tab" data-testid="findings-tab">
      <TabHeader
        overline="Review"
        title="Triage Inbox"
        subtitle="Work open findings for the selected submission — filter, pick a row, read citations, and mark addressed for the next revision."
      />
      <div data-testid="findings-tab-body" className="findings-triage-shell">
        <div className="findings-triage-toolbar">
          <div className="findings-triage-toolbar-submission">
            <SubmissionSelector
              submissions={sortedSubmissions}
              value={selectedSubmissionId}
              testId="findings-tab-submission-picker"
              onChange={setSelectedSubmissionId}
            />
          </div>
          <div
            role="tablist"
            aria-label="Triage scope"
            data-testid="findings-tab-triage-scope"
            className="findings-triage-toolbar-tabs"
          >
            {TRIAGE_TAB_OPTIONS.map((opt) => {
              const active = triageScope === opt.id;
              const badge =
                opt.id === "open"
                  ? severityCounts.open
                  : opt.id === "all"
                    ? severityCounts.total
                    : severityCounts.overridden;
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-testid={`findings-tab-triage-scope-${opt.id}`}
                  data-active={active ? "true" : "false"}
                  onClick={() => handleTriageScopeChange(opt.id)}
                  style={{
                    background: "transparent",
                    border: "none",
                    borderBottom: active
                      ? "2px solid var(--cyan)"
                      : "2px solid transparent",
                    color: active ? "var(--cyan)" : "var(--text-secondary)",
                    padding: "2px 0 6px",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    fontSize: 11,
                    fontWeight: active ? 600 : 500,
                  }}
                >
                  {opt.label}
                  {findings.length > 0 ? ` (${badge})` : ""}
                </button>
              );
            })}
          </div>
          <div className="findings-triage-toolbar-actions">
            <button
              type="button"
              className="findings-triage-toolbar-toggle"
              data-active={filtersExpanded ? "true" : "false"}
              data-testid="findings-tab-filters-toggle"
              onClick={() => setFiltersExpanded((v) => !v)}
              aria-expanded={filtersExpanded}
            >
              <SlidersHorizontal size={12} aria-hidden />
              Filters
              {filtersExpanded ? (
                <ChevronDown size={12} aria-hidden />
              ) : (
                <ChevronRight size={12} aria-hidden />
              )}
            </button>
            <button
              type="button"
              className="findings-triage-toolbar-toggle"
              data-active={contextOpen ? "true" : "false"}
              data-testid="findings-tab-context-toggle"
              onClick={() => setContextOpen((v) => !v)}
              aria-expanded={contextOpen}
              title={contextOpen ? "Hide submission context" : "Show submission context"}
            >
              {contextOpen ? (
                <PanelRightClose size={12} aria-hidden />
              ) : (
                <PanelRightOpen size={12} aria-hidden />
              )}
              Context
            </button>
          </div>
        </div>

        {findings.length > 0 && (
          <div className="findings-triage-summary-strip" data-testid="findings-tab-summary-strip">
            <span className="findings-triage-summary-pill">
              <span
                className="findings-triage-summary-pill-dot"
                style={{ background: "var(--danger-text)" }}
                aria-hidden
              />
              {severityCounts.blocker} blocker
            </span>
            <span className="findings-triage-summary-pill">
              <span
                className="findings-triage-summary-pill-dot"
                style={{ background: "var(--warning-text)" }}
                aria-hidden
              />
              {severityCounts.concern} concern
            </span>
            <span className="findings-triage-summary-pill">
              <span
                className="findings-triage-summary-pill-dot"
                style={{ background: "var(--info-text, var(--cyan))" }}
                aria-hidden
              />
              {severityCounts.advisory} advisory
            </span>
            <span
              className="findings-triage-summary-pill"
              data-testid="findings-tab-unaddressed-count"
            >
              {countUnaddressedFindings(findings)} unaddressed of {findings.length}
            </span>
          </div>
        )}

        <div
          className="findings-triage-filters"
          data-collapsed={filtersExpanded ? "false" : "true"}
        >
          <FindingsFilterChips
            severityFilter={severityFilter}
            onSeverityChange={setSeverityFilter}
            categoryFilter={categoryFilter}
            onCategoryChange={setCategoryFilter}
            showAddressed={showAddressed}
            onShowAddressedChange={setShowAddressed}
          />
        </div>

        <div className="findings-triage-split">
          <div data-testid="findings-tab-inbox" className="findings-triage-inbox">
            <div className="findings-triage-inbox-scroll">
            {findingsLoading ? (
              <div
                className="sc-prose opacity-60 p-4"
                data-testid="findings-tab-list-loading"
              >
                Loading findings…
              </div>
            ) : findingsError ? (
              <div
                className="alert-block warning m-3"
                data-testid="findings-tab-list-error"
              >
                Could not load findings for this submission.
              </div>
            ) : findings.length === 0 ? (
              <div
                className="sc-prose opacity-60 p-4"
                data-testid="findings-tab-list-empty"
              >
                No findings on this submission.
              </div>
            ) : filteredFindings.length === 0 ? (
              <div
                className="sc-prose opacity-60 p-4"
                data-testid="findings-tab-list-filtered-empty"
              >
                No findings match the active filters.
              </div>
            ) : (
              <FindingsList
                findings={filteredFindings}
                selectedFindingId={selectedFindingId}
                onSelect={setSelectedFindingId}
              />
            )}
            </div>
          </div>

          <div className="findings-triage-detail">
            <FindingDetailPanel
              finding={selectedFinding}
              codeLibraryBase={codeLibraryBase}
              onAddressWithRevision={handleAddressWithRevision}
              isAddressing={overrideMutation.isPending}
              addressError={overrideError}
              onRetry={handleAddressWithRevision}
              onClose={() => setSelectedFindingId(null)}
              onElementRefClick={onElementRefClick}
              onCodeAtomClick={setCodeAtomModalId}
            />
          </div>

          <aside
            data-testid="findings-tab-submission-context"
            className="findings-triage-context"
            data-collapsed={contextOpen ? "false" : "true"}
          >
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span
              className="sc-label"
              style={{ fontSize: 9, opacity: 0.6 }}
            >
              ACTIVE SUBMISSION
            </span>
            <div
              style={{
                fontSize: 16,
                fontWeight: 600,
                color: "var(--text-primary)",
              }}
            >
              {submissionLabelShort}
            </div>
            {submissionStatusLabel && (
              <div
                data-testid="findings-tab-submission-status"
                style={{
                  marginTop: 4,
                  padding: "2px 8px",
                  borderRadius: 4,
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.04em",
                  width: "fit-content",
                  background: "var(--warning-dim, var(--cyan-dim))",
                  color: "var(--warning-text, var(--cyan-text))",
                  border:
                    "1px solid var(--warning-border, var(--cyan-accent-border))",
                }}
              >
                {submissionStatusLabel}
              </div>
            )}
            {activeSubmission?.submittedAt && (
              <div
                style={{
                  marginTop: 8,
                  fontSize: 11,
                  color: "var(--text-secondary)",
                  display: "flex",
                  justifyContent: "space-between",
                }}
              >
                <span style={{ opacity: 0.7 }}>Submitted</span>
                <span>{activeSubmission.submittedAt}</span>
              </div>
            )}
          </div>

          {/* Findings Summary bars */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <span
              className="sc-label"
              style={{ fontSize: 9, opacity: 0.6 }}
            >
              FINDINGS SUMMARY
            </span>
            <SummaryBar
              label="Blockers"
              count={severityCounts.blocker}
              total={Math.max(severityCounts.total, 1)}
              color="var(--danger-text)"
            />
            <SummaryBar
              label="Concerns"
              count={severityCounts.concern}
              total={Math.max(severityCounts.total, 1)}
              color="var(--warning-text)"
            />
            <SummaryBar
              label="Advisory"
              count={severityCounts.advisory}
              total={Math.max(severityCounts.total, 1)}
              color="var(--info-text, var(--cyan))"
            />
          </div>

          {/* Plan review controls */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span
              className="sc-label"
              style={{ fontSize: 9, opacity: 0.6 }}
            >
              PLAN REVIEW
            </span>
            <button
              type="button"
              className="sc-btn-primary"
              onClick={handleRerun}
              disabled={isRunning || !selectedSubmissionId}
              data-testid="findings-tab-rerun"
              style={{ width: "100%" }}
            >
              {rerunCtaLabel}
            </button>
            {isRunning && (
              <span
                data-testid="findings-tab-rerun-running-pill"
                style={{
                  background: "var(--info-dim)",
                  color: "var(--info-text)",
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                  padding: "2px 8px",
                  borderRadius: 999,
                  alignSelf: "flex-start",
                }}
              >
                Running
              </span>
            )}
            {rerunError && (
              <div
                role="alert"
                data-testid="findings-tab-rerun-error"
                className="sc-alert sc-alert-error"
              >
                {rerunError}
              </div>
            )}
            {runState === "failed" && !isRunning && (
              <div
                role="alert"
                data-testid="findings-tab-auto-failure-badge"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  padding: "8px 10px",
                  border:
                    "1px solid var(--danger-border, var(--danger-text))",
                  background: "var(--danger-dim)",
                  borderRadius: 6,
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: "var(--danger-text)",
                  }}
                >
                  AI plan review failed
                </div>
                <div
                  data-testid="findings-tab-auto-failure-detail"
                  style={{
                    fontSize: 11,
                    color: "var(--danger-text)",
                    wordBreak: "break-word",
                  }}
                >
                  {statusQuery.data?.error
                    ? `The most recent attempt failed: ${statusQuery.data.error}`
                    : "The most recent automatic attempt failed. Re-run to try again."}
                </div>
              </div>
            )}
          </div>
        </aside>
        </div>
      </div>
      {codeAtomModalId ? (
        <CodeAtomDetailModal
          atomId={codeAtomModalId}
          onClose={() => setCodeAtomModalId(null)}
          codeLibraryHref={`${codeLibraryBase}?atom=${encodeURIComponent(codeAtomModalId)}`}
        />
      ) : null}
    </div>
  );
}
