import { useState, type CSSProperties } from "react";
import { useLocation } from "wouter";
import { useEngagement } from "../../tile-shell/providers/EngagementProvider";
import { TileStatusBanner } from "../../tile-shell/components/TileStatusBanner";
import {
  useListEngagementSubmissions,
  useListSubmissionFindings,
  getListEngagementSubmissionsQueryKey,
  getListSubmissionFindingsQueryKey,
  useListEngagements,
} from "@workspace/api-client-react";
import {
  letterEligibleFindings,
  composeCommentLetterDraft,
} from "../../lib/commentLetter";
import { useDraftCommentLetter } from "../../lib/commentLetterApi";

const sectionStyle: CSSProperties = {
  padding: 10,
  borderRadius: 6,
  border: "1px solid var(--border-subtle)",
  background: "var(--bg-elevated)",
};

export default function LetterTile() {
  const { engagementId } = useEngagement();
  const [, navigate] = useLocation();
  const draftLetter = useDraftCommentLetter();
  const [error, setError] = useState<string | null>(null);

  const engagementsQuery = useListEngagements();
  const engagement =
    engagementsQuery.data?.find((e) => e.id === engagementId) ?? null;

  const submissionsQuery = useListEngagementSubmissions(engagementId ?? "", {
    query: {
      enabled: Boolean(engagementId),
      queryKey: getListEngagementSubmissionsQueryKey(engagementId ?? ""),
    },
  });
  const latestSubmission = submissionsQuery.data?.[0] ?? null;

  const findingsQuery = useListSubmissionFindings(latestSubmission?.id ?? "", {
    query: {
      enabled: Boolean(latestSubmission?.id),
      queryKey: getListSubmissionFindingsQueryKey(latestSubmission?.id ?? ""),
    },
  });
  const findings = findingsQuery.data?.findings ?? [];
  const letterEligible = letterEligibleFindings(findings);

  const composed =
    engagement && letterEligible.length > 0
      ? composeCommentLetterDraft({
          engagementName: engagement.name,
          jurisdiction: engagement.jurisdiction ?? null,
          submittedAt: latestSubmission?.submittedAt ?? null,
          findings,
        })
      : null;

  function handleDraft() {
    if (!engagementId || !engagement || !composed || letterEligible.length === 0) {
      return;
    }
    setError(null);
    draftLetter.mutate(
      { engagementId, draft: composed },
      {
        onSuccess: (letterId) => navigate(`/letter/${letterId}`),
        onError: () => setError("Could not draft letter."),
      },
    );
  }

  return (
    <div
      style={{
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        overflow: "auto",
        height: "100%",
      }}
    >
      <TileStatusBanner status="live" label="Deliverable Letter" />
      <p style={{ margin: 0, fontSize: 12, color: "var(--text-secondary)" }}>
        Draft a comment letter from accepted findings on the latest submission.
      </p>
      {!engagementId ? (
        <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
          Select a case from Intake & Queue first.
        </p>
      ) : null}
      <button
        type="button"
        data-testid="draft-comment-letter-button"
        disabled={!engagementId || letterEligible.length === 0 || draftLetter.isPending}
        onClick={handleDraft}
        style={{
          padding: "8px 14px",
          borderRadius: 6,
          border: "none",
          background: "var(--accent, var(--info-text))",
          color: "var(--accent-contrast, #fff)",
          fontSize: 12,
          fontWeight: 600,
          cursor: "pointer",
          alignSelf: "flex-start",
          opacity: letterEligible.length === 0 ? 0.5 : 1,
        }}
      >
        {draftLetter.isPending ? "Drafting…" : "Draft comment letter"}
      </button>
      {error ? (
        <div role="alert" style={{ fontSize: 12, color: "var(--danger-text)" }}>
          {error}
        </div>
      ) : null}
      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
        {letterEligible.length} finding{letterEligible.length === 1 ? "" : "s"} ready
      </span>
      {composed ? (
        <div
          data-testid="letter-sections-preview"
          style={{ display: "flex", flexDirection: "column", gap: 8 }}
        >
          {composed.sections.map((section, index) => (
            <article key={`${section.heading}-${index}`} style={sectionStyle}>
              <h4 style={{ margin: "0 0 6px", fontSize: 13 }}>{section.heading}</h4>
              <p
                style={{
                  margin: 0,
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  whiteSpace: "pre-wrap",
                }}
              >
                {section.content}
              </p>
            </article>
          ))}
        </div>
      ) : engagementId ? (
        <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
          No accepted findings on the latest submission yet.
        </p>
      ) : null}
    </div>
  );
}
