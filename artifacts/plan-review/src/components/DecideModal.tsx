/**
 * DecideModal — PLR-6 / Task #460.
 *
 * Reviewer Decide surface launched from the three-button submission
 * detail header. Renders the three verdict options
 * (`approve`, `approve_with_conditions`, `return_for_revision`) plus
 * an optional comment field. Submitting calls
 * `POST /submissions/:submissionId/decisions` and, on success,
 * invalidates the cached engagement-submissions list so the row's
 * status / reviewer-comment update reflects without a manual refresh.
 *
 * Reviewer-only — the parent gates rendering on
 * `audience === "internal"`. The Decide button on the action header
 * is always visible (its pill carries the latest verdict label) but
 * the modal is mounted only for reviewers; non-reviewer audiences
 * fall back to the legacy "switch to Decision tab" path inside
 * `SubmissionDetailModal`.
 */

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  useRecordDecision,
  getListEngagementSubmissionsQueryKey,
  getListSubmissionDecisionsQueryKey,
  type EngagementSubmissionSummary,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

/**
 * Single source of truth for the verdict tuple on the FE side. Mirrors
 * the api-server `DECISION_VERDICT_VALUES` constant; both sides are
 * also gated by the OpenAPI enum on the wire.
 */
const VERDICT_OPTIONS: ReadonlyArray<{
  value: "approve" | "approve_with_conditions" | "return_for_revision";
  label: string;
  description: string;
}> = [
  {
    value: "approve",
    label: "Approve",
    description:
      "Accept the submission as-is. The submission status moves to Approved.",
  },
  {
    value: "approve_with_conditions",
    label: "Approve with conditions",
    description:
      "Accept the submission with the comment recorded as the conditions. Status moves to Approved; the comment surfaces on the row.",
  },
  {
    value: "return_for_revision",
    label: "Return for revision",
    description:
      "Send the submission back for revision. Status moves to Corrections requested.",
  },
];

export interface DecideModalProps {
  submission: EngagementSubmissionSummary;
  /**
   * Engagement that owns the submission. Threaded explicitly because
   * `EngagementSubmissionSummary` does not surface its parent
   * engagement id on the wire — the parent (`OpenSubmissionModalRenderer`)
   * already has it from the URL path.
   */
  engagementId: string;
  open: boolean;
  onClose: () => void;
}

export function DecideModal({
  submission,
  engagementId,
  open,
  onClose,
}: DecideModalProps) {
  const queryClient = useQueryClient();
  const [verdict, setVerdict] = useState<
    "approve" | "approve_with_conditions" | "return_for_revision"
  >("approve");
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useRecordDecision({
    mutation: {
      onSuccess: async () => {
        // Refetch the engagement-submissions list so the row's pill
        // reflects the new status / reviewer-comment, and the
        // per-submission decisions list so the audit trail catches up
        // (the latter is a no-op when no DecisionTab is mounted).
        await queryClient.invalidateQueries({
          queryKey: getListEngagementSubmissionsQueryKey(engagementId),
        });
        await queryClient.invalidateQueries({
          queryKey: getListSubmissionDecisionsQueryKey(submission.id),
        });
        setComment("");
        setVerdict("approve");
        setError(null);
        onClose();
      },
      onError: (err: unknown) => {
        const message =
          err instanceof Error ? err.message : "Failed to record decision";
        setError(message);
      },
    },
  });

  const handleSubmit = () => {
    setError(null);
    const trimmed = comment.trim();
    mutation.mutate({
      submissionId: submission.id,
      data: {
        verdict,
        ...(trimmed.length > 0 ? { comment: trimmed } : {}),
      },
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        data-testid="decide-modal"
        className="max-w-lg"
      >
        <DialogHeader>
          <DialogTitle data-testid="decide-modal-title">
            Record verdict
          </DialogTitle>
          <DialogDescription data-testid="decide-modal-subtitle">
            Choose a verdict for this submission. The submission row’s
            status updates immediately and the verdict is appended to the
            decision audit trail.
          </DialogDescription>
        </DialogHeader>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
            padding: "8px 0",
          }}
        >
          <fieldset
            data-testid="decide-modal-verdict-fieldset"
            style={{
              border: "none",
              padding: 0,
              margin: 0,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <legend className="sc-label">Verdict</legend>
            {VERDICT_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                data-testid={`decide-modal-verdict-${opt.value}`}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  padding: 8,
                  borderRadius: 6,
                  border:
                    verdict === opt.value
                      ? "1px solid var(--accent)"
                      : "1px solid var(--border-default)",
                  cursor: "pointer",
                }}
              >
                <input
                  type="radio"
                  name="decide-modal-verdict"
                  value={opt.value}
                  checked={verdict === opt.value}
                  onChange={() => setVerdict(opt.value)}
                  data-testid={`decide-modal-verdict-${opt.value}-input`}
                />
                <span style={{ display: "flex", flexDirection: "column" }}>
                  <span className="sc-medium">{opt.label}</span>
                  <span
                    className="sc-meta"
                    style={{ color: "var(--text-secondary)", fontSize: 12 }}
                  >
                    {opt.description}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <label
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            <span className="sc-label">Comment (optional)</span>
            <textarea
              data-testid="decide-modal-comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              maxLength={4096}
              rows={4}
              style={{
                width: "100%",
                padding: 8,
                border: "1px solid var(--border-default)",
                borderRadius: 6,
                fontFamily: "inherit",
                fontSize: 13,
                background: "var(--surface-default)",
                color: "var(--text-primary)",
              }}
            />
          </label>
          {error && (
            <div
              data-testid="decide-modal-error"
              style={{ color: "var(--danger-text)", fontSize: 12 }}
            >
              {error}
            </div>
          )}
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
            }}
          >
            <button
              type="button"
              data-testid="decide-modal-cancel"
              className="sc-btn-secondary"
              onClick={() => {
                setError(null);
                onClose();
              }}
              disabled={mutation.isPending}
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="decide-modal-submit"
              className="sc-btn-primary"
              onClick={handleSubmit}
              disabled={mutation.isPending}
            >
              {mutation.isPending ? "Recording…" : "Record verdict"}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
