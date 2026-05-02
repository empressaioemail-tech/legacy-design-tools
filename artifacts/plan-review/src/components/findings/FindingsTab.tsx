import { Fragment, useMemo, useState } from "react";
import {
  useListSubmissionFindings,
  useListSubmissionFindingsGenerationRuns,
  useGenerateSubmissionFindings,
  useFindingsGenerationPolling,
  useCreateSubmissionFinding,
  describeCreateFindingError,
  compareFindings,
  FINDING_CATEGORY_LABELS,
  FINDING_SEVERITY_LABELS,
  FINDING_STATUS_LABELS,
  SEVERITY_ORDER,
  useAcceptFinding,
  useRejectFinding,
  type Finding,
  type FindingCategory,
  type FindingSeverity,
  type FindingStatus,
} from "../../lib/findingsApi";
import { FindingsRunsPanel } from "./FindingsRunsPanel";
import { FindingDrillIn } from "./FindingDrillIn";
import { CodeAtomPill, renderFindingBody } from "./CodeAtomPill";
import { SEVERITY_PALETTE, STATUS_PALETTE } from "./severityStyles";
import { OverrideFindingModal } from "./OverrideFindingModal";
import { LowConfidencePill } from "@workspace/portal-ui";

export type FindingsTabAudience = "internal" | "user" | "ai";

const SEVERITY_FILTER_OPTIONS: FindingSeverity[] = ["blocker", "concern", "advisory"];
const STATUS_FILTER_OPTIONS: FindingStatus[] = [
  "ai-produced",
  "accepted",
  "rejected",
  "overridden",
];
const CATEGORY_FILTER_OPTIONS: FindingCategory[] = [
  "setback",
  "height",
  "coverage",
  "egress",
  "use",
  "overlay-conflict",
  "divergence-related",
  "other",
];

const SEVERITY_GROUP_ORDER: FindingSeverity[] = ["blocker", "concern", "advisory"];

export interface FindingsTabProps {
  submissionId: string;
  selectedFindingId: string | null;
  onSelectFinding: (id: string | null) => void;
  onShowInViewer?: (elementRef: string) => void;
  /** Only "internal" shows reviewer mutation affordances. */
  audience?: FindingsTabAudience;
}

