/**
 * SubmissionCommentThread — inline reviewer↔architect conversation
 * surface for a single plan-review submission (Task #431).
 *
 * Renders three stacked sections:
 *
 *   1. The seed reviewer comment (the original
 *      `submissions.reviewer_comment`) at the top of the thread, when
 *      present, so an architect opening the modal sees the question
 *      they're replying to without scrolling. The component does NOT
 *      render this when no seed is supplied — the parent surface
 *      already has its own "REVIEWER COMMENT" section that shows it.
 *
 *   2. The reply transcript — every row from
 *      `GET /api/submissions/:id/comments`, oldest-first, color-coded
 *      by `authorRole`.
 *
 *   3. A compose box that posts a new comment via
 *      `POST /api/submissions/:id/comments`, tagged with the
 *      caller-supplied `authorRole` (the same role both surfaces
 *      pass on every post so the row attribution is honest).
 *
 * Audience-gated by the parent: the route is `audience: "internal"`
 * for both the reviewer and architect surfaces today, but the
 * component itself is audience-agnostic so the same code can be
 * mounted from either app.
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateSubmissionComment,
  useListSubmissionComments,
  getListSubmissionCommentsQueryKey,
  type SubmissionComment,
  type SubmissionCommentAuthorRole,
} from "@workspace/api-client-react";
import { createSubmissionCommentBodyBodyMax } from "@workspace/api-zod";

export interface SubmissionCommentThreadProps {
  /** Submission whose comment thread to render. */
  submissionId: string;
  /**
   * The role to tag every locally-composed comment with. Architect
   * surfaces pass `"architect"`; reviewer surfaces pass `"reviewer"`.
   * Body-supplied (rather than derived from session audience) so the
   * column carries authorship even though both surfaces share the
   * `internal` audience today.
   */
  authorRole: SubmissionCommentAuthorRole;
  /**
   * Optional seed comment — the reviewer's original
   * `submissions.reviewer_comment`. When supplied it renders above
   * the reply transcript so the reader sees the question being
   * replied to. Pass `null` (or omit) to suppress the seed row when
   * the parent surface already shows it elsewhere.
   */
  seedReviewerComment?: string | null;
}

/**
 * Per-role palette for a comment row. Reviewer rows reuse the same
 * accent palette the existing `ReviewerComment` component uses
 * (`--border-active` left bar) so the seed comment and reviewer
 * follow-ups read as a single visual voice. Architect rows use the
 * info palette so the two voices are distinguishable at a glance
 * without leaning on heavy chrome.
 */
const ROLE_PALETTE: Record<
  SubmissionCommentAuthorRole,
  { accent: string; tagBg: string; tagFg: string; tagLabel: string }
