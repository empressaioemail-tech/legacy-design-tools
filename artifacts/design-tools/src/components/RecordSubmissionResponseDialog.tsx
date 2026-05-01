import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useRecordSubmissionResponse,
  getGetEngagementQueryKey,
  getGetAtomHistoryQueryKey,
  getListEngagementSubmissionsQueryKey,
  RecordSubmissionResponseBodyStatus,
  type RecordSubmissionResponseBodyStatus as StatusValue,
  type SubmissionResponse,
} from "@workspace/api-client-react";
import { recordSubmissionResponseBodyReviewerCommentMax } from "@workspace/api-zod";
import { ApiError } from "@workspace/api-client-react";

export interface RecordSubmissionResponseDialogProps {
  engagementId: string;
  submissionId: string;
  jurisdiction: string | null;
  isOpen: boolean;
  onClose: () => void;
  /**
   * Fires after a successful response, just before `onClose` runs.
   * The parent uses this to surface the recorded status + comment
   * inline on the matching submission row so the user sees the row
   * update without waiting for a list refetch (the underlying
   * `EngagementSubmissionSummary` does not yet carry status / comment;
   * surfacing those columns in the listing is the sister task
   * "Show jurisdiction response status and comment on the engagement
   * page", and once it lands the local-state mirror collapses to
   * dead weight that we can remove without touching this dialog).
   */
  onRecorded?: (response: SubmissionResponse) => void;
}

const STATUS_OPTIONS: ReadonlyArray<{
  value: StatusValue;
  label: string;
  description: string;
}> = [
  {
    value: RecordSubmissionResponseBodyStatus.approved,
    label: "Approved",
    description: "Jurisdiction accepted the package as-is.",
  },
  {
    value: RecordSubmissionResponseBodyStatus.corrections_requested,
    label: "Corrections requested",
    description: "Reviewer asked for changes before approving.",
  },
  {
    value: RecordSubmissionResponseBodyStatus.rejected,
    label: "Rejected",
    description: "Submission was declined outright.",
  },
];