export function FindingsTab({
  submissionId,
  selectedFindingId,
  onSelectFinding,
  onShowInViewer,
  audience = "user",
}: FindingsTabProps) {
  const isReviewer = audience === "internal";
  const findingsQuery = useListSubmissionFindings(submissionId);
  const findings = useMemo(
    () => (findingsQuery.data ?? []).slice().sort(compareFindings),
    [findingsQuery.data],
  );

  const [severityFilter, setSeverityFilter] = useState<Set<FindingSeverity>>(new Set());
  const [statusFilter, setStatusFilter] = useState<Set<FindingStatus>>(new Set());
  const [categoryFilter, setCategoryFilter] = useState<Set<FindingCategory>>(new Set());

  const visibleFindings = useMemo(() => {
    return findings.filter((f) => {
      if (severityFilter.size > 0 && !severityFilter.has(f.severity)) return false;
      if (statusFilter.size > 0 && !statusFilter.has(f.status)) return false;
      if (categoryFilter.size > 0 && !categoryFilter.has(f.category)) return false;
      return true;
    });
  }, [findings, severityFilter, statusFilter, categoryFilter]);

  const grouped = useMemo(() => {
    const map = new Map<FindingSeverity, Finding[]>();
    for (const sev of SEVERITY_GROUP_ORDER) map.set(sev, []);
    for (const f of visibleFindings) {
      map.get(f.severity)!.push(f);
    }
    return map;
  }, [visibleFindings]);

  const selectedFinding = useMemo(
    () => findings.find((f) => f.id === selectedFindingId) ?? null,
    [findings, selectedFindingId],
  );

  const hasAnyFindings = findings.length > 0;
  const hasVisibleFindings = visibleFindings.length > 0;
  const filterActive =
    severityFilter.size > 0 || statusFilter.size > 0 || categoryFilter.size > 0;

  return (
    <div
      data-testid="findings-tab"
      style={{
        display: "flex",
        flex: 1,
        minHeight: 0,
        height: "100%",
      }}
    >
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          padding: "14px 16px",
          overflow: "auto",
        }}
      >
        <FindingsAutoFailureBadge submissionId={submissionId} />

        <FindingsRunsPanel
          submissionId={submissionId}
          hasExistingFindings={hasAnyFindings}
          canTriggerGeneration={isReviewer}
        />

        {isReviewer && (
          <ManualAddFindingDisclosure submissionId={submissionId} />
        )}

        <div
          data-testid="findings-filters"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            fontSize: 12,
          }}
        >
          <FilterChipRow
            testidPrefix="findings-filter-severity"
            label="Severity"
            options={SEVERITY_FILTER_OPTIONS.map((s) => ({
              value: s,
              label: FINDING_SEVERITY_LABELS[s],
            }))}
            selected={severityFilter}
            onToggle={(v) =>
              setSeverityFilter((prev) => toggleSet(prev, v as FindingSeverity))
            }
            onClear={() => setSeverityFilter(new Set())}
          />
          <FilterChipRow
            testidPrefix="findings-filter-category"
            label="Category"
            options={CATEGORY_FILTER_OPTIONS.map((c) => ({
              value: c,
              label: FINDING_CATEGORY_LABELS[c],
            }))}
            selected={categoryFilter}
            onToggle={(v) =>
              setCategoryFilter((prev) => toggleSet(prev, v as FindingCategory))
            }
            onClear={() => setCategoryFilter(new Set())}
          />
          <FilterChipRow
            testidPrefix="findings-filter-status"
            label="Status"
            options={STATUS_FILTER_OPTIONS.map((s) => ({
              value: s,
              label: FINDING_STATUS_LABELS[s],
            }))}
            selected={statusFilter}
            onToggle={(v) =>
              setStatusFilter((prev) => toggleSet(prev, v as FindingStatus))
            }
            onClear={() => setStatusFilter(new Set())}
          />
          <span
            data-testid="findings-count"
            className="sc-meta opacity-70"
            style={{ marginLeft: "auto", fontSize: 11 }}
          >
            {visibleFindings.length} of {findings.length} shown
          </span>
        </div>

        {findingsQuery.isLoading && !hasAnyFindings && (
          <div
            data-testid="findings-loading"
            className="sc-body opacity-60"
            style={{ fontSize: 12 }}
          >
            Loading findings…
          </div>
        )}

        {!findingsQuery.isLoading && !hasAnyFindings && (
          <FindingsEmptyState
            submissionId={submissionId}
            isReviewer={isReviewer}
          />
        )}

        {hasAnyFindings && !hasVisibleFindings && (
          <div
            data-testid="findings-empty-filtered"
            className="sc-body opacity-70"
            style={{ fontSize: 12 }}
          >
            {filterActive
              ? "No findings match the current filters."
              : "No findings to display."}
          </div>
        )}

        {hasVisibleFindings &&
          SEVERITY_GROUP_ORDER.map((sev) => {
            const group = grouped.get(sev) ?? [];
            if (group.length === 0) return null;
            return (
              <FindingsSeverityGroup
                key={sev}
                severity={sev}
                findings={group}
                selectedFindingId={selectedFindingId}
                onSelect={onSelectFinding}
                isReviewer={isReviewer}
              />
            );
          })}
      </div>

      {selectedFinding && (
        <FindingDrillIn
          finding={selectedFinding}
          onClose={() => onSelectFinding(null)}
          onAfterMutate={(next) => {
            onSelectFinding(next.id);
          }}
          onShowInViewer={onShowInViewer}
          isReviewer={isReviewer}
        />
      )}
    </div>
  );
}

