import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useDismissReviewerRequest,
  getListEngagementReviewerRequestsQueryKey,
  getGetAtomHistoryQueryKey,
  ApiError,
  type ReviewerRequest,
} from "@workspace/api-client-react";

/**
 * Wave 2 Sprint D / V1-2 — architect-side dialog for dismissing a
 * pending reviewer-request with a reason.
 *
 * Modeled on `RequestRefreshDialog` (the reviewer-side companion):
 * free-text reason capture, cancel / dismiss buttons, inline error
 * surface, click-outside-to-close semantics, character-count gate.
 *
 * Posts via the generated `useDismissReviewerRequest` hook. The
 * route is idempotent on already-dismissed rows and 409s on already-
 * resolved rows; the dialog surfaces both as inline errors.
 */
export interface DismissReviewerRequestDialogProps {
  request: ReviewerRequest;
  isOpen: boolean;
  onClose: () => void;
  /**
   * Fires after a successful dismiss, just before `onClose` runs.
   * Parent uses this to flash a transient confirmation pill on the
   * strip.
   */
  onDismissed?: (request: ReviewerRequest) => void;
}

const DISMISSAL_REASON_MAX_CHARS = 4096;

const REQUEST_KIND_SHORT_LABEL: Record<
  ReviewerRequest["requestKind"],
  string
> = {
  "refresh-briefing-source": "refresh briefing source",
  "refresh-bim-model": "refresh BIM model",
  "regenerate-briefing": "regenerate briefing",
};

export function DismissReviewerRequestDialog({
  request,
  isOpen,
  onClose,
  onDismissed,
}: DismissReviewerRequestDialogProps) {
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setReason("");
      setError(null);
    }
  }, [isOpen, request.id]);

  const mutation = useDismissReviewerRequest({
    mutation: {
      onSuccess: async (response) => {
        await Promise.all([
          qc.invalidateQueries({
            queryKey: getListEngagementReviewerRequestsQueryKey(
              request.engagementId,
            ),
          }),
          qc.invalidateQueries({
            queryKey: getGetAtomHistoryQueryKey(
              "engagement",
              request.engagementId,
            ),
          }),
        ]);
        onDismissed?.(response.request);
        onClose();
      },
      onError: (err) => {
        setError(formatDismissError(err));
      },
    },
  });

  if (!isOpen) return null;

  const trimmed = reason.trim();
  const overLimit = reason.length > DISMISSAL_REASON_MAX_CHARS;
  const empty = trimmed.length === 0;
  const submitting = mutation.isPending;

  const handleSubmit = () => {
    if (empty || overLimit || submitting) return;
    setError(null);
    mutation.mutate({
      id: request.id,
      data: { dismissalReason: trimmed },
    });
  };

  return (
    <div
      onClick={() => {
        if (!submitting) onClose();
      }}
      data-testid="dismiss-reviewer-request-dialog"
      data-request-id={request.id}
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
          maxWidth: 480,
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
              Dismiss request
            </span>
            <span className="sc-meta opacity-70">
              The reviewer asked you to{" "}
              <strong style={{ color: "var(--text-primary)" }}>
                {REQUEST_KIND_SHORT_LABEL[request.requestKind]}
              </strong>
              . Tell them why you're not honoring this — your reason
              is preserved on the engagement timeline alongside the
              dismissal event.
            </span>
          </div>
        </div>

        <div className="p-4 flex flex-col" style={{ gap: 12 }}>
          <div
            className="sc-meta"
            data-testid="dismiss-reviewer-request-original-reason"
            style={{
              padding: 8,
              borderRadius: 4,
              background: "var(--bg-input)",
              color: "var(--text-muted)",
              fontStyle: "italic",
              whiteSpace: "pre-wrap",
            }}
          >
            <strong style={{ color: "var(--text-secondary)" }}>
              Reviewer wrote:
            </strong>{" "}
            {request.reason}
          </div>

          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span
              className="sc-label"
              style={{ color: "var(--text-secondary)" }}
            >
              Dismissal reason (required)
            </span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={submitting}
              rows={5}
              placeholder='e.g. "Source is current — verified upstream feed at 2026-04-30."'
              data-testid="dismiss-reviewer-request-reason"
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
                The reviewer sees your dismissal reason verbatim.
              </span>
              <span data-testid="dismiss-reviewer-request-reason-count">
                {reason.length} / {DISMISSAL_REASON_MAX_CHARS}
              </span>
            </div>
          </label>

          {error && (
            <div
              data-testid="dismiss-reviewer-request-error"
              role="alert"
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
            disabled={submitting || empty || overLimit}
            data-testid="dismiss-reviewer-request-confirm"
          >
            {submitting ? "Dismissing…" : "Dismiss request"}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatDismissError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) {
      return "This request no longer exists. Refresh and try again.";
    }
    if (err.status === 409) {
      return "This request was already resolved by a domain action — there's nothing to dismiss.";
    }
    if (err.status === 400) {
      const detail = extractApiDetail(err);
      const fallback = `Reason may be too long (max ${DISMISSAL_REASON_MAX_CHARS} chars) or otherwise invalid.`;
      return detail ?? fallback;
    }
    if (err.status === 403) {
      return "Only architects can dismiss reviewer requests.";
    }
    if (err.status >= 500) {
      return "The server hit a snag dismissing this request. Try again in a moment.";
    }
    return extractApiDetail(err) ?? err.message;
  }
  if (err instanceof Error) return err.message;
  return "Failed to dismiss — please try again.";
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
