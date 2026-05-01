/**
 * ReviewerComment — locks in the collapsible reviewer-comment toggle that
 * Plan Review (Task #103) and Design Tools (Task #115) share via
 * `@workspace/portal-ui`. The thresholds (>280 chars OR >4 newlines), the
 * `submission-reviewer-comment-toggle-${id}` test id, the `data-expanded`
 * attribute, and the "Show more" / "Show less" copy are all part of the
 * contract we want pinned: a future tweak to any of them would otherwise
 * silently regress both surfaces (Task #128).
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ReviewerComment } from "@workspace/portal-ui";

const SUBMISSION_ID = "sub-128";
const COMMENT_TESTID = `submission-reviewer-comment-${SUBMISSION_ID}`;
const TOGGLE_TESTID = `submission-reviewer-comment-toggle-${SUBMISSION_ID}`;

describe("ReviewerComment (collapsible toggle)", () => {
  it("renders short comments inline with no toggle button", () => {
    const short = "LGTM — ready to permit.";
    render(<ReviewerComment submissionId={SUBMISSION_ID} comment={short} />);

    const body = screen.getByTestId(COMMENT_TESTID);
    expect(body).toHaveTextContent(short);
    // No toggle should exist for short comments — the common
    // approval-note case must not grow a button that does nothing.
    expect(screen.queryByTestId(TOGGLE_TESTID)).toBeNull();
    // No data-expanded attribute either: the collapse contract only
    // applies when the comment is long enough to clamp.
    expect(body.getAttribute("data-expanded")).toBeNull();
  });

  it("collapses long comments (>280 chars) behind a 'Show more' toggle and expands on click", async () => {
    const user = userEvent.setup();
    // 320 chars of a single line — well over the 280-char threshold.
    const long = "x".repeat(320);
    render(<ReviewerComment submissionId={SUBMISSION_ID} comment={long} />);

    const body = screen.getByTestId(COMMENT_TESTID);
    const toggle = screen.getByTestId(TOGGLE_TESTID);

    // Starts collapsed.
    expect(body.getAttribute("data-expanded")).toBe("false");
    expect(toggle).toHaveTextContent("Show more");
    // The full text is in the DOM even when collapsed (CSS clamps it
    // visually); the test id should always carry the comment content.
    expect(body).toHaveTextContent(long);

    // Expand.
    await user.click(toggle);
    expect(body.getAttribute("data-expanded")).toBe("true");
    expect(toggle).toHaveTextContent("Show less");

    // Collapse again.
    await user.click(toggle);
    expect(body.getAttribute("data-expanded")).toBe("false");
    expect(toggle).toHaveTextContent("Show more");
  });

  it("collapses comments with >4 newlines even when under the char budget, and preserves line breaks when expanded", async () => {
    const user = userEvent.setup();
    // 6 short bullet lines — character count is tiny but the line
    // count (5 newlines = 6 lines) crosses the line threshold.
    const multiline = ["- a", "- b", "- c", "- d", "- e", "- f"].join("\n");
    expect(multiline.length).toBeLessThan(280);

    render(<ReviewerComment submissionId={SUBMISSION_ID} comment={multiline} />);

    const body = screen.getByTestId(COMMENT_TESTID);
    const toggle = screen.getByTestId(TOGGLE_TESTID);

    expect(body.getAttribute("data-expanded")).toBe("false");
    expect(toggle).toHaveTextContent("Show more");

    await user.click(toggle);
    expect(body.getAttribute("data-expanded")).toBe("true");
    expect(toggle).toHaveTextContent("Show less");
    // Line breaks survive the toggle: every bullet is present and the
    // raw text content still contains the newline separators
    // (rendered via whiteSpace: pre-wrap).
    expect(body.textContent).toBe(multiline);
  });
});
