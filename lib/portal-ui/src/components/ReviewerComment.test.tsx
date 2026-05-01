/**
 * Component-level tests for the shared `ReviewerComment`.
 *
 * Lives next to the component (Task #377, following Tasks #362 / #367
 * for the rest of the portal-ui sibling-test set) so the collapsible
 * "Show more" / "Show less" toggle, the dual char (>280) + line (>4)
 * thresholds, the `data-expanded` attribute, the
 * `submission-reviewer-comment-${id}` /
 * `submission-reviewer-comment-toggle-${id}` testids, and the
 * whitespace preservation invariant are exercised against the
 * rendered DOM without standing up either consumer's submission-
 * detail scaffolding around it.
 *
 * The duplicated coverage on
 * `artifacts/design-tools/src/components/__tests__/ReviewerComment.test.tsx`
 * (Task #128) stays valid as integration cover from the consumer
 * side, but a refactor that touches only the shared component can
 * no longer ship without ever running a portal-ui-scoped test.
 *
 * The component has no `useQuery`-style hooks and no module-level
 * state to mock — it just owns a single `useState` for the
 * expand/collapse latch. We mount it directly and drive the toggle
 * with `fireEvent.click` so we don't pull `userEvent` into the
 * portal-ui dev deps for one assertion.
 */

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { ReviewerComment } from "./ReviewerComment";

const SUBMISSION_ID = "sub-377";
const COMMENT_TESTID = `submission-reviewer-comment-${SUBMISSION_ID}`;
const TOGGLE_TESTID = `submission-reviewer-comment-toggle-${SUBMISSION_ID}`;

