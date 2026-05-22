/**
 * Codex Reviewer QA — the engine review surface (CDX-3 / CDX-4 / CDX-5).
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
 * CDX-3 — the one-click pass + findings render.
 * CDX-4 — per-finding accept / edit / reject, wired into each card.
 * CDX-5 — the engagement/submission switcher: jurisdiction follows the
 *   engagement (no runtime override), surfaced by the JurisdictionBar.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  generateSubmissionFindings,
  getGetSubmissionFindingsGenerationStatusQueryKey,
  getListEngagementSubmissionsQueryKey,
  getListSubmissionFindingsQueryKey,
  useGetSubmissionFindingsGenerationStatus,
  useListCodeJurisdictions,
  useListEngagements,
  useListEngagementSubmissions,
  useListSubmissionFindings,
} from "@workspace/api-client-react";
import { FindingCard } from "../components/FindingCard";
import { JurisdictionBar } from "../components/JurisdictionBar";
import { sortFindings } from "../lib/findings";
import {
  describeOverrideError,
  useAcceptFinding,
  useOverrideFinding,
  useRejectFinding,
} from "../lib/reviewApi";
import {
  composeCommentLetterDraft,
  letterEligibleFindings,
} from "../lib/commentLetter";
import { useDraftCommentLetter } from "../lib/commentLetterApi";

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

  // CDX-5 — jurisdiction follows the engagement (planner ruling
  // 2026-05-21); there is no runtime override. The corpus list is
  // global; the JurisdictionBar matches the engagement's recorded
  // jurisdiction against it for read-only context.
  const jurisdictionsQuery = useListCodeJurisdictions();
  const jurisdictions = jurisdictionsQuery.data ?? [];

  const selectedEngagement =
    engagements.find((engagement) => engagement.id === engagementId) ?? null;
  const selectedSubmission =
    submissions.find((submission) => submission.id === submissionId) ?? null;

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

  // CDX-9 — comment-letter auto-draft. The accepted + edited findings
  // for this submission compose a Cortex L3 `deliverable-letter`; the
  // draft persists through the existing L3 endpoints and the reviewer
  // is routed to the letter view to edit / render it.
  const [, navigate] = useLocation();
  const draftLetter = useDraftCommentLetter();
  const letterEligible = letterEligibleFindings(findings);
  const canDraftLetter = letterEligible.length > 0 && !draftLetter.isPending;

  function handleDraftLetter() {
    if (!selectedEngagement || letterEligible.length === 0) return;
    const draft = composeCommentLetterDraft({
      engagementName: selectedEngagement.name,
      jurisdiction: selectedEngagement.jurisdiction ?? null,
      submittedAt: selectedSubmission?.submittedAt ?? null,
      findings,
    });
    draftLetter.mutate(
      { engagementId, draft },
      { onSuccess: (letterId) => navigate(`/letter/${letterId}`) },
    );
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
          Pick an engagement and submission, run the engine compliance
          pass, and adjudicate every finding against the engagement&rsquo;s
          jurisdiction.
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
                {engagement.jurisdiction
                  ? `${engagement.name} — ${engagement.jurisdiction}`
                  : engagement.name}
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

      {/* CDX-5 — the jurisdiction the engagement (and so the engine
          pass) is judged against; updates as the engagement switches. */}
      <JurisdictionBar
        engagement={selectedEngagement}
        submission={selectedSubmission}
        jurisdictions={jurisdictions}
        corpusLoading={jurisdictionsQuery.isLoading}
      />

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
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: "var(--text-secondary)",
                  flex: 1,
                }}
              >
                {findings.length} finding{findings.length === 1 ? "" : "s"}
                {letterEligible.length > 0
                  ? ` · ${letterEligible.length} adjudicated for the letter`
                  : ""}
              </span>
              {/* CDX-9 — draft a comment letter from the accepted +
                  edited findings. Disabled until at least one finding
                  is adjudicated (accept or edit). */}
              <button
                type="button"
                data-testid="draft-comment-letter-button"
                onClick={handleDraftLetter}
                disabled={!canDraftLetter}
                title={
                  letterEligible.length === 0
                    ? "Accept or edit at least one finding to draft a comment letter"
                    : undefined
                }
                style={{
                  padding: "6px 14px",
                  borderRadius: 6,
                  border: "1px solid var(--border-subtle)",
                  background: "var(--accent, var(--info-text))",
                  color: "var(--accent-contrast, #fff)",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: canDraftLetter ? "pointer" : "not-allowed",
                  opacity: canDraftLetter ? 1 : 0.5,
                }}
              >
                {draftLetter.isPending
                  ? "Drafting…"
                  : "Draft comment letter"}
              </button>
            </div>

            {draftLetter.isError ? (
              <div
                role="alert"
                data-testid="draft-comment-letter-error"
                style={{
                  fontSize: 12,
                  padding: "8px 10px",
                  borderRadius: 6,
                  background: "var(--danger-dim)",
                  color: "var(--danger-text)",
                }}
              >
                Could not draft the comment letter. Try again.
              </div>
            ) : null}

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
