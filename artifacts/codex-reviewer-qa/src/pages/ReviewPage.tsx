/**
 * Codex Reviewer QA — CDX-3 one-click AI review pass.
 *
 * Pick an engagement and one of its submissions, trigger an engine
 * compliance full-pass, and render the findings it produces. Consumes
 * cortex-api's in-process L-surface via the generated
 * `@workspace/api-client-react` client — the same path `plan-review`
 * and `design-tools` use, not the MCP server.
 *
 * Flow: POST /submissions/{id}/findings/generate (202 + pending run)
 * → poll GET .../findings/status until state leaves "pending"
 * → GET .../findings renders the result as FindingCards.
 *
 * CDX-4 (per-finding accept/edit/reject) and CDX-5 (jurisdiction
 * switcher) are the sequenced follow-on PRs; this page is CDX-3 only.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  generateSubmissionFindings,
  getGetSubmissionFindingsGenerationStatusQueryKey,
  getListEngagementSubmissionsQueryKey,
  getListSubmissionFindingsQueryKey,
  useGetSubmissionFindingsGenerationStatus,
  useListEngagements,
  useListEngagementSubmissions,
  useListSubmissionFindings,
} from "@workspace/api-client-react";
import { FindingCard } from "../components/FindingCard";
import { sortFindings } from "../lib/findings";
import {
  describeOverrideError,
  useAcceptFinding,
  useOverrideFinding,
  useRejectFinding,
} from "../lib/reviewApi";

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const labelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--text-muted)",
};

const selectStyle: CSSProperties = {
  minWidth: 220,
  padding: "6px 8px",
  borderRadius: 6,
  border: "1px solid var(--border-subtle)",
  background: "var(--bg-input, var(--bg-elevated))",
  color: "var(--text-primary)",
  fontSize: 13,
};

export default function ReviewPage() {
  const queryClient = useQueryClient();
  const [engagementId, setEngagementId] = useState("");
  const [submissionId, setSubmissionId] = useState("");

  const engagementsQuery = useListEngagements();
  const engagements = engagementsQuery.data ?? [];

  const submissionsQuery = useListEngagementSubmissions(engagementId, {
    query: {
      queryKey: getListEngagementSubmissionsQueryKey(engagementId),
      enabled: engagementId !== "",
    },
  });
  const submissions = submissionsQuery.data ?? [];

  const statusQuery = useGetSubmissionFindingsGenerationStatus(submissionId, {
    query: {
      queryKey: getGetSubmissionFindingsGenerationStatusQueryKey(submissionId),
      enabled: submissionId !== "",
      // Poll while the engine run is in flight; stop once it settles.
      refetchInterval: (query) =>
        query.state.data?.state === "pending" ? 2_000 : false,
    },
  });
  const status = statusQuery.data ?? null;
  const isGenerating = status?.state === "pending";

  const findingsQuery = useListSubmissionFindings(submissionId, {
    query: {
      queryKey: getListSubmissionFindingsQueryKey(submissionId),
      enabled: submissionId !== "",
    },
  });
  const findings = sortFindings(findingsQuery.data?.findings ?? []);

  // When a run transitions out of "pending", pull the fresh findings —
  // the generate route is fire-and-forget (202 + pending), so the rows
  // only exist once the engine has finished writing them.
  const lastStateRef = useRef<string | null>(null);
  useEffect(() => {
    const current = status?.state ?? null;
    if (
      lastStateRef.current === "pending" &&
      (current === "completed" || current === "failed")
    ) {
      void queryClient.invalidateQueries({
        queryKey: getListSubmissionFindingsQueryKey(submissionId),
      });
    }
    lastStateRef.current = current;
  }, [status?.state, submissionId, queryClient]);

  const runMutation = useMutation({
    mutationFn: () => generateSubmissionFindings(submissionId, {}),
    onSuccess: () => {
      // Re-arm the status poll so it observes the new pending run.
      void queryClient.invalidateQueries({
        queryKey:
          getGetSubmissionFindingsGenerationStatusQueryKey(submissionId),
      });
    },
  });

  const canRun = submissionId !== "" && !isGenerating && !runMutation.isPending;

  // CDX-4 — per-finding adjudication. One mutation each; the active
  // finding is identified by the mutation's in-flight `variables`.
  const acceptMutation = useAcceptFinding(submissionId);
  const rejectMutation = useRejectFinding(submissionId);
  const overrideMutation = useOverrideFinding(submissionId);

  function findingBusy(findingId: string): boolean {
    return (
      (acceptMutation.isPending && acceptMutation.variables === findingId) ||
      (rejectMutation.isPending && rejectMutation.variables === findingId) ||
      (overrideMutation.isPending &&
        overrideMutation.variables?.findingId === findingId)
    );
  }

  function findingOverrideError(findingId: string): string | null {
    if (
      overrideMutation.isError &&
      overrideMutation.variables?.findingId === findingId
    ) {
      return describeOverrideError(overrideMutation.error);
    }
    return null;
  }

  function handleEngagementChange(next: string) {
    setEngagementId(next);
    setSubmissionId("");
  }

  return (
    <main
      style={{
        maxWidth: 880,
        margin: "0 auto",
        padding: 24,
        display: "flex",
        flexDirection: "column",
        gap: 20,
      }}
    >
      <header>
        <h1 style={{ fontSize: 24, margin: 0 }}>Codex Reviewer QA</h1>
        <p
          style={{
            margin: "4px 0 0",
            color: "var(--text-secondary)",
            fontSize: 13,
          }}
        >
          One-click AI review pass (CDX-3). Pick a submission, run the
          engine compliance pass, and review every finding it produces.
        </p>
      </header>

      <section
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          alignItems: "flex-end",
        }}
      >
        <label style={fieldStyle}>
          <span style={labelStyle}>Engagement</span>
          <select
            data-testid="engagement-select"
            value={engagementId}
            onChange={(e) => handleEngagementChange(e.target.value)}
            style={selectStyle}
          >
            <option value="">
              {engagementsQuery.isLoading
                ? "Loading…"
                : "Select an engagement"}
            </option>
            {engagements.map((engagement) => (
              <option key={engagement.id} value={engagement.id}>
                {engagement.name}
              </option>
            ))}
          </select>
        </label>

        <label style={fieldStyle}>
          <span style={labelStyle}>Submission</span>
          <select
            data-testid="submission-select"
            value={submissionId}
            onChange={(e) => setSubmissionId(e.target.value)}
            disabled={engagementId === ""}
            style={selectStyle}
          >
            <option value="">
              {engagementId === ""
                ? "Pick an engagement first"
                : submissionsQuery.isLoading
                  ? "Loading…"
                  : submissions.length === 0
                    ? "No submissions on this engagement"
                    : "Select a submission"}
            </option>
            {submissions.map((submission) => (
              <option key={submission.id} value={submission.id}>
                {new Date(submission.submittedAt).toLocaleDateString()} ·{" "}
                {submission.status}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          data-testid="run-review-button"
          onClick={() => runMutation.mutate()}
          disabled={!canRun}
          style={{
            padding: "8px 16px",
            borderRadius: 6,
            border: "none",
            background: "var(--accent, var(--info-text))",
            color: "var(--accent-contrast, #fff)",
            fontSize: 13,
            fontWeight: 600,
            cursor: canRun ? "pointer" : "not-allowed",
            opacity: canRun ? 1 : 0.5,
          }}
        >
          {isGenerating || runMutation.isPending ? "Running…" : "Run review"}
        </button>
      </section>

      {runMutation.isError ? (
        <div
          role="alert"
          data-testid="run-error"
          style={{
            fontSize: 13,
            padding: 10,
            borderRadius: 6,
            background: "var(--danger-dim)",
            color: "var(--danger-text)",
          }}
        >
          Could not start the review run. Try again.
        </div>
      ) : null}

      {submissionId !== "" && status ? (
        <RunStatusBanner
          state={status.state}
          error={status.error}
          invalidCitationCount={status.invalidCitationCount}
          discardedFindingCount={status.discardedFindingCount}
        />
      ) : null}

      <section
        data-testid="findings-section"
        style={{ display: "flex", flexDirection: "column", gap: 12 }}
      >
        {submissionId === "" ? (
          <Placeholder text="Select a submission to load its findings." />
        ) : findingsQuery.isLoading ? (
          <Placeholder text="Loading findings…" />
        ) : findings.length === 0 ? (
          <Placeholder
            text={
              isGenerating
                ? "The engine is running — findings will appear here when it finishes."
                : "No findings yet. Run a review to generate them."
            }
          />
        ) : (
          <>
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "var(--text-secondary)",
              }}
            >
              {findings.length} finding{findings.length === 1 ? "" : "s"}
            </div>
            <div
              data-testid="findings-list"
              style={{ display: "flex", flexDirection: "column", gap: 12 }}
            >
              {findings.map((finding) => (
                <FindingCard
                  key={finding.id}
                  finding={finding}
                  onAccept={(id) => acceptMutation.mutate(id)}
                  onReject={(id) => rejectMutation.mutate(id)}
                  onOverride={(id, draft) =>
                    overrideMutation.mutate({ findingId: id, draft })
                  }
                  busy={findingBusy(finding.id)}
                  overrideError={findingOverrideError(finding.id)}
                />
              ))}
            </div>
          </>
        )}
      </section>
    </main>
  );
}

/** Compact run-outcome banner — the QA-relevant engine signal. */
function RunStatusBanner({
  state,
  error,
  invalidCitationCount,
  discardedFindingCount,
}: {
  state: string;
  error: string | null;
  invalidCitationCount: number | null;
  discardedFindingCount: number | null;
}) {
  if (state === "idle") return null;

  let tone = "var(--info-dim)";
  let toneText = "var(--info-text)";
  let message: string;
  if (state === "pending") {
    message = "Engine run in progress…";
  } else if (state === "failed") {
    tone = "var(--danger-dim)";
    toneText = "var(--danger-text)";
    message = `Last run failed${error ? `: ${error}` : "."}`;
  } else {
    // completed — surface the QA-relevant engine quality signals.
    const notes: string[] = [];
    if (invalidCitationCount && invalidCitationCount > 0) {
      notes.push(`${invalidCitationCount} invalid citation(s) stripped`);
    }
    if (discardedFindingCount && discardedFindingCount > 0) {
      notes.push(`${discardedFindingCount} finding(s) discarded`);
    }
    message =
      notes.length > 0
        ? `Last run completed — ${notes.join(", ")}.`
        : "Last run completed cleanly.";
  }

  return (
    <div
      data-testid="run-status"
      role="status"
      style={{
        fontSize: 12,
        padding: "8px 10px",
        borderRadius: 6,
        background: tone,
        color: toneText,
      }}
    >
      {message}
    </div>
  );
}

function Placeholder({ text }: { text: string }) {
  return (
    <div
      data-testid="findings-placeholder"
      style={{
        fontSize: 13,
        color: "var(--text-muted)",
        padding: 16,
        border: "1px dashed var(--border-subtle)",
        borderRadius: 8,
        textAlign: "center",
      }}
    >
      {text}
    </div>
  );
}