describe("ReviewerComment", () => {
  it("renders a short comment inline with no toggle and no data-expanded attribute", () => {
    // The common case (a one-line approval note like "LGTM") must
    // not grow a button that does nothing — the toggle is gated on
    // either >280 chars or >4 newlines, neither of which a short
    // approval note crosses.
    const short = "LGTM — ready to permit.";
    render(<ReviewerComment submissionId={SUBMISSION_ID} comment={short} />);

    const body = screen.getByTestId(COMMENT_TESTID);
    expect(body).toHaveTextContent(short);
    expect(screen.queryByTestId(TOGGLE_TESTID)).toBeNull();
    // The `data-expanded` attribute only appears on the long-comment
    // branch — short comments must not emit it (otherwise consumers
    // keying off the attribute would mis-bucket short rows).
    expect(body).not.toHaveAttribute("data-expanded");
  });

  it("does not grow a toggle at exactly 280 chars / exactly 4 lines (boundary check)", () => {
    // The thresholds are STRICT > comparisons, not >=, so a comment
    // that lands exactly on either boundary must still render
    // inline. Pin both boundaries so a future tweak that flips the
    // operator to >= silently doesn't add a no-op toggle to the
    // common "near the limit" reviewer note.
    //
    // 280 chars on a single line.
    const at280 = "x".repeat(280);
    const { unmount: unmountChars } = render(
      <ReviewerComment submissionId={SUBMISSION_ID} comment={at280} />,
    );
    expect(screen.queryByTestId(TOGGLE_TESTID)).toBeNull();
    unmountChars();

    // Exactly 4 lines (3 newlines) → still under the >4 line gate.
    const fourLines = ["a", "b", "c", "d"].join("\n");
    expect(fourLines.split("\n").length).toBe(4);
    render(
      <ReviewerComment submissionId={SUBMISSION_ID} comment={fourLines} />,
    );
    expect(screen.queryByTestId(TOGGLE_TESTID)).toBeNull();
  });

  it("collapses long comments (>280 chars) behind a 'Show more' toggle and expands on click", () => {
    // 320 chars, well past the 280-char gate. The full text is in
    // the DOM even when collapsed (CSS clamps it visually) so
    // surface-level tests can still assert the comment content
    // regardless of toggle state.
    const long = "x".repeat(320);
    render(<ReviewerComment submissionId={SUBMISSION_ID} comment={long} />);

    const body = screen.getByTestId(COMMENT_TESTID);
    const toggle = screen.getByTestId(TOGGLE_TESTID);

    // Starts collapsed — `data-expanded="false"` is the contract
    // surface-level tests on plan-review / design-tools key off.
    expect(body).toHaveAttribute("data-expanded", "false");
    expect(toggle).toHaveTextContent("Show more");
    expect(body).toHaveTextContent(long);

    // Expand.
    fireEvent.click(toggle);
    expect(body).toHaveAttribute("data-expanded", "true");
    expect(toggle).toHaveTextContent("Show less");

    // Collapse again — the latch flips both ways from a single
    // `useState` boolean, so the round-trip must land back on the
    // initial state without losing the comment text.
    fireEvent.click(toggle);
    expect(body).toHaveAttribute("data-expanded", "false");
    expect(toggle).toHaveTextContent("Show more");
    expect(body).toHaveTextContent(long);
  });

  it("collapses comments with >4 newlines even when under the char budget, and preserves whitespace across the toggle", () => {
    // 6 short bullet lines — character count is tiny but the line
    // count (5 newlines = 6 lines) crosses the >4 line gate. This
    // is the case the line threshold was added for: a long bullet
    // list of one-word items would otherwise sneak past the char
    // threshold and still dominate the row.
    const multiline = ["- a", "- b", "- c", "- d", "- e", "- f"].join("\n");
    expect(multiline.length).toBeLessThan(280);

    render(
      <ReviewerComment submissionId={SUBMISSION_ID} comment={multiline} />,
    );

    const body = screen.getByTestId(COMMENT_TESTID);
    const toggle = screen.getByTestId(TOGGLE_TESTID);

    expect(body).toHaveAttribute("data-expanded", "false");
    expect(toggle).toHaveTextContent("Show more");

    fireEvent.click(toggle);
    expect(body).toHaveAttribute("data-expanded", "true");
    expect(toggle).toHaveTextContent("Show less");
    // Line breaks must survive the toggle: the textContent should
    // still carry the raw `\n` separators (rendered visually via
    // `whiteSpace: pre-wrap`). If a future refactor swaps to a
    // line-by-line `<div>` render and drops the newlines, the
    // bullet list would visually collapse on copy/paste.
    expect(body.textContent).toBe(multiline);
  });

  it("namespaces the testids by submissionId so a list view with many comments stays uniquely selectable", () => {
    // Two reviewer comments on the same page must each get
    // distinct testids — otherwise `getByTestId` would explode on
    // a multi-submission list view (the engagement past-
    // submissions surface). The same long comment is intentionally
    // used for both so the only thing differentiating their nodes
    // is the submissionId-scoped testid.
    const long = "x".repeat(320);
    render(
      <>
        <ReviewerComment submissionId="sub-A" comment={long} />
        <ReviewerComment submissionId="sub-B" comment={long} />
      </>,
    );

    expect(
      screen.getByTestId("submission-reviewer-comment-sub-A"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("submission-reviewer-comment-sub-B"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("submission-reviewer-comment-toggle-sub-A"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("submission-reviewer-comment-toggle-sub-B"),
    ).toBeInTheDocument();

    // Toggling A must NOT flip B — proves the `useState` latch is
    // local to each instance, not shared via some module-level
    // store. Otherwise two comments side by side would expand and
    // collapse together, which would be a real surprise on the
    // past-submissions list.
    fireEvent.click(
      screen.getByTestId("submission-reviewer-comment-toggle-sub-A"),
    );
    expect(
      screen.getByTestId("submission-reviewer-comment-sub-A"),
    ).toHaveAttribute("data-expanded", "true");
    expect(
      screen.getByTestId("submission-reviewer-comment-sub-B"),
    ).toHaveAttribute("data-expanded", "false");
  });
});