> = {
  reviewer: {
    accent: "var(--border-active)",
    tagBg: "var(--bg-input)",
    tagFg: "var(--text-secondary)",
    tagLabel: "Reviewer",
  },
  architect: {
    accent: "var(--info-text)",
    tagBg: "var(--info-dim)",
    tagFg: "var(--info-text)",
    tagLabel: "Architect",
  },
};

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const deltaMs = Date.now() - then;
  if (deltaMs < 60_000) return "just now";
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function SubmissionCommentThread({
  submissionId,
  authorRole,
  seedReviewerComment,
}: SubmissionCommentThreadProps) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");

  const listQueryKey = getListSubmissionCommentsQueryKey(submissionId);
  const { data, isLoading, isError } = useListSubmissionComments(
    submissionId,
    {
      query: { enabled: !!submissionId, queryKey: listQueryKey },
    },
  );

  const createMutation = useCreateSubmissionComment({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: listQueryKey });
        setDraft("");
      },
    },
  });

  const comments: SubmissionComment[] = data?.comments ?? [];
  const trimmed = draft.trim();
  const overLimit = trimmed.length > createSubmissionCommentBodyBodyMax;
  const canSubmit =
    trimmed.length > 0 && !overLimit && !createMutation.isPending;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    createMutation.mutate({
      submissionId,
      data: { authorRole, body: trimmed },
    });
  }

  return (
    <div
      data-testid={`submission-comment-thread-${submissionId}`}
      style={{ display: "flex", flexDirection: "column", gap: 10 }}
    >
      {seedReviewerComment && (
        <CommentRow
          row={{
            authorRole: "reviewer",
            body: seedReviewerComment,
            tagSuffix: "(original)",
          }}
          testId={`submission-comment-seed-${submissionId}`}
        />
      )}

      {isLoading && (
        <div
          className="sc-body opacity-60"
          data-testid={`submission-comment-thread-loading-${submissionId}`}
          style={{ fontSize: 12 }}
        >
          Loading conversation…
        </div>
      )}

      {isError && (
        <div
          className="sc-body"
          data-testid={`submission-comment-thread-error-${submissionId}`}
          style={{ fontSize: 12, color: "var(--danger-text)" }}
        >
          Couldn't load the conversation. Try refreshing.
        </div>
      )}

      {comments.map((c) => (
        <CommentRow
          key={c.id}
          row={{
            authorRole: c.authorRole,
            body: c.body,
            timestamp: c.createdAt,
          }}
          testId={`submission-comment-${c.id}`}
        />
      ))}

      {!isLoading && !isError && comments.length === 0 && !seedReviewerComment && (
        <div
          className="sc-body opacity-60"
          data-testid={`submission-comment-thread-empty-${submissionId}`}
          style={{ fontSize: 12, fontStyle: "italic" }}
        >
          No replies yet.
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        style={{ display: "flex", flexDirection: "column", gap: 6 }}
      >
        <textarea
          data-testid={`submission-comment-compose-${submissionId}`}
          placeholder={
            authorRole === "architect"
              ? "Reply to the reviewer…"
              : "Reply to the architect…"
          }
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          maxLength={createSubmissionCommentBodyBodyMax}
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
        {createMutation.isError && (
          <div
            className="sc-body"
            data-testid={`submission-comment-compose-error-${submissionId}`}
            style={{ fontSize: 11, color: "var(--danger-text)" }}
          >
            Couldn't post your reply. Try again.
          </div>
        )}
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
            style={{
              color: overLimit ? "var(--danger-text)" : "var(--text-secondary)",
              fontSize: 11,
            }}
          >
            {trimmed.length}/{createSubmissionCommentBodyBodyMax}
          </span>
          <button
            type="submit"
            data-testid={`submission-comment-submit-${submissionId}`}
            disabled={!canSubmit}
            className="sc-btn-primary"
            style={{
              padding: "4px 12px",
              fontSize: 12,
              opacity: canSubmit ? 1 : 0.5,
              cursor: canSubmit ? "pointer" : "not-allowed",
            }}
          >
            {createMutation.isPending ? "Posting…" : "Post reply"}
          </button>
        </div>
      </form>
    </div>
  );
}

interface CommentRowProps {
  row: {
    authorRole: SubmissionCommentAuthorRole;
    body: string;
    timestamp?: string;
    tagSuffix?: string;
  };
  testId: string;
}

function CommentRow({ row, testId }: CommentRowProps) {
  const palette = ROLE_PALETTE[row.authorRole];
  return (
    <div
      data-testid={testId}
      data-author-role={row.authorRole}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        borderLeft: `2px solid ${palette.accent}`,
        paddingLeft: 8,
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
        <span
          style={{
            background: palette.tagBg,
            color: palette.tagFg,
            fontSize: 10,
            fontWeight: 600,
            padding: "1px 6px",
            borderRadius: 3,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          {palette.tagLabel}
          {row.tagSuffix ? ` ${row.tagSuffix}` : ""}
        </span>
        {row.timestamp && (
          <span
            className="sc-meta"
            title={new Date(row.timestamp).toLocaleString()}
            style={{ color: "var(--text-secondary)", fontSize: 11 }}
          >
            {relativeTime(row.timestamp)}
          </span>
        )}
      </div>
      <div
        className="sc-body"
        style={{
          color: "var(--text-primary)",
          fontSize: 12.5,
          whiteSpace: "pre-wrap",
          lineHeight: 1.5,
        }}
      >
        {row.body}
      </div>
    </div>
  );
}