export function RecordSubmissionResponseDialog({
  engagementId,
  submissionId,
  jurisdiction,
  isOpen,
  onClose,
  onRecorded,
}: RecordSubmissionResponseDialogProps) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<StatusValue>(
    RecordSubmissionResponseBodyStatus.approved,
  );
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Reset form whenever the dialog re-opens so the previous submission's
  // draft doesn't leak into the next one. Mirrors SubmitToJurisdictionDialog.
  useEffect(() => {
    if (isOpen) {
      setStatus(RecordSubmissionResponseBodyStatus.approved);
      setComment("");
      setError(null);
    }
  }, [isOpen]);

  const mutation = useRecordSubmissionResponse({
    mutation: {
      onSuccess: async (response) => {
        await Promise.all([
          // The engagement detail header / status pill reads from the
          // engagement query — bust it so any derived "latest response"
          // surface refreshes alongside the row.
          qc.invalidateQueries({
            queryKey: getGetEngagementQueryKey(engagementId),
          }),
          // The engagement timeline is driven by the atom history;
          // the response route appends a `submission.response-recorded`
          // event scoped to the submission, but the engagement-scoped
          // history view aggregates events for the page so we bust
          // both keys to guarantee a refresh.
          qc.invalidateQueries({
            queryKey: getGetAtomHistoryQueryKey("engagement", engagementId),
          }),
          qc.invalidateQueries({
            queryKey: getGetAtomHistoryQueryKey("submission", submissionId),
          }),
          // The past-submissions list is what the SubmissionsTab renders;
          // invalidate it so the row reflects the recorded response as
          // soon as the listing endpoint surfaces status / comment.
          qc.invalidateQueries({
            queryKey: getListEngagementSubmissionsQueryKey(engagementId),
          }),
        ]);
        onRecorded?.(response);
        onClose();
      },
      onError: (err) => {
        setError(formatRecordError(err));
      },
    },
  });

  if (!isOpen) return null;

  const trimmed = comment.trim();
  const overLimit =
    comment.length > recordSubmissionResponseBodyReviewerCommentMax;
  const submitting = mutation.isPending;

  const handleSubmit = () => {
    if (overLimit || submitting) return;
    setError(null);
    mutation.mutate({
      id: engagementId,
      submissionId,
      data:
        trimmed.length > 0
          ? { status, reviewerComment: trimmed }
          : { status },
    });
  };

  return (
    <div
      onClick={() => {
        if (!submitting) onClose();
      }}
      data-testid="record-response-dialog"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        className="sc-card"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 520,
          maxHeight: "90vh",
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div className="sc-card-header">
          <div className="flex flex-col gap-1">
            <span
              style={{
                fontSize: 16,
                fontWeight: 600,
                color: "var(--text-primary)",
              }}
            >
              Record jurisdiction response
            </span>
            <span className="sc-meta opacity-70">
              Capture the reply
              {jurisdiction ? ` from ${jurisdiction}` : ""} for this
              submission. The status and comment will appear on the
              submission row and the engagement timeline.
            </span>
          </div>
        </div>

        <div className="p-4 flex flex-col" style={{ gap: 14 }}>
          <fieldset
            disabled={submitting}
            style={{
              border: "none",
              padding: 0,
              margin: 0,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <legend
              className="sc-label"
              style={{ color: "var(--text-secondary)" }}
            >
              Outcome
            </legend>
            {STATUS_OPTIONS.map((opt) => {
              const checked = status === opt.value;
              return (
                <label
                  key={opt.value}
                  className="sc-card-row"
                  data-testid={`record-response-status-${opt.value}`}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 10,
                    padding: "8px 10px",
                    border: `1px solid ${
                      checked
                        ? "var(--cyan)"
                        : "var(--border-default)"
                    }`,
                    borderRadius: 4,
                    background: checked
                      ? "rgba(0,180,216,0.08)"
                      : "transparent",
                    cursor: submitting ? "not-allowed" : "pointer",
                  }}
                >
                  <input
                    type="radio"
                    name="record-response-status"
                    value={opt.value}
                    checked={checked}
                    onChange={() => setStatus(opt.value)}
                    style={{ marginTop: 3 }}
                  />
                  <span style={{ display: "flex", flexDirection: "column" }}>
                    <span
                      className="sc-medium"
                      style={{
                        color: "var(--text-primary)",
                        fontSize: 13,
                      }}
                    >
                      {opt.label}
                    </span>
                    <span
                      className="sc-meta"
                      style={{
                        color: "var(--text-secondary)",
                        fontSize: 11.5,
                      }}
                    >
                      {opt.description}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>

          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span
              className="sc-label"
              style={{ color: "var(--text-secondary)" }}
            >
              Reviewer comment (optional)
            </span>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              disabled={submitting}
              rows={5}
              placeholder='e.g. "Update egress widths on A2.04 and resubmit."'
              data-testid="record-response-comment"
              className="sc-ui sc-scroll"
              style={{
                width: "100%",
                background: "var(--bg-input)",
                border: `1px solid ${
                  overLimit ? "#ef4444" : "var(--border-default)"
                }`,
                color: "var(--text-primary)",
                padding: "8px 10px",
                borderRadius: 4,
                outline: "none",
                fontSize: 12.5,
                resize: "vertical",
                minHeight: 90,
              }}
            />
            <div
              className="sc-meta"
              style={{
                display: "flex",
                justifyContent: "space-between",
                color: overLimit ? "#ef4444" : "var(--text-muted)",
              }}
            >
              <span>
                Comments appear verbatim on the engagement timeline (max 4
                KB).
              </span>
              <span data-testid="record-response-comment-count">
                {comment.length} /{" "}
                {recordSubmissionResponseBodyReviewerCommentMax}
              </span>
            </div>
          </label>

          {error && (
            <div
              data-testid="record-response-error"
              className="sc-meta"
              style={{ color: "#ef4444" }}
            >
              {error}
            </div>
          )}
        </div>

        <div
          className="p-4 flex justify-end gap-2"
          style={{ borderTop: "1px solid var(--border-default)" }}
        >
          <button
            type="button"
            className="sc-btn-ghost"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="sc-btn-primary"
            onClick={handleSubmit}
            disabled={submitting || overLimit}
            data-testid="record-response-confirm"
          >
            {submitting ? "Recording…" : "Record response"}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatRecordError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) {
      return "This submission no longer exists. Refresh and try again.";
    }
    if (err.status === 400) {
      const detail = extractApiDetail(err);
      // The API returns a specific 400 when the path's engagement id
      // doesn't own the submission — surface it verbatim so the user
      // understands they're looking at a stale row from another
      // engagement, not a content-validation problem.
      if (detail) return detail;
      return `Comment may be too long (max ${recordSubmissionResponseBodyReviewerCommentMax} chars) or otherwise invalid.`;
    }
    if (err.status >= 500) {
      return "The server hit a snag recording this response. Try again in a moment.";
    }
    return extractApiDetail(err) ?? err.message;
  }
  if (err instanceof Error) return err.message;
  return "Failed to record response — please try again.";
}

function extractApiDetail(err: ApiError<unknown>): string | null {
  const data = err.data;
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const key of ["detail", "message", "title", "error"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
  }
  if (typeof data === "string" && data.trim().length > 0) {
    return data.trim();
  }
  return null;
}
