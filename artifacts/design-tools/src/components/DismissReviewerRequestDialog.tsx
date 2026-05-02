import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useDismissReviewerRequest,
  getListEngagementReviewerRequestsQueryKey,
  getGetAtomHistoryQueryKey,
  ApiError,
  type ReviewerRequest,
  type ListReviewerRequestsResponse,
} from "@workspace/api-client-react";
import { formatActorLabel } from "@workspace/portal-ui";
import { relativeTime } from "../lib/relativeTime";

/**
 * Architect-side dialog for dismissing a pending reviewer-request
 * with a reason. Posts via `useDismissReviewerRequest`, applies an
 * optimistic cache update with rollback on error, and surfaces server
 * errors inline.
 */
export interface DismissReviewerRequestDialogProps {
  request: ReviewerRequest;
  isOpen: boolean;
  onClose: () => void;
  /**
   * Fires synchronously inside the mutation's `onMutate`, BEFORE the
   * optimistic cache removal. The parent strip uses this to record
   * the row as user-dismissed so its implicit-resolve diff doesn't
   * misclassify the optimistic shrink as a backend resolve.
   */
  onDismissStarted?: (request: ReviewerRequest) => void;
  /**
   * Fires after a successful dismiss, just before `onClose` runs.
   * Parent uses this to flash the "Request dismissed" pill.
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

interface OptimisticContext {
  queryKey: readonly unknown[];
  previous: ListReviewerRequestsResponse | undefined;
}

export function DismissReviewerRequestDialog({
  request,
  isOpen,
  onClose,
  onDismissStarted,
  onDismissed,
}: DismissReviewerRequestDialogProps) {
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      setReason("");
      setError(null);
    }
  }, [isOpen, request.id]);

  // Auto-focus the reason textarea when the dialog opens so the
  // architect can start typing immediately. Defers a frame so the
  // node is mounted by the time we call `.focus()`.
  useEffect(() => {
    if (!isOpen) return;
    const id = requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [isOpen, request.id]);

  const mutation = useDismissReviewerRequest({
    mutation: {
      // Optimistically remove the row from the pending-list cache.
      // We mark the row as user-dismissed via `onDismissStarted`
      // BEFORE the cache write so the strip's implicit-resolve diff
      // (which runs on the next render after the cache change) sees
      // the mark and doesn't misclassify this shrink as a backend
      // resolve.
      onMutate: async (): Promise<OptimisticContext> => {
        const queryKey = getListEngagementReviewerRequestsQueryKey(
          request.engagementId,
          { status: "pending" },
        );
        await qc.cancelQueries({ queryKey });
        const previous = qc.getQueryData<ListReviewerRequestsResponse>(
          queryKey,
        );
        onDismissStarted?.(request);
        if (previous) {
          qc.setQueryData<ListReviewerRequestsResponse>(queryKey, {
            ...previous,
            requests: previous.requests.filter((r) => r.id !== request.id),
          });
        }
        return { queryKey, previous };
      },
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
      onError: (err, _vars, context) => {
        // Roll the optimistic write back so the strip restores the
        // row before the user sees the inline error.
        const ctx = context as OptimisticContext | undefined;
        if (ctx?.queryKey && ctx.previous !== undefined) {
          qc.setQueryData(ctx.queryKey, ctx.previous);
        }
        setError(formatDismissError(err));
      },
    },
  });

  // Esc-to-close — guard against closing mid-flight so a slow network
  // doesn't strand the architect with a half-applied optimistic
  // update they can't see the error from.
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (mutation.isPending) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose, mutation.isPending]);

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
      role="dialog"
      aria-modal="true"
      aria-labelledby="dismiss-reviewer-request-title"
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
              id="dismiss-reviewer-request-title"
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
            data-testid="dismiss-reviewer-request-summary"
            style={{
              padding: 8,
              borderRadius: 4,
              background: "var(--bg-input)",
              color: "var(--text-muted)",
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            <span
              data-testid="dismiss-reviewer-request-requester"
              style={{ fontSize: 11, color: "var(--text-muted)" }}
            >
              <strong style={{ color: "var(--text-secondary)" }}>
                {formatActorLabel({
                  kind: request.requestedBy.kind,
                  id: request.requestedBy.id,
                  displayName:
                    request.requestedBy.displayName ?? undefined,
                })}
              </strong>{" "}
              · {relativeTime(request.requestedAt)}
            </span>
            <span
              data-testid="dismiss-reviewer-request-original-reason"
              style={{
                fontStyle: "italic",
                whiteSpace: "pre-wrap",
              }}
            >
              <strong style={{ color: "var(--text-secondary)" }}>
                Reviewer wrote:
              </strong>{" "}
              {request.reason}
            </span>
          </div>

          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span
              className="sc-label"
              style={{ color: "var(--text-secondary)" }}
            >
              Dismissal reason (required)
            </span>
            <textarea
              ref={textareaRef}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={submitting}
              rows={5}
              placeholder='e.g. "Source is current — verified upstream feed at 2026-04-30."'
              data-testid="dismiss-reviewer-request-reason"
              className="sc-ui sc-scroll"
              aria-invalid={overLimit || undefined}
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
