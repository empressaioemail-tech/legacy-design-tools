/**
 * DecisionTab — reviewer-side decision panel + revision history list
 * for the submission detail modal (Task #428 / Reviewer V1-D).
 *
 * Composition:
 *   1. Status header — current submission status badge.
 *   2. Action grid — four buttons:
 *        - Comments posted     → status: corrections_requested,
 *                                comment optional. Soft "FYI here are
 *                                some notes" path.
 *        - Revision requested  → status: corrections_requested,
 *                                comment REQUIRED.
 *        - Approve             → status: approved, comment optional.
 *        - Deny                → status: rejected, comment REQUIRED.
 *      Each button reveals a shared inline composer where the
 *      reviewer types the optional/required comment, then submits to
 *      the existing `POST /api/engagements/:id/submissions/:submissionId/response`
 *      endpoint via `useRecordSubmissionResponse` (Task #428 reuses
 *      the architect-side mutation; no new backend route).
 *   3. Recorded banner — fires `SubmissionRecordedBanner` (the same
 *      component used by the page-level "Submitted to jurisdiction"
 *      flow) on success so the reviewer gets the same in-place
 *      confirmation.
 *   4. Revision history — `RevisionHistoryList` below the panel
 *      lists every prior submission for the engagement reverse-
 *      chronologically, badging the status outcome and surfacing the
 *      reviewer comment that was recorded against each. The current
 *      submission is highlighted in place; sibling rows expose a
 *      hairline "Open this submission" link that re-deep-links the
 *      modal via the canonical `?submission=<id>` URL convention.
 *
 * Audience gate: the parent passes `audience` so non-`internal`
 * sessions see read-only chrome (status + history) without the
 * action buttons or composer. The route already enforces this on
 * the server side; the FE gate keeps the surface honest so a
 * non-reviewer never sees a button that would 403.
 */

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  useListEngagementSubmissions,
  useRecordSubmissionResponse,
  getListEngagementSubmissionsQueryKey,
  type EngagementSubmissionSummary,
  type SubmissionResponse,
  type SubmissionStatus,
} from "@workspace/api-client-react";
import { recordSubmissionResponseBodyReviewerCommentMax } from "@workspace/api-zod";
import { relativeTime } from "../lib/relativeTime";

// Mirrors the architect-side label table used elsewhere in this
// artifact; duplicated here rather than imported because the
// SubmissionDetailModal copy is private to its scope.
const SUBMISSION_STATUS_LABELS: Record<SubmissionStatus, string> = {
  pending: "Pending",
  approved: "Approved",
  corrections_requested: "Corrections requested",
  rejected: "Rejected",
};

const SUBMISSION_STATUS_COLORS: Record<
  SubmissionStatus,
  { bg: string; fg: string }
> = {
  pending: { bg: "var(--info-dim)", fg: "var(--info-text)" },
  approved: { bg: "var(--success-dim)", fg: "var(--success-text)" },
  corrections_requested: {
    bg: "var(--warning-dim)",
    fg: "var(--warning-text)",
  },
  rejected: { bg: "var(--danger-dim)", fg: "var(--danger-text)" },
};

