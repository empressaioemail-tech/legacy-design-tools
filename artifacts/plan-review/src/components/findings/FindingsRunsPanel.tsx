import { useEffect, useMemo, useState } from "react";
import {
  useGenerateSubmissionFindings,
  useListSubmissionFindingsGenerationRuns,
  useFindingsGenerationPolling,
  type FindingRun,
} from "../../lib/findingsApi";

const RUN_STATE_LABELS: Record<FindingRun["state"], string> = {
  pending: "Generating",
  completed: "Completed",
  failed: "Failed",
};

const RUN_STATE_PALETTE: Record<
  FindingRun["state"],
  { bg: string; fg: string }
> = {
  pending: { bg: "var(--info-dim)", fg: "var(--info-text)" },
  completed: { bg: "var(--success-dim)", fg: "var(--success-text)" },
  failed: { bg: "var(--danger-dim)", fg: "var(--danger-text)" },
};

export interface FindingsRunsPanelProps {
  submissionId: string;
  /** Whether any findings already exist for this submission. */
  hasExistingFindings: boolean;
  confirmFn?: (msg: string) => boolean;
  canTriggerGeneration?: boolean;
}

export function FindingsRunsPanel({
  submissionId,
  hasExistingFindings,
  confirmFn,
  canTriggerGeneration = true,
}: FindingsRunsPanelProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generate = useGenerateSubmissionFindings(submissionId);
  const runsQuery = useListSubmissionFindingsGenerationRuns(submissionId, {
    query: { enabled: open },
  });
  const runs = runsQuery.data?.runs ?? [];

  // Live polling for a pending run — the mock setTimeout is short
  // (~400ms) so this just keeps the pill in sync with the
  // store-side state transition without introducing visible lag.
  const live = useFindingsGenerationPolling(
    submissionId,
    generate.isPending || (runs[0]?.state === "pending"),
  );
  const isPending = generate.isPending || live?.state === "pending";

  const ctaLabel = useMemo(() => {
    if (isPending) return "Generating…";
    return hasExistingFindings ? "Regenerate findings" : "Generate findings";
  }, [hasExistingFindings, isPending]);

  // Auto-clear stale errors when a new generation starts.
  useEffect(() => {
    if (generate.isPending) setError(null);
  }, [generate.isPending]);

  const handleGenerate = async () => {
    if (hasExistingFindings) {
      const confirmFnImpl =
        confirmFn ??
        ((msg) => (typeof window === "undefined" ? true : window.confirm(msg)));
      const ok = confirmFnImpl(
        "Regenerate findings? Prior runs are preserved on the run record so this is non-destructive.",
      );
      if (!ok) return;
    }
    setError(null);
    try {
      await generate.mutateAsync();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    }
  };

  return (
    <div
      data-testid="findings-runs-panel"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        border: "1px solid var(--border-subtle)",
        borderRadius: 6,
        padding: "10px 12px",
        background: "var(--surface-1, transparent)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            AI compliance findings
          </span>
          {isPending && (
            <span
              data-testid="findings-runs-pending-pill"
              style={{
                background: RUN_STATE_PALETTE.pending.bg,
                color: RUN_STATE_PALETTE.pending.fg,
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                padding: "2px 8px",
                borderRadius: 999,
              }}
            >
              Running
            </span>
          )}
        </div>
        {canTriggerGeneration && (
          <button
            type="button"
            className="sc-btn-primary"
            onClick={handleGenerate}
            disabled={isPending}
            data-testid="findings-runs-generate"
          >
            {ctaLabel}
          </button>
        )}
      </div>

      {error && (
        <div
          role="alert"
          data-testid="findings-runs-error"
          style={{ fontSize: 12, color: "var(--danger-text)" }}
        >
          {error}
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="findings-runs-toggle"
        style={{
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
          textAlign: "left",
          color: "var(--text-secondary)",
          fontSize: 11,
          alignSelf: "flex-start",
        }}
      >
        {open ? "▾" : "▸"} Recent runs ({runs.length})
      </button>

      {open && (
        <div
          data-testid="findings-runs-list"
          style={{ display: "flex", flexDirection: "column", gap: 4 }}
        >
          {runsQuery.isLoading && (
            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
              Loading recent runs…
            </div>
          )}
          {!runsQuery.isLoading && runs.length === 0 && (
            <div
              data-testid="findings-runs-empty"
              style={{ fontSize: 11, color: "var(--text-muted)" }}
            >
              No generation runs recorded yet.
            </div>
          )}
          {runs.map((run) => (
            <RunRow key={run.generationId} run={run} />
          ))}
        </div>
      )}
    </div>
  );
}

function RunRow({ run }: { run: FindingRun }) {
  const [expanded, setExpanded] = useState(false);
  const palette = RUN_STATE_PALETTE[run.state];
  return (
    <div
      data-testid={`findings-run-${run.generationId}`}
      style={{
        border: "1px solid var(--border-subtle)",
        borderRadius: 4,
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        data-testid={`findings-run-toggle-${run.generationId}`}
        style={{
          width: "100%",
          background: "transparent",
          border: "none",
          padding: "6px 8px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 11,
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <span
          style={{
            background: palette.bg,
            color: palette.fg,
            padding: "1px 6px",
            borderRadius: 3,
            fontWeight: 600,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
          }}
        >
          {RUN_STATE_LABELS[run.state]}
        </span>
        <span style={{ flex: 1, color: "var(--text-default)" }}>
          {new Date(run.startedAt).toLocaleString()}
        </span>
        <span aria-hidden style={{ color: "var(--text-muted)" }}>
          {expanded ? "▾" : "▸"}
        </span>
      </button>
      {expanded && (
        <div
          data-testid={`findings-run-details-${run.generationId}`}
          style={{
            padding: "0 8px 8px 8px",
            fontSize: 11,
            color: "var(--text-muted)",
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <div>
            Completed:{" "}
            {run.completedAt
              ? new Date(run.completedAt).toLocaleString()
              : "—"}
          </div>
          <div>Invalid citations: {run.invalidCitationCount}</div>
          <div>Discarded findings: {run.discardedFindingCount}</div>
          {run.error && (
            <div style={{ color: "var(--danger-text)" }}>
              Error: {run.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
