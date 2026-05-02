import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateEngagementReviewerRequest,
  getListEngagementReviewerRequestsQueryKey,
  getListMyReviewerRequestsQueryKey,
  getGetAtomHistoryQueryKey,
  ApiError,
  type ReviewerRequestKind,
  type ReviewerRequestTargetType,
  type ReviewerRequest,
} from "@workspace/api-client-react";

/**
 * Wave 2 Sprint D / V1-2 — reviewer-side dialog for filing a
 * reviewer-request against a target atom on an engagement.
 *
 * Modeled on `SubmitToJurisdictionDialog`: free-text reason capture,
 * cancel / submit buttons, inline error surface, click-outside-to-
 * close semantics, character-count gate.
 *
 * Posts via the generated `useCreateEngagementReviewerRequest` hook
 * (the route validates the `(requestKind, targetEntityType)`
 * pairing server-side per the kind-to-target-type contract).
 *
 * Reviewer-only by deployment context — the parent only mounts
 * this dialog under `audience === "internal"` paths. The dialog
 * itself does not re-check audience because the route would 403
 * anyway and the shared portal-ui surface stays audience-agnostic.
 */
export interface RequestRefreshDialogProps {
  engagementId: string;
  /**
   * The atom-action kind the reviewer is requesting. Drives the
   * dialog title, the route's emitted event type, and the row's
   * `request_kind` column.
   */
  requestKind: ReviewerRequestKind;
  targetEntityType: ReviewerRequestTargetType;
  /**
   * The atom id the request is filed against. For briefing-source
   * targets this is the briefing-source row UUID the reviewer was
   * looking at when they triggered the affordance — anchoring the
   * request on the pre-refresh row id is what lets the implicit-
   * resolve hook close it on the architect's force-refresh action.
   */
  targetEntityId: string;
  /**
   * Short human-readable label for the target — surfaced inside
   * the dialog body so the reviewer can confirm "yes, this row".
   * The dialog does not parse / validate this; it's purely UX.
   */
  targetLabel: string;
  isOpen: boolean;
  onClose: () => void;
  /**
   * Fires after a successful create, just before `onClose` runs.
   * Parent uses this to surface a transient confirmation pill
   * (mirrors the `SubmitToJurisdictionDialog.onSubmitted` shape).
   */
  onCreated?: (request: ReviewerRequest) => void;
}

const REQUEST_KIND_LABEL: Record<ReviewerRequestKind, string> = {
  "refresh-briefing-source": "Request layer refresh",
  "refresh-bim-model": "Request BIM model refresh",
  "regenerate-briefing": "Request briefing regeneration",
};

const REQUEST_KIND_PLACEHOLDER: Record<ReviewerRequestKind, string> = {
  "refresh-briefing-source":
    'e.g. "Source PDF appears outdated — please refresh."',
  "refresh-bim-model":
    'e.g. "Model is misaligned with the latest briefing."',
  "regenerate-briefing":
    'e.g. "Inputs changed since this briefing was last generated."',
};

const REASON_MAX_CHARS = 4096;

export function RequestRefreshDialog({
  engagementId,
  requestKind,
  targetEntityType,
  targetEntityId,
  targetLabel,
  isOpen,
  onClose,
  onCreated,
}: RequestRefreshDialogProps) {
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setReason("");
      setError(null);
    }
  }, [isOpen]);

  const mutation = useCreateEngagementReviewerRequest({
    mutation: {
      onSuccess: async (response) => {
        // The architect-strip query (?status=pending) keys off the
        // engagement; invalidating with no status in the queryKey
        // hits every variant the architect might have cached.
        await Promise.all([
          qc.invalidateQueries({
            queryKey: getListEngagementReviewerRequestsQueryKey(engagementId),
          }),
          // Surface the just-emitted .requested event on the
          // engagement's atom-history timeline if the architect is
          // viewing it concurrently.
          qc.invalidateQueries({
            queryKey: getGetAtomHistoryQueryKey("engagement", engagementId),
          }),
          // Refresh the cross-engagement reviewer queue (Outstanding
          // Requests page + sidebar pending-count badge) so the
          // newly-filed row appears without a manual reload. Passing
          // the bare key (no params) matches every cached `?status=`
          // variant the reviewer might have warmed.
          qc.invalidateQueries({
            queryKey: getListMyReviewerRequestsQueryKey(),
          }),
        ]);
        onCreated?.(response.request);
        onClose();
      },
      onError: (err) => {
        setError(formatRequestError(err));
      },
    },
  });

  if (!isOpen) return null;

  const trimmed = reason.trim();
  const overLimit = reason.length > REASON_MAX_CHARS;
  const empty = trimmed.length === 0;
  const submitting = mutation.isPending;

  const handleSubmit = () => {
    if (empty || overLimit || submitting) return;
    setError(null);
    mutation.mutate({
      id: engagementId,
      data: {
        requestKind,
        targetEntityType,
        targetEntityId,
        reason: trimmed,
      },
    });
  };

  return (
    <div
      onClick={() => {
        if (!submitting) onClose();
      }}
      data-testid="request-refresh-dialog"
      data-request-kind={requestKind}
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
              {REQUEST_KIND_LABEL[requestKind]}
            </span>
            <span className="sc-meta opacity-70">
              File a request asking the architect to refresh{" "}
              <strong style={{ color: "var(--text-primary)" }}>
                {targetLabel}
              </strong>
              . The architect will see your request on the engagement
              and either honor it (by running the action) or dismiss
              it with a reason.
            </span>
          </div>
        </div>

        <div className="p-4 flex flex-col" style={{ gap: 12 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span
              className="sc-label"
              style={{ color: "var(--text-secondary)" }}
            >
              Reason (required)
            </span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={submitting}
              rows={5}
              placeholder={REQUEST_KIND_PLACEHOLDER[requestKind]}
              data-testid="request-refresh-reason"
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
                The architect sees your reason verbatim — be specific
                about what changed.
              </span>
              <span data-testid="request-refresh-reason-count">
                {reason.length} / {REASON_MAX_CHARS}
              </span>
            </div>
          </label>

          {error && (
            <div
              data-testid="request-refresh-error"
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
            data-testid="request-refresh-confirm"
          >
            {submitting ? "Sending…" : "Send request"}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatRequestError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) {
      return "This engagement no longer exists. Refresh and try again.";
    }
    if (err.status === 400) {
      const detail = extractApiDetail(err);
      const fallback = `Reason may be too long (max ${REASON_MAX_CHARS} chars) or otherwise invalid.`;
      return detail ?? fallback;
    }
    if (err.status === 403) {
      return "Only reviewers can file refresh requests.";
    }
    if (err.status >= 500) {
      return "The server hit a snag recording this request. Try again in a moment.";
    }
    return extractApiDetail(err) ?? err.message;
  }
  if (err instanceof Error) return err.message;
  return "Failed to send request — please try again.";
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