function StatusPill({ status }: { status: SubmissionStatus }) {
  const palette =
    SUBMISSION_STATUS_COLORS[status] ?? SUBMISSION_STATUS_COLORS.pending;
  return (
    <span
      data-testid={`decision-status-badge-${status}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 8px",
        borderRadius: 999,
        background: palette.bg,
        color: palette.fg,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: 0.2,
        textTransform: "uppercase",
        lineHeight: 1.4,
      }}
    >
      {SUBMISSION_STATUS_LABELS[status] ?? status}
    </span>
  );
}

/**
 * Per-action descriptor. `status` is the value POSTed to the
 * response endpoint; `commentRequired` enforces the client-side
 * required-comment rule the task spec calls out for "Revision
 * requested" + "Deny".
 */
type DecisionAction = {
  key: "comments-posted" | "revision-requested" | "approve" | "deny";
  label: string;
  status: SubmissionStatus & ("approved" | "corrections_requested" | "rejected");
  commentRequired: boolean;
  variant: "neutral" | "warning" | "primary" | "danger";
  helper: string;
};

const DECISION_ACTIONS: readonly DecisionAction[] = [
  {
    key: "comments-posted",
    label: "Comments posted",
    status: "corrections_requested",
    commentRequired: false,
    variant: "neutral",
    helper:
      "Records that you've posted comments on this package. Optional summary note for the architect.",
  },
  {
    key: "revision-requested",
    label: "Revision requested",
    status: "corrections_requested",
    commentRequired: true,
    variant: "warning",
    helper:
      "Sends the package back for a revision. A reviewer comment is required so the architect knows what to change.",
  },
  {
    key: "approve",
    label: "Approve",
    status: "approved",
    commentRequired: false,
    variant: "primary",
    helper: "Marks the package approved. Optional comment.",
  },
  {
    key: "deny",
    label: "Deny",
    status: "rejected",
    commentRequired: true,
    variant: "danger",
    helper:
      "Denies the package. A reviewer comment is required so the architect understands the basis.",
  },
];

function variantClass(variant: DecisionAction["variant"]): string {
  switch (variant) {
    case "primary":
      return "sc-btn-primary";
    case "danger":
    case "warning":
    case "neutral":
    default:
      return "sc-btn-ghost";
  }
}

export interface DecisionTabProps {
  submission: EngagementSubmissionSummary;
  engagementId: string;
  audience: "internal" | "user" | "ai";
  /**
   * URL deep-link helper used by the revision history list when a
   * sibling row's "Open this submission" affordance is rendered as a
   * link (i.e. when `onOpenSubmission` is not provided). Defaults to
   * the canonical `/engagements/:id?submission=<id>` shape used by
   * the rest of the page; injected for tests.
   */
  buildSubmissionHref?: (engagementId: string, submissionId: string) => string;
  /**
   * When provided, the revision-history "Open this submission" row
   * affordance becomes a button that fires this callback instead of
   * a `<Link>`. The page-level modal-state setter wires this up so
   * clicking actually swaps the modal over to the chosen revision —
   * a URL-only deep-link from inside the modal would update
   * `?submission=` without flipping the parent's `openSubmissionId`,
   * leaving the modal stuck on the original revision.
   */
  onOpenSubmission?: (submissionId: string) => void;
}

function defaultSubmissionHref(
  engagementId: string,
  submissionId: string,
): string {
  return `/engagements/${engagementId}?submission=${submissionId}`;
}

export function DecisionTab({
  submission,
  engagementId,
  audience,
  buildSubmissionHref = defaultSubmissionHref,
  onOpenSubmission,
}: DecisionTabProps) {
  const qc = useQueryClient();
  const isReviewer = audience === "internal";

  const [activeAction, setActiveAction] = useState<DecisionAction | null>(null);
  const [comment, setComment] = useState("");
  const [recorded, setRecorded] = useState<{
    status: SubmissionStatus;
    respondedAt: string;
  } | null>(null);

  const mutation = useRecordSubmissionResponse({
    mutation: {
      onSuccess: (resp: SubmissionResponse) => {
        setRecorded({
          status: resp.status,
          respondedAt: resp.respondedAt ?? new Date().toISOString(),
        });
        setActiveAction(null);
        setComment("");
        qc.invalidateQueries({
          queryKey: getListEngagementSubmissionsQueryKey(engagementId),
        });
      },
    },
  });

  const trimmedComment = comment.trim();
  const overLimit =
    trimmedComment.length > recordSubmissionResponseBodyReviewerCommentMax;
  const commentMissing =
    !!activeAction && activeAction.commentRequired && trimmedComment.length === 0;
  const canSubmit =
    !!activeAction && !overLimit && !commentMissing && !mutation.isPending;

  function handleAction(action: DecisionAction) {
    setRecorded(null);
    if (activeAction?.key === action.key) {
      // Clicking the same button twice cancels the composer.
      setActiveAction(null);
      setComment("");
      return;
    }
    setActiveAction(action);
    setComment("");
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!activeAction || !canSubmit) return;
    const data: { status: typeof activeAction.status; reviewerComment?: string } =
      {
        status: activeAction.status,
      };
    if (trimmedComment.length > 0) {
      data.reviewerComment = trimmedComment;
    }
    mutation.mutate({
      id: engagementId,
      submissionId: submission.id,
      data,
    });
  }

  // Show the live status from the just-recorded mutation when present
  // (so the badge updates even before the list query refetches),
  // otherwise the row's persisted status.
  const displayedStatus: SubmissionStatus =
    recorded?.status ?? submission.status;

  return (
    <div
      data-testid="submission-detail-decision-pane"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        padding: 16,
      }}
    >
      <section
        data-testid="decision-status-row"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 13,
        }}
      >
        <span style={{ color: "var(--text-muted)" }}>Current status</span>
        <StatusPill status={displayedStatus} />
        {submission.respondedAt && (
          <span
            className="sc-meta"
            data-testid="decision-status-responded-at"
            title={new Date(submission.respondedAt).toLocaleString()}
            style={{ color: "var(--text-secondary)", fontSize: 11 }}
          >
            Responded {relativeTime(submission.respondedAt)}
          </span>
        )}
      </section>

      {recorded && (
        <div
          role="status"
          aria-live="polite"
          data-testid="decision-recorded-banner"
          className="sc-card flex items-center justify-between flex-shrink-0"
          style={{
            padding: "10px 14px",
            background: "var(--info-dim)",
            borderColor: "var(--info-text)",
            color: "var(--text-primary)",
          }}
        >
          <div
            className="flex items-center gap-2"
            style={{ fontSize: 13 }}
          >
            <span
              aria-hidden
              style={{ color: "var(--info-text)", fontWeight: 600 }}
            >
              ✓
            </span>
            <span>
              Recorded as{" "}
              <strong>
                {SUBMISSION_STATUS_LABELS[recorded.status] ?? recorded.status}
              </strong>{" "}
              ·{" "}
              <span
                title={new Date(recorded.respondedAt).toLocaleString()}
                style={{ color: "var(--text-secondary)" }}
              >
                {relativeTime(recorded.respondedAt)}
              </span>
            </span>
          </div>
          <button
            type="button"
            className="sc-btn-ghost"
            onClick={() => setRecorded(null)}
            aria-label="Dismiss decision confirmation"
            data-testid="decision-recorded-banner-dismiss"
            style={{ padding: "2px 8px", fontSize: 12 }}
          >
            Dismiss
          </button>
        </div>
      )}

      {isReviewer ? (
        <section
          data-testid="decision-actions"
          style={{ display: "flex", flexDirection: "column", gap: 12 }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
              gap: 8,
            }}
          >
            {DECISION_ACTIONS.map((action) => {
              const isActive = activeAction?.key === action.key;
              return (
                <button
                  key={action.key}
                  type="button"
                  data-testid={`decision-action-${action.key}`}
                  data-active={isActive ? "true" : "false"}
                  className={variantClass(action.variant)}
                  onClick={() => handleAction(action)}
                  disabled={mutation.isPending && !isActive}
                  style={{
                    fontSize: 12,
                    padding: "6px 10px",
                    borderColor: isActive
                      ? "var(--border-active)"
                      : undefined,
                  }}
                >
                  {action.label}
                </button>
              );
            })}
          </div>

          {activeAction && (
            <form
              onSubmit={handleSubmit}
              data-testid="decision-composer"
              data-action-key={activeAction.key}
              style={{ display: "flex", flexDirection: "column", gap: 6 }}
            >
              <div
                className="sc-meta"
                style={{ color: "var(--text-secondary)", fontSize: 12 }}
              >
                {activeAction.helper}
              </div>
              <textarea
                data-testid="decision-comment-input"
                placeholder={
                  activeAction.commentRequired
                    ? "Required: explain your decision so the architect can act on it."
                    : "Optional: add context for the architect."
                }
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={4}
                maxLength={recordSubmissionResponseBodyReviewerCommentMax}
                style={{
                  width: "100%",
                  background: "var(--bg-input)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border-default)",
                  borderRadius: 4,
                  padding: 8,
                  fontSize: 12,
                  fontFamily: "inherit",
                  resize: "vertical",
                }}
              />
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <span
                  className="sc-meta"
                  data-testid="decision-comment-count"
                  style={{
                    color: overLimit
                      ? "var(--danger-text)"
                      : "var(--text-secondary)",
                    fontSize: 11,
                  }}
                >
                  {trimmedComment.length}/
                  {recordSubmissionResponseBodyReviewerCommentMax}
                </span>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    className="sc-btn-ghost"
                    data-testid="decision-cancel"
                    onClick={() => {
                      setActiveAction(null);
                      setComment("");
                    }}
                    disabled={mutation.isPending}
                    style={{ fontSize: 12, padding: "4px 12px" }}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="sc-btn-primary"
                    data-testid="decision-submit"
                    disabled={!canSubmit}
                    style={{
                      fontSize: 12,
                      padding: "4px 12px",
                      opacity: canSubmit ? 1 : 0.5,
                      cursor: canSubmit ? "pointer" : "not-allowed",
                    }}
                  >
                    {mutation.isPending ? "Recording…" : `Record ${activeAction.label.toLowerCase()}`}
                  </button>
                </div>
              </div>
              {commentMissing && (
                <div
                  className="sc-meta"
                  data-testid="decision-comment-required"
                  style={{ color: "var(--danger-text)", fontSize: 11 }}
                >
                  A reviewer comment is required for {activeAction.label}.
                </div>
              )}
              {mutation.isError && (
                <div
                  className="sc-meta"
                  data-testid="decision-submit-error"
                  role="alert"
                  style={{ color: "var(--danger-text)", fontSize: 11 }}
                >
                  Couldn't record your decision. Try again in a moment.
                </div>
              )}
            </form>
          )}
        </section>
      ) : (
        <div
          className="sc-meta"
          data-testid="decision-readonly-notice"
          style={{
            color: "var(--text-secondary)",
            fontSize: 12,
            fontStyle: "italic",
          }}
        >
          Only reviewers can record a decision on this submission.
        </div>
      )}

      <RevisionHistoryList
        engagementId={engagementId}
        currentSubmissionId={submission.id}
        buildSubmissionHref={buildSubmissionHref}
        onOpenSubmission={onOpenSubmission}
      />
    </div>
  );
}

export interface RevisionHistoryListProps {
  engagementId: string;
  currentSubmissionId: string;
  buildSubmissionHref: (engagementId: string, submissionId: string) => string;
  /**
   * When provided, each non-current row's "Open this submission"
   * affordance becomes a `<button>` that fires this callback. When
   * omitted, the row falls back to a wouter `<Link>` for the deep
   * link. See `DecisionTabProps.onOpenSubmission` for rationale.
   */
  onOpenSubmission?: (submissionId: string) => void;
}

/**
 * Reverse-chronological list of every submission filed against the
 * engagement. Used by the Decision tab so the reviewer can trace
 * "this revision addresses these comments" at a glance — each row
 * surfaces the status outcome plus the reviewer comment recorded
 * against it. Pulls from the same `useListEngagementSubmissions`
 * query the page already populated, so opening the tab costs no
 * extra round trips.
 */
export function RevisionHistoryList({
  engagementId,
  currentSubmissionId,
  buildSubmissionHref,
  onOpenSubmission,
}: RevisionHistoryListProps) {
  const { data, isLoading, isError } = useListEngagementSubmissions(
    engagementId,
    {
      query: {
        enabled: !!engagementId,
        queryKey: getListEngagementSubmissionsQueryKey(engagementId),
      },
    },
  );

  const ordered = useMemo(() => {
    if (!data) return [] as EngagementSubmissionSummary[];
    return [...data].sort(
      (a, b) =>
        new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime(),
    );
  }, [data]);

  return (
    <section
      data-testid="revision-history"
      style={{ display: "flex", flexDirection: "column", gap: 8 }}
    >
      <div
        className="sc-label"
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: "var(--text-muted)",
        }}
      >
        Revision history
      </div>
      {isLoading && (
        <div
          className="sc-body opacity-60"
          data-testid="revision-history-loading"
          style={{ fontSize: 12 }}
        >
          Loading revision history…
        </div>
      )}
      {isError && (
        <div
          className="sc-body"
          data-testid="revision-history-error"
          style={{ fontSize: 12, color: "var(--danger-text)" }}
        >
          Couldn't load the revision history.
        </div>
      )}
      {!isLoading && !isError && ordered.length === 0 && (
        <div
          className="sc-body opacity-60"
          data-testid="revision-history-empty"
          style={{ fontSize: 12, fontStyle: "italic" }}
        >
          No prior revisions on file.
        </div>
      )}
      {ordered.map((row) => {
        const isCurrent = row.id === currentSubmissionId;
        return (
          <div
            key={row.id}
            data-testid={`revision-history-row-${row.id}`}
            data-current={isCurrent ? "true" : "false"}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              padding: 8,
              border: "1px solid var(--border-default)",
              borderLeft: isCurrent
                ? "3px solid var(--border-active)"
                : "1px solid var(--border-default)",
              borderRadius: 4,
              background: isCurrent ? "var(--bg-input)" : "transparent",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <div
                style={{ display: "flex", alignItems: "center", gap: 8 }}
              >
                <StatusPill status={row.status} />
                <span
                  className="sc-meta"
                  title={new Date(row.submittedAt).toLocaleString()}
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: 11,
                  }}
                >
                  Submitted {relativeTime(row.submittedAt)}
                </span>
              </div>
              {isCurrent ? (
                <span
                  data-testid={`revision-history-current-${row.id}`}
                  className="sc-meta"
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: 10,
                    textTransform: "uppercase",
                    letterSpacing: 0.4,
                  }}
                >
                  Viewing
                </span>
              ) : onOpenSubmission ? (
                <button
                  type="button"
                  onClick={() => onOpenSubmission(row.id)}
                  data-testid={`revision-history-open-${row.id}`}
                  className="sc-meta"
                  style={{
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    color: "var(--text-secondary)",
                    fontSize: 11,
                    textDecoration: "underline",
                  }}
                >
                  Open this submission
                </button>
              ) : (
                <Link
                  href={buildSubmissionHref(engagementId, row.id)}
                  data-testid={`revision-history-open-${row.id}`}
                  className="sc-meta"
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: 11,
                    textDecoration: "underline",
                  }}
                >
                  Open this submission
                </Link>
              )}
            </div>
            {row.reviewerComment && (
              <div
                className="sc-body"
                data-testid={`revision-history-comment-${row.id}`}
                style={{
                  fontSize: 12,
                  color: "var(--text-primary)",
                  whiteSpace: "pre-wrap",
                  lineHeight: 1.5,
                }}
              >
                {row.reviewerComment}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
