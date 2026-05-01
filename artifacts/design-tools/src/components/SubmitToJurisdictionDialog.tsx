import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateEngagementSubmission,
  getGetEngagementQueryKey,
  getGetAtomHistoryQueryKey,
  getListEngagementSubmissionsQueryKey,
  type SubmissionReceipt,
} from "@workspace/api-client-react";
import { createEngagementSubmissionBodyNoteMax } from "@workspace/api-zod";
import { ApiError } from "@workspace/api-client-react";

export interface SubmitToJurisdictionDialogProps {
  engagementId: string;
  engagementName: string;
  jurisdiction: string | null;
  isOpen: boolean;
  onClose: () => void;
  /**
   * Fires after a successful submission, just before `onClose` runs.
   * The parent uses this to surface a non-blocking confirmation
   * (e.g. inline banner above the engagement header) that includes
   * the recorded `submittedAt` timestamp from the server. Errors
   * still surface inside the dialog via the existing `onError`
   * branch and never reach this callback.
   */
  onSubmitted?: (receipt: SubmissionReceipt) => void;
}

export function SubmitToJurisdictionDialog({
  engagementId,
  engagementName,
  jurisdiction,
  isOpen,
  onClose,
  onSubmitted,
}: SubmitToJurisdictionDialogProps) {
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setNote("");
      setError(null);
    }
  }, [isOpen]);

  const mutation = useCreateEngagementSubmission({
    mutation: {
      onSuccess: async (receipt) => {
        await Promise.all([
          qc.invalidateQueries({
            queryKey: getGetEngagementQueryKey(engagementId),
          }),
          qc.invalidateQueries({
            queryKey: getGetAtomHistoryQueryKey("engagement", engagementId),
          }),
          // Refresh the past-submissions list (Task #75) so the new
          // package shows up immediately on the engagement detail
          // page's Submissions tab without a manual reload.
          qc.invalidateQueries({
            queryKey: getListEngagementSubmissionsQueryKey(engagementId),
          }),
        ]);
        onSubmitted?.(receipt);
        onClose();
      },
      onError: (err) => {
        setError(formatSubmitError(err));
      },
    },
  });

  if (!isOpen) return null;

  const trimmed = note.trim();
  const overLimit = note.length > createEngagementSubmissionBodyNoteMax;
  const submitting = mutation.isPending;

  const handleSubmit = () => {
    if (overLimit || submitting) return;
    setError(null);
    mutation.mutate({
      id: engagementId,
      data: trimmed.length > 0 ? { note: trimmed } : {},
    });
  };

  return (
    <div
      onClick={() => {
        if (!submitting) onClose();
      }}
      data-testid="submit-jurisdiction-dialog"
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
              Submit to jurisdiction
            </span>
            <span className="sc-meta opacity-70">
              Record that the plan-review package for{" "}
              <strong style={{ color: "var(--text-primary)" }}>
                {engagementName}
              </strong>{" "}
              has been sent
              {jurisdiction ? ` to ${jurisdiction}` : ""}.
            </span>
          </div>
        </div>

        <div className="p-4 flex flex-col" style={{ gap: 12 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span
              className="sc-label"
              style={{ color: "var(--text-secondary)" }}
            >
              Note (optional)
            </span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={submitting}
              rows={5}
              placeholder='e.g. "Permit set v1, all sheets cleaned."'
              data-testid="submit-jurisdiction-note"
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
                Notes appear on the engagement timeline and stay below 2 KB.
              </span>
              <span data-testid="submit-jurisdiction-note-count">
                {note.length} / {createEngagementSubmissionBodyNoteMax}
              </span>
            </div>
          </label>

          {error && (
            <div
              data-testid="submit-jurisdiction-error"
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
            data-testid="submit-jurisdiction-confirm"
          >
            {submitting ? "Submitting…" : "Submit to jurisdiction"}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatSubmitError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) {
      return "This engagement no longer exists. Refresh and try again.";
    }
    if (err.status === 400) {
      const detail = extractApiDetail(err);
      const fallback = `Note may be too long (max ${createEngagementSubmissionBodyNoteMax} chars) or otherwise invalid.`;
      return detail ?? fallback;
    }
    if (err.status >= 500) {
      return "The server hit a snag recording this submission. Try again in a moment.";
    }
    return extractApiDetail(err) ?? err.message;
  }
  if (err instanceof Error) return err.message;
  return "Failed to submit — please try again.";
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
