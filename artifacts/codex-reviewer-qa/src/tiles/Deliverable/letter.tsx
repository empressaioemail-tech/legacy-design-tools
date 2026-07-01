import { useState } from "react";
import { useLocation } from "wouter";
import { useEngagement } from "../../tile-shell/providers/EngagementProvider";
import { TileStatusBanner } from "../../tile-shell/components/TileStatusBanner";
import {
  useListEngagementSubmissions,
  useListSubmissionFindings,
  getListEngagementSubmissionsQueryKey,
  getListSubmissionFindingsQueryKey,
} from "@workspace/api-client-react";
import { letterEligibleFindings, composeCommentLetterDraft } from "../../lib/commentLetter";
import { useDraftCommentLetter } from "../../lib/commentLetterApi";
import { sortFindings } from "../../lib/findings";
import {
  useListEngagements,
} from "@workspace/api-client-react";

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
  const findings = sortFindings(findingsQuery.data?.findings ?? []);
  const letterEligible = letterEligibleFindings(findings);

  function handleDraft() {
    if (!engagementId || !engagement || letterEligible.length === 0) return;
    setError(null);
    const draft = composeCommentLetterDraft({
      engagementName: engagement.name,
      jurisdiction: engagement.jurisdiction ?? null,
      submittedAt: latestSubmission?.submittedAt ?? null,
      findings,
    });
    draftLetter.mutate(
      { engagementId, draft },
      {
        onSuccess: (letterId) => navigate(`/letter/${letterId}`),
        onError: () => setError("Could not draft letter."),
      },
    );
  }

  return (
    <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <TileStatusBanner status="live" label="Deliverable Letter" />
      <p style={{ margin: 0, fontSize: 12, color: "var(--text-secondary)" }}>
        Draft a comment letter from adjudicated findings on the latest submission.
      </p>
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
    </div>
  );
}
