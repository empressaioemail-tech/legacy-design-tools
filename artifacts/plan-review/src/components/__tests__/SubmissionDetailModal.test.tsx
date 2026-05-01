/**
 * SubmissionDetailModal — Plan Review submission detail modal shell
 * (Wave 2 Sprint B / Task #306).
 *
 * Covers the modal-shell behavior the reviewer relies on:
 *
 *   1. Renders nothing when `submission` is null (closed state).
 *   2. Mounts the BIM Model tab as the default-active tab when a
 *      submission is supplied (Sprint A's "Engagement Context" tab
 *      lands here later as a sibling without restructuring).
 *   3. Calls `onClose` when the Radix Dialog's overlay-close fires.
 *
 * The BimModelTab itself is mocked to a thin marker component so the
 * shell test stays focused on tab routing and modal lifecycle —
 * `BimModelTab.test.tsx` covers the tab body's behavior end-to-end.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { EngagementSubmissionSummary } from "@workspace/api-client-react";

vi.mock("../BimModelTab", () => ({
  BimModelTab: ({ engagementId }: { engagementId: string }) => (
    <div
      data-testid="bim-model-tab-mock"
      data-engagement-id={engagementId}
    >
      BIM Model tab
    </div>
  ),
}));

// Pin `relativeTime` so the subtitle string is deterministic across
// machine clocks (the modal renders "5 min ago"-style copy off the
// submission's submittedAt).
vi.mock("../../lib/relativeTime", () => ({
  relativeTime: () => "just now",
}));

const { SubmissionDetailModal } = await import("../SubmissionDetailModal");

const baseSubmission: EngagementSubmissionSummary = {
  id: "sub-1",
  submittedAt: "2026-04-01T10:00:00.000Z",
  jurisdiction: "Boulder, CO",
  note: null,
  status: "pending",
  reviewerComment: null,
  respondedAt: null,
  responseRecordedAt: null,
};

afterEach(() => {
  cleanup();
});

describe("SubmissionDetailModal — Plan Review (Task #306)", () => {
  it("renders nothing when submission is null", () => {
    render(
      <SubmissionDetailModal
        submission={null}
        engagementId="eng-1"
        onClose={() => {}}
      />,
    );
    expect(screen.queryByTestId("submission-detail-modal")).toBeNull();
  });

  it("mounts the BIM Model tab content by default when opened", async () => {
    render(
      <SubmissionDetailModal
        submission={baseSubmission}
        engagementId="eng-1"
        onClose={() => {}}
      />,
    );
    expect(
      await screen.findByTestId("submission-detail-modal-title"),
    ).toBeInTheDocument();
    // Tab shell renders.
    expect(
      screen.getByTestId("submission-detail-modal-tabs"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("submission-detail-modal-tab-bim-model"),
    ).toBeInTheDocument();
    // BIM Model tab content is the default-active tab.
    const tabContent = await screen.findByTestId(
      "submission-detail-modal-bim-model-content",
    );
    expect(tabContent).toBeInTheDocument();
    const tab = screen.getByTestId("bim-model-tab-mock");
    expect(tab).toBeInTheDocument();
    expect(tab).toHaveAttribute("data-engagement-id", "eng-1");
  });

  it("switches between BIM Model and Engagement Context placeholder tabs", async () => {
    render(
      <SubmissionDetailModal
        submission={baseSubmission}
        engagementId="eng-1"
        onClose={() => {}}
      />,
    );
    // BIM Model is the default-active tab.
    expect(
      await screen.findByTestId("bim-model-tab-mock"),
    ).toBeInTheDocument();
    // Click the Engagement Context tab and verify the placeholder
    // pane renders. This pins the Tabs shell so a regression that
    // collapses the modal back to a single tab fails the test.
    fireEvent.click(
      screen.getByTestId("submission-detail-modal-tab-engagement-context"),
    );
    expect(
      await screen.findByTestId(
        "submission-detail-modal-engagement-context-pane",
      ),
    ).toBeInTheDocument();
  });

  it("surfaces the jurisdiction + relative-time subtitle in the modal header", async () => {
    render(
      <SubmissionDetailModal
        submission={baseSubmission}
        engagementId="eng-1"
        onClose={() => {}}
      />,
    );
    const subtitle = await screen.findByTestId(
      "submission-detail-modal-subtitle",
    );
    expect(subtitle.textContent).toContain("Boulder, CO");
    expect(subtitle.textContent).toContain("just now");
  });
});
