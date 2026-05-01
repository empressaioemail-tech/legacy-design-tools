import { useState } from "react";

/**
 * Comment length (characters) above which a reviewer comment is
 * considered "long" and gets clamped behind a Show more toggle.
 * Picked to match the ~4-line visual budget below: ~70 chars/line *
 * 4 lines = 280 chars. Comments at or below this render in full so
 * the common case (a short approval note like "LGTM") never grows a
 * toggle that does nothing.
 */
const REVIEWER_COMMENT_CHAR_THRESHOLD = 280;

/**
 * Newline count above which a reviewer comment is considered "long"
 * even if its character count is short — a 6-line bullet list of
 * one-word items would otherwise sneak past the char threshold and
 * still dominate the row.
 */
const REVIEWER_COMMENT_LINE_THRESHOLD = 4;

/**
 * Number of lines shown when a long reviewer comment is collapsed.
 * Matches the visual budget the char threshold was sized against.
 */
const REVIEWER_COMMENT_CLAMP_LINES = 4;

export interface ReviewerCommentProps {
  /**
   * Submission id used to namespace the data-testid attributes so a
   * single page rendering many reviewer comments still produces
   * unique selectors for tests.
   */
  submissionId: string;
  /**
   * Raw reviewer comment text. Whitespace and line breaks are
   * preserved on render via `whiteSpace: pre-wrap`.
   */
  comment: string;
}

/**
 * ReviewerComment — renders a jurisdiction reviewer's comment with a
 * "Show more" / "Show less" toggle when the content is long (Task
 * #103, extended to Design Tools by Task #115). Reviewer comments
 * are capped at 4 KB by the API contract and a long correction list
 * could otherwise dominate the past-submissions list and push other
 * rows off-screen.
 *
 * Short comments render unchanged: no toggle, no extra DOM around the
 * text. Long comments collapse to ~4 lines using the standard
 * `-webkit-line-clamp` approach (widely supported in evergreen
 * browsers including Firefox via the `line-clamp` shorthand) and
 * expose a button that flips between expanded and collapsed states.
 *
 * Whitespace / line breaks are preserved in both states via
 * `whiteSpace: pre-wrap`, matching the previous inline render so a
 * reviewer's bullet list survives the toggle intact.
 */
export function ReviewerComment({
  submissionId,
  comment,
}: ReviewerCommentProps) {
  const [expanded, setExpanded] = useState(false);

  // A comment is "long" if it crosses either the char budget or the
  // line budget. Newlines are counted directly off the source string
  // (rather than measured post-render) so the decision is stable
  // across viewport widths and SSR-equivalent.
  const lineCount = comment.split("\n").length;
  const isLong =
    comment.length > REVIEWER_COMMENT_CHAR_THRESHOLD ||
    lineCount > REVIEWER_COMMENT_LINE_THRESHOLD;

  const baseStyle = {
    color: "var(--text-primary)",
    fontSize: 12,
    whiteSpace: "pre-wrap" as const,
    borderLeft: "2px solid var(--border-active)",
    paddingLeft: 8,
  };

  if (!isLong) {
    return (
      <div
        className="sc-body"
        data-testid={`submission-reviewer-comment-${submissionId}`}
        style={baseStyle}
      >
        {comment}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div
        className="sc-body"
        data-testid={`submission-reviewer-comment-${submissionId}`}
        data-expanded={expanded ? "true" : "false"}
        style={
          expanded
            ? baseStyle
            : {
                ...baseStyle,
                display: "-webkit-box",
                WebkitBoxOrient: "vertical",
                WebkitLineClamp: REVIEWER_COMMENT_CLAMP_LINES,
                overflow: "hidden",
              }
        }
      >
        {comment}
      </div>
      <button
        type="button"
        data-testid={`submission-reviewer-comment-toggle-${submissionId}`}
        onClick={() => setExpanded((v) => !v)}
        style={{
          alignSelf: "flex-start",
          marginLeft: 8,
          padding: 0,
          background: "none",
          border: "none",
          color: "var(--text-link, var(--text-secondary))",
          fontSize: 11,
          fontWeight: 600,
          cursor: "pointer",
          textDecoration: "underline",
        }}
      >
        {expanded ? "Show less" : "Show more"}
      </button>
    </div>
  );
}
