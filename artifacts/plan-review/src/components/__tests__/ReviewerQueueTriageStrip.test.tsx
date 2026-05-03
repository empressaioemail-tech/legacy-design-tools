/**
 * `ReviewerQueueTriageStrip` — Track 1.
 *
 * Pins the four blocks the Inbox row's triage strip exposes
 * (project-type chip, discipline chips, severity rollup pill,
 * applicant-history pill + hovercard) and the graceful-degrade
 * paths when the corresponding wire field is absent. The strip is
 * a leaf component with no React Query usage so we mount it
 * directly without the engagementPageMocks scaffolding.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, within, cleanup } from "@testing-library/react";
import type {
  ApplicantHistory,
  ReviewerSeverityRollup,
  SubmissionClassification,
} from "@workspace/api-client-react";
import { ReviewerQueueTriageStrip } from "../ReviewerQueueTriageStrip";

const baseClassification: SubmissionClassification = {
  submissionId: "sub-1",
  projectType: "single-family-residence",
  disciplines: ["electrical", "fire-life-safety"],
  applicableCodeBooks: ["IBC 2021", "NEC 2020"],
  confidence: 0.9,
  source: "auto",
  classifiedAt: "2026-05-01T12:00:00Z",
  classifiedBy: null,
};

beforeEach(() => {
  cleanup();
});

describe("ReviewerQueueTriageStrip", () => {
  describe("classification chips", () => {
    it("renders the project-type chip and one badge per discipline", () => {
      render(
        <ReviewerQueueTriageStrip
          classification={baseClassification}
        />,
      );
      expect(
        screen.getByTestId("reviewer-queue-triage-project-type"),
      ).toHaveTextContent("single-family-residence");
      expect(
        screen.getByTestId("reviewer-queue-triage-discipline-electrical"),
      ).toHaveTextContent("Electrical");
      expect(
        screen.getByTestId(
          "reviewer-queue-triage-discipline-fire-life-safety",
        ),
      ).toHaveTextContent("Fire/Life Safety");
    });

    it("renders no classification block when classification is null", () => {
      render(<ReviewerQueueTriageStrip classification={null} />);
      expect(
        screen.queryByTestId("reviewer-queue-triage-project-type"),
      ).not.toBeInTheDocument();
    });
  });

  describe("severity rollup pill", () => {
    it("renders the no-findings copy when total is 0", () => {
      const rollup: ReviewerSeverityRollup = {
        blockers: 0,
        concerns: 0,
        advisory: 0,
        total: 0,
      };
      render(<ReviewerQueueTriageStrip severityRollup={rollup} />);
      const pill = screen.getByTestId("reviewer-queue-triage-severity");
      expect(pill).toHaveTextContent("No findings yet");
      expect(pill).toHaveAttribute("data-rollup-total", "0");
    });

    it("formats balanced counts with pluralization", () => {
      const rollup: ReviewerSeverityRollup = {
        blockers: 3,
        concerns: 7,
        advisory: 2,
        total: 12,
      };
      render(<ReviewerQueueTriageStrip severityRollup={rollup} />);
      expect(
        screen.getByTestId("reviewer-queue-triage-severity"),
      ).toHaveTextContent(
        "12 findings: 3 blockers, 7 concerns, 2 advisory",
      );
    });

    it("singularizes blockers / concerns when exactly 1", () => {
      const rollup: ReviewerSeverityRollup = {
        blockers: 1,
        concerns: 1,
        advisory: 0,
        total: 2,
      };
      render(<ReviewerQueueTriageStrip severityRollup={rollup} />);
      expect(
        screen.getByTestId("reviewer-queue-triage-severity"),
      ).toHaveTextContent(
        "2 findings: 1 blocker, 1 concern",
      );
    });

    it("drops zero-count buckets from the suffix (advisory-only renders cyan)", () => {
      const rollup: ReviewerSeverityRollup = {
        blockers: 0,
        concerns: 0,
        advisory: 3,
        total: 3,
      };
      render(<ReviewerQueueTriageStrip severityRollup={rollup} />);
      const pill = screen.getByTestId("reviewer-queue-triage-severity");
      // No leading "0 blockers" — only the non-zero advisory bucket.
      expect(pill.textContent).toBe("3 findings: 3 advisory");
      // Advisory-only reads cyan; blocker-heavy/concern-heavy pick
      // the danger / warning palette respectively.
      expect(pill.classList.contains("sc-pill-cyan")).toBe(true);
    });

    it("colors the pill red when blockers exist", () => {
      const rollup: ReviewerSeverityRollup = {
        blockers: 1,
        concerns: 0,
        advisory: 0,
        total: 1,
      };
      render(<ReviewerQueueTriageStrip severityRollup={rollup} />);
      const pill = screen.getByTestId("reviewer-queue-triage-severity");
      expect(pill.classList.contains("sc-pill-red")).toBe(true);
    });
  });

  describe("applicant-history pill", () => {
    it("renders 'First submission' copy when totalPrior is 0 (no hovercard)", () => {
      const history: ApplicantHistory = {
        totalPrior: 0,
        approved: 0,
        returned: 0,
        lastReturnReason: null,
        priorSubmissions: [],
      };
      render(<ReviewerQueueTriageStrip applicantHistory={history} />);
      const pill = screen.getByTestId(
        "reviewer-queue-triage-applicant-history",
      );
      expect(pill).toHaveTextContent("First submission from this applicant");
      // No hovercard wrapper — the trigger renders bare so focus
      // doesn't trap on an empty popover.
      expect(
        screen.queryByTestId(
          "reviewer-queue-triage-applicant-history-card",
        ),
      ).not.toBeInTheDocument();
    });

    it("renders the prior counts pill with a hovercard listing the prior submissions", () => {
      const history: ApplicantHistory = {
        totalPrior: 3,
        approved: 2,
        returned: 1,
        lastReturnReason: "Missing electrical riser detail on sheet E-201",
        priorSubmissions: [
          {
            submissionId: "sub-prev-1",
            engagementName: "Lost Pines Townhomes",
            submittedAt: "2026-04-20T12:00:00Z",
            verdict: "approved",
          },
          {
            submissionId: "sub-prev-2",
            engagementName: "Highland Estates Lot 7",
            submittedAt: "2026-03-10T12:00:00Z",
            verdict: "returned",
            returnReason: "Missing electrical riser detail on sheet E-201",
          },
        ],
      };
      render(<ReviewerQueueTriageStrip applicantHistory={history} />);
      const pill = screen.getByTestId(
        "reviewer-queue-triage-applicant-history",
      );
      expect(pill).toHaveTextContent(
        "3 prior · 2 approved · 1 returned",
      );
      // Hovercard starts closed — hover the wrapping span to open.
      const card = screen.getByTestId(
        "reviewer-queue-triage-applicant-history-card",
      );
      expect(card).toHaveAttribute("data-open", "false");
      fireEvent.mouseEnter(card);
      expect(card).toHaveAttribute("data-open", "true");
      const list = screen.getByTestId(
        "reviewer-queue-triage-applicant-history-list",
      );
      expect(
        within(list).getByTestId(
          "reviewer-queue-triage-applicant-history-row-sub-prev-1",
        ),
      ).toHaveTextContent("Lost Pines Townhomes");
      // Verdict pill reads 'approved' / 'returned' verbatim.
      const returnedRow = within(list).getByTestId(
        "reviewer-queue-triage-applicant-history-row-sub-prev-2",
      );
      expect(returnedRow).toHaveTextContent("returned");
      // Returned rows surface their truncated returnReason inline.
      expect(returnedRow).toHaveTextContent(
        "Missing electrical riser detail on sheet E-201",
      );
    });
  });

  it("renders the empty container when none of the three blocks have data", () => {
    render(<ReviewerQueueTriageStrip />);
    const root = screen.getByTestId("reviewer-queue-triage");
    // No children render — the strip stays in the layout but
    // has nothing to surface.
    expect(root.children.length).toBe(0);
  });
});