function toggleSet<T>(prev: Set<T>, value: T): Set<T> {
  const next = new Set(prev);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/**
 * Surfaces a distinct alert when the most recent generation run is
 * `failed` — typically produced by the auto-trigger that records
 * `finding_runs.state="failed"` on engine error but otherwise leaves
 * reviewers staring at "no findings yet" with no hint that the AI
 * tried and failed.
 *
 * The "Re-run AI plan review" action calls the same manual generate
 * endpoint reviewers use elsewhere (`useGenerateSubmissionFindings`)
 * so a successful retry clears the badge by inserting a new
 * `pending` → `completed` row at the head of the runs list.
 */
function FindingsAutoFailureBadge({ submissionId }: { submissionId: string }) {
  const runsQuery = useListSubmissionFindingsGenerationRuns(submissionId);
  const generate = useGenerateSubmissionFindings(submissionId);
  const live = useFindingsGenerationPolling(
    submissionId,
    generate.isPending || runsQuery.data?.runs?.[0]?.state === "pending",
  );
  const latestRun = runsQuery.data?.runs?.[0] ?? null;
  const isPending =
    generate.isPending || live?.state === "pending";
  if (!latestRun || latestRun.state !== "failed") return null;
  return (
    <div
      role="alert"
      data-testid="findings-auto-failure-badge"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        padding: "10px 12px",
        border: "1px solid var(--danger-border, var(--danger-text))",
        background: "var(--danger-dim)",
        borderRadius: 6,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--danger-text)",
          }}
        >
          AI plan review failed
        </div>
        <div
          data-testid="findings-auto-failure-detail"
          style={{
            fontSize: 12,
            color: "var(--danger-text)",
            marginTop: 2,
            wordBreak: "break-word",
          }}
        >
          {latestRun.error
            ? `The most recent attempt failed: ${latestRun.error}`
            : "The most recent automatic attempt failed. Re-run to try again."}
        </div>
      </div>
      <button
        type="button"
        className="sc-btn-primary"
        onClick={() => generate.mutate()}
        disabled={isPending}
        data-testid="findings-auto-failure-rerun"
      >
        {isPending ? "Re-running…" : "Re-run AI plan review"}
      </button>
    </div>
  );
}

function FindingsEmptyState({
  submissionId,
  isReviewer,
}: {
  submissionId: string;
  isReviewer: boolean;
}) {
  const generate = useGenerateSubmissionFindings(submissionId);
  const live = useFindingsGenerationPolling(submissionId, generate.isPending);
  const isPending = generate.isPending || live?.state === "pending";
  return (
    <div
      data-testid="findings-empty-state"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 10,
        padding: "36px 16px",
        border: "1px dashed var(--border-default)",
        borderRadius: 6,
        textAlign: "center",
      }}
    >
      <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
        No findings yet for this submission.
      </span>
      <span
        className="sc-meta"
        style={{ fontSize: 12, color: "var(--text-secondary)", maxWidth: 380 }}
      >
        {isReviewer
          ? "Generate AI compliance findings — the engine checks setback, height, coverage, egress, and other rules against the proposed design."
          : "The reviewer hasn't run AI compliance findings against this submission yet."}
      </span>
      {isReviewer && (
        <button
          type="button"
          className="sc-btn-primary"
          onClick={() => generate.mutate()}
          disabled={isPending}
          data-testid="findings-empty-generate"
          style={{ marginTop: 4 }}
        >
          {isPending ? "Generating…" : "Generate findings"}
        </button>
      )}
      <span
        className="sc-meta opacity-60"
        style={{ fontSize: 11, color: "var(--text-muted)" }}
      >
        Submission {submissionId}
      </span>
    </div>
  );
}

function FindingsSeverityGroup({
  severity,
  findings,
  selectedFindingId,
  onSelect,
  isReviewer,
}: {
  severity: FindingSeverity;
  findings: Finding[];
  selectedFindingId: string | null;
  onSelect: (id: string | null) => void;
  isReviewer: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const palette = SEVERITY_PALETTE[severity];
  return (
    <div
      data-testid={`findings-group-${severity}`}
      style={{
        border: "1px solid var(--border-subtle)",
        borderRadius: 6,
        background: "var(--surface-1, transparent)",
      }}
    >
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        data-testid={`findings-group-toggle-${severity}`}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 10px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span aria-hidden style={{ color: "var(--text-muted)" }}>
          {collapsed ? "▸" : "▾"}
        </span>
        <span
          style={{
            background: palette.bg,
            color: palette.fg,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            padding: "2px 8px",
            borderRadius: 999,
          }}
        >
          {FINDING_SEVERITY_LABELS[severity]}
        </span>
        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          {findings.length} {findings.length === 1 ? "finding" : "findings"}
        </span>
      </button>
      {!collapsed && (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {findings.map((f) => (
            <FindingRow
              key={f.id}
              finding={f}
              selected={f.id === selectedFindingId}
              onSelect={() => onSelect(f.id === selectedFindingId ? null : f.id)}
              isReviewer={isReviewer}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FindingRow({
  finding,
  selected,
  onSelect,
  isReviewer,
}: {
  finding: Finding;
  selected: boolean;
  onSelect: () => void;
  isReviewer: boolean;
}) {
  const [overrideOpen, setOverrideOpen] = useState(false);
  const accept = useAcceptFinding(finding.submissionId);
  const reject = useRejectFinding(finding.submissionId);
  const statusPalette = STATUS_PALETTE[finding.status];

  const truncated = useMemo(() => truncateText(finding.text, 180), [finding.text]);
  const codeCitationCount = finding.citations.filter(
    (c) => c.kind === "code-section",
  ).length;

  return (
    <div
      data-testid={`finding-row-${finding.id}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      aria-pressed={selected}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "10px 12px",
        borderTop: "1px solid var(--border-subtle)",
        cursor: "pointer",
        background: selected ? "var(--bg-input)" : "transparent",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            background: "var(--bg-default)",
            border: "1px solid var(--border-default)",
            color: "var(--text-secondary)",
            fontSize: 11,
            padding: "1px 6px",
            borderRadius: 3,
          }}
        >
          {FINDING_CATEGORY_LABELS[finding.category]}
        </span>
        <span
          data-testid={`finding-row-status-${finding.id}`}
          style={{
            background: statusPalette.bg,
            color: statusPalette.fg,
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            padding: "1px 6px",
            borderRadius: 999,
          }}
        >
          {FINDING_STATUS_LABELS[finding.status]}
        </span>
        {finding.lowConfidence && (
          <LowConfidencePill
            confidence={finding.confidence}
            testid={`finding-row-low-conf-${finding.id}`}
          />
        )}
        <span
          data-testid={`finding-row-citation-count-${finding.id}`}
          className="sc-meta opacity-70"
          style={{ marginLeft: "auto", fontSize: 11 }}
        >
          {codeCitationCount} {codeCitationCount === 1 ? "citation" : "citations"}
        </span>
      </div>
      <div
        data-testid={`finding-row-text-${finding.id}`}
        style={{
          fontSize: 13,
          color: "var(--text-primary)",
          lineHeight: 1.45,
        }}
      >
        {renderFindingBody(truncated).map((node, i) => (
          <Fragment key={i}>{node}</Fragment>
        ))}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        {finding.citations
          .filter((c): c is { kind: "code-section"; atomId: string } =>
            c.kind === "code-section",
          )
          .slice(0, 3)
          .map((c, i) => (
            <CodeAtomPill key={`${c.atomId}-${i}`} atomId={c.atomId} />
          ))}
        {isReviewer && (
          <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <button
              type="button"
              className="sc-btn-sm"
              onClick={(e) => {
                e.stopPropagation();
                accept.mutateAsync({ findingId: finding.id });
              }}
              disabled={accept.isPending || finding.status === "accepted"}
              data-testid={`finding-row-accept-${finding.id}`}
              style={{ fontSize: 11, padding: "2px 8px" }}
            >
              Accept
            </button>
            <button
              type="button"
              className="sc-btn-sm"
              onClick={(e) => {
                e.stopPropagation();
                reject.mutateAsync({ findingId: finding.id });
              }}
              disabled={reject.isPending || finding.status === "rejected"}
              data-testid={`finding-row-reject-${finding.id}`}
              style={{ fontSize: 11, padding: "2px 8px" }}
            >
              Reject
            </button>
            <button
              type="button"
              className="sc-btn-sm"
              onClick={(e) => {
                e.stopPropagation();
                setOverrideOpen(true);
              }}
              disabled={finding.status === "overridden"}
              data-testid={`finding-row-override-${finding.id}`}
              style={{ fontSize: 11, padding: "2px 8px" }}
            >
              Override
            </button>
          </div>
        )}
      </div>
      {overrideOpen && (
        <OverrideFindingModal
          finding={finding}
          onClose={() => setOverrideOpen(false)}
          onOverridden={() => setOverrideOpen(false)}
        />
      )}
    </div>
  );
}

function ManualAddFindingDisclosure({
  submissionId,
}: {
  submissionId: string;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [codeCitation, setCodeCitation] = useState("");
  const [elementRef, setElementRef] = useState("");
  const [severity, setSeverity] = useState<FindingSeverity>("concern");
  const [category, setCategory] = useState<FindingCategory>("other");
  const [error, setError] = useState<string | null>(null);
  const create = useCreateSubmissionFinding(submissionId);

  const reset = () => {
    setTitle("");
    setDescription("");
    setCodeCitation("");
    setElementRef("");
    setSeverity("concern");
    setCategory("other");
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("Title is required.");
      return;
    }
    try {
      const trimmedDesc = description.trim();
      const trimmedCode = codeCitation.trim();
      const trimmedElem = elementRef.trim();
      await create.mutateAsync({
        title: trimmedTitle,
        description: trimmedDesc.length > 0 ? trimmedDesc : null,
        severity,
        category,
        codeCitation: trimmedCode.length > 0 ? trimmedCode : null,
        elementRef: trimmedElem.length > 0 ? trimmedElem : null,
      });
      reset();
      setOpen(false);
    } catch (err) {
      setError(describeCreateFindingError(err));
    }
  };

  return (
    <div
      data-testid="findings-manual-add"
      style={{
        border: "1px solid var(--border-subtle)",
        borderRadius: 6,
        padding: "8px 12px",
        background: "var(--surface-1, transparent)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="findings-manual-add-toggle"
        style={{
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
          textAlign: "left",
          color: "var(--text-secondary)",
          fontSize: 12,
          alignSelf: "flex-start",
          fontWeight: 600,
        }}
      >
        {open ? "▾" : "▸"} Add finding manually
      </button>

      {open && (
        <form
          onSubmit={handleSubmit}
          style={{ display: "flex", flexDirection: "column", gap: 8 }}
        >
          <label className="flex flex-col" style={{ gap: 2 }}>
            <span className="sc-label" style={{ fontSize: 10 }}>
              TITLE
            </span>
            <input
              data-testid="findings-manual-add-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              placeholder="Short headline (required)."
              style={{
                background: "var(--bg-input)",
                border: "1px solid var(--border-default)",
                borderRadius: 4,
                padding: "4px 6px",
                fontSize: 12,
                color: "var(--text-primary)",
                fontFamily: "inherit",
              }}
            />
          </label>
          <label className="flex flex-col" style={{ gap: 2 }}>
            <span className="sc-label" style={{ fontSize: 10 }}>
              DESCRIPTION (OPTIONAL)
            </span>
            <textarea
              data-testid="findings-manual-add-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Add detail. Use [[CODE:section-id]] to cite a code section."
              style={{
                background: "var(--bg-input)",
                border: "1px solid var(--border-default)",
                borderRadius: 4,
                padding: 8,
                fontSize: 12,
                color: "var(--text-primary)",
                fontFamily: "inherit",
                resize: "vertical",
              }}
            />
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <label className="flex flex-col" style={{ gap: 2, flex: 1 }}>
              <span className="sc-label" style={{ fontSize: 10 }}>
                CODE CITATION (OPTIONAL)
              </span>
              <input
                data-testid="findings-manual-add-code-citation"
                type="text"
                value={codeCitation}
                onChange={(e) => setCodeCitation(e.target.value)}
                placeholder="e.g. code:zoning-19.3.2"
                style={{
                  background: "var(--bg-input)",
                  border: "1px solid var(--border-default)",
                  borderRadius: 4,
                  padding: "4px 6px",
                  fontSize: 12,
                  color: "var(--text-primary)",
                }}
              />
            </label>
            <label className="flex flex-col" style={{ gap: 2, flex: 1 }}>
              <span className="sc-label" style={{ fontSize: 10 }}>
                ELEMENT REF (OPTIONAL)
              </span>
              <input
                data-testid="findings-manual-add-element-ref"
                type="text"
                value={elementRef}
                onChange={(e) => setElementRef(e.target.value)}
                placeholder="e.g. wall:north-side-l2"
                style={{
                  background: "var(--bg-input)",
                  border: "1px solid var(--border-default)",
                  borderRadius: 4,
                  padding: "4px 6px",
                  fontSize: 12,
                  color: "var(--text-primary)",
                }}
              />
            </label>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <label className="flex flex-col" style={{ gap: 2, flex: 1 }}>
              <span className="sc-label" style={{ fontSize: 10 }}>
                SEVERITY
              </span>
              <select
                data-testid="findings-manual-add-severity"
                value={severity}
                onChange={(e) =>
                  setSeverity(e.target.value as FindingSeverity)
                }
                style={{
                  background: "var(--bg-input)",
                  border: "1px solid var(--border-default)",
                  borderRadius: 4,
                  padding: "4px 6px",
                  fontSize: 12,
                  color: "var(--text-primary)",
                }}
              >
                {SEVERITY_FILTER_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {FINDING_SEVERITY_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col" style={{ gap: 2, flex: 1 }}>
              <span className="sc-label" style={{ fontSize: 10 }}>
                CATEGORY
              </span>
              <select
                data-testid="findings-manual-add-category"
                value={category}
                onChange={(e) =>
                  setCategory(e.target.value as FindingCategory)
                }
                style={{
                  background: "var(--bg-input)",
                  border: "1px solid var(--border-default)",
                  borderRadius: 4,
                  padding: "4px 6px",
                  fontSize: 12,
                  color: "var(--text-primary)",
                }}
              >
                {CATEGORY_FILTER_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {FINDING_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {error && (
            <div
              role="alert"
              data-testid="findings-manual-add-error"
              style={{ fontSize: 11, color: "var(--danger-text)" }}
            >
              {error}
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
            <button
              type="button"
              className="sc-btn-ghost"
              onClick={() => {
                reset();
                setOpen(false);
              }}
              data-testid="findings-manual-add-cancel"
              style={{ fontSize: 11, padding: "2px 8px" }}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="sc-btn-primary"
              disabled={create.isPending}
              data-testid="findings-manual-add-submit"
              style={{ fontSize: 11, padding: "2px 8px" }}
            >
              {create.isPending ? "Adding…" : "Add finding"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function FilterChipRow({
  testidPrefix,
  label,
  options,
  selected,
  onToggle,
  onClear,
}: {
  testidPrefix: string;
  label: string;
  options: Array<{ value: string; label: string }>;
  selected: ReadonlySet<string>;
  onToggle: (v: string) => void;
  onClear: () => void;
}) {
  return (
    <div
      data-testid={testidPrefix}
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 6,
      }}
    >
      <span
        style={{
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          fontSize: 11,
          color: "var(--text-secondary)",
          marginRight: 4,
          minWidth: 64,
        }}
      >
        {label}
      </span>
      {options.map((o) => {
        const isOn = selected.has(o.value);
        return (
          <button
            key={o.value}
            type="button"
            data-testid={`${testidPrefix}-${o.value}`}
            aria-pressed={isOn}
            onClick={() => onToggle(o.value)}
            style={{
              fontSize: 11,
              padding: "2px 8px",
              borderRadius: 999,
              border: isOn
                ? "1px solid var(--border-active)"
                : "1px solid var(--border-default)",
              background: isOn ? "var(--bg-input)" : "transparent",
              color: isOn ? "var(--text-primary)" : "var(--text-secondary)",
              cursor: "pointer",
            }}
          >
            {o.label}
          </button>
        );
      })}
      {selected.size > 0 && (
        <button
          type="button"
          data-testid={`${testidPrefix}-clear`}
          onClick={onClear}
          style={{
            fontSize: 10,
            padding: "2px 6px",
            background: "transparent",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            textDecoration: "underline",
          }}
        >
          clear
        </button>
      )}
    </div>
  );
}

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max;
  const codeOpen = text.lastIndexOf("[[CODE:", cut);
  const codeClose = text.indexOf("]]", codeOpen);
  if (codeOpen !== -1 && codeClose !== -1 && codeClose >= cut) cut = codeClose + 2;
  const briefingOpen = text.lastIndexOf("{{atom|", cut);
  const briefingClose = text.indexOf("}}", briefingOpen);
  if (briefingOpen !== -1 && briefingClose !== -1 && briefingClose >= cut)
    cut = briefingClose + 2;
  return `${text.slice(0, cut).trimEnd()}…`;
}

export { SEVERITY_ORDER };
