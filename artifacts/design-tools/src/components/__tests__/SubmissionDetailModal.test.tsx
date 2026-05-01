/**
 * SubmissionDetailModal — fast component tests for the per-submission
 * detail view opened from the engagement's Submissions tab (Task #84).
 *
 * The modal is "thin" — it reads two generated React-Query hooks and
 * renders fields from their results. So we mock @workspace/api-client-react
 * to deterministically control what each hook returns and assert that:
 *   - the modal shows nothing when `submissionId` is null,
 *   - the loading state renders while the summary fetch is in flight,
 *   - the full note, jurisdiction snapshot (city/state/FIPS), and the
 *     related `engagement.submitted` event (id + actor) are surfaced
 *     once the summary + engagement-history fetches resolve,
 *   - a `typed.found: false` summary degrades to the not-found prose
 *     instead of rendering the structured fields,
 *   - the related-event panel falls back to the row's `submittedAt`
 *     when no audit event is available (empty `latestEventId`),
 *   - the close button calls `onClose`.
 *
 * Mirrors the mocking pattern in `SubmitToJurisdictionDialog.test.tsx`
 * (`vi.hoisted` shared state + a mock module that returns deterministic
 * shapes from the hooks).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
} from "@testing-library/react";
import type { ReactNode } from "react";

const hoisted = vi.hoisted(() => {
  return {
    summary: null as null | {
      data?: unknown;
      isLoading?: boolean;
      isError?: boolean;
    },
    history: null as null | {
      data?: unknown;
      isLoading?: boolean;
      isError?: boolean;
    },
  };
});

vi.mock("@workspace/api-client-react", () => ({
  useGetAtomSummary: () => hoisted.summary ?? { isLoading: true },
  useGetAtomHistory: () => hoisted.history ?? { isLoading: true },
  getGetAtomSummaryQueryKey: (slug: string, id: string) => [
    "getAtomSummary",
    slug,
    id,
  ],
  getGetAtomHistoryQueryKey: (slug: string, id: string, params: unknown) => [
    "getAtomHistory",
    slug,
    id,
    params,
  ],
}));

const { SubmissionDetailModal } = await import("../SubmissionDetailModal");

function setSummary(value: typeof hoisted.summary) {
  hoisted.summary = value;
}
function setHistory(value: typeof hoisted.history) {
  hoisted.history = value;
}

function renderModal(node: ReactNode) {
  return render(<>{node}</>);
}

beforeEach(() => {
  hoisted.summary = null;
  hoisted.history = null;
});

afterEach(() => {
  cleanup();
});

describe("SubmissionDetailModal", () => {
  it("renders nothing when submissionId is null", () => {
    const { container } = renderModal(
      <SubmissionDetailModal
        submissionId={null}
        engagementId="eng-1"
        onClose={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the loading state while the summary fetch is pending", () => {
    setSummary({ isLoading: true });
    setHistory({ isLoading: true });
    renderModal(
      <SubmissionDetailModal
        submissionId="sub-1"
        engagementId="eng-1"
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId("submission-detail-loading")).toBeDefined();
  });

  it(
    "surfaces the full note, jurisdiction snapshot, and the related " +
      "engagement.submitted event with hydrated actor",
    () => {
      const matchedEventId = "01HZZZZ0000000000000000001";
      setSummary({
        data: {
          prose: "Plan-review submission to Moab, UT…",
          typed: {
            id: "sub-1",
            found: true,
            engagementId: "eng-1",
            jurisdiction: "Moab, UT",
            jurisdictionCity: "Moab",
            jurisdictionState: "UT",
            jurisdictionFips: "4950150",
            note:
              "Permit set v1. Cover sheet finalized.\nAll structural " +
              "details cross-referenced.",
            submittedAt: "2026-04-30T12:34:56.000Z",
            createdAt: "2026-04-30T12:34:56.000Z",
          },
          keyMetrics: [],
          relatedAtoms: [],
          historyProvenance: {
            latestEventId: matchedEventId,
            latestEventAt: "2026-04-30T12:34:57.000Z",
          },
          scopeFiltered: false,
        },
      });
      setHistory({
        data: {
          events: [
            {
              id: "01HZZZZ0000000000000000999",
              eventType: "engagement.geocoded",
              actor: { kind: "system", id: "geocoder" },
              occurredAt: "2026-04-29T00:00:00.000Z",
              recordedAt: "2026-04-29T00:00:00.000Z",
            },
            {
              id: matchedEventId,
              eventType: "engagement.submitted",
              actor: {
                kind: "user",
                id: "u_jane",
                displayName: "Jane Reviewer",
              },
              occurredAt: "2026-04-30T12:34:57.000Z",
              recordedAt: "2026-04-30T12:34:57.000Z",
            },
          ],
        },
      });

      renderModal(
        <SubmissionDetailModal
          submissionId="sub-1"
          engagementId="eng-1"
          onClose={() => {}}
        />,
      );

      // Full (multi-line) note is rendered verbatim.
      const note = screen.getByTestId("submission-detail-note");
      expect(note.textContent).toContain("Permit set v1");
      expect(note.textContent).toContain("structural details");

      // Jurisdiction snapshot rows.
      expect(screen.getByText("Moab, UT")).toBeDefined();
      expect(screen.getByText("Moab")).toBeDefined();
      expect(screen.getByText("UT")).toBeDefined();
      expect(screen.getByText("4950150")).toBeDefined();

      // Related-event panel hydrated with actor + event id.
      const event = screen.getByTestId("submission-detail-event");
      expect(event.textContent).toContain("engagement.submitted");
      expect(event.textContent).toContain("Jane Reviewer");
      expect(event.textContent).toContain(matchedEventId);
    },
  );

  it("falls back to the row's submittedAt when no audit event exists", () => {
    setSummary({
      data: {
        prose: "Plan-review submission to Moab, UT…",
        typed: {
          id: "sub-1",
          found: true,
          jurisdiction: "Moab, UT",
          jurisdictionCity: "Moab",
          jurisdictionState: "UT",
          jurisdictionFips: null,
          note: "No event recorded yet.",
          submittedAt: "2026-04-30T12:34:56.000Z",
        },
        keyMetrics: [],
        relatedAtoms: [],
        historyProvenance: {
          latestEventId: "",
          latestEventAt: "2026-04-30T12:34:56.000Z",
        },
        scopeFiltered: false,
      },
    });
    setHistory({ data: { events: [] } });

    renderModal(
      <SubmissionDetailModal
        submissionId="sub-1"
        engagementId="eng-1"
        onClose={() => {}}
      />,
    );

    expect(screen.getByTestId("submission-detail-event-missing")).toBeDefined();
  });

  it("renders the not-found prose when typed.found is false", () => {
    setSummary({
      data: {
        prose: "Submission sub-zzz could not be found.",
        typed: { id: "sub-zzz", found: false },
        keyMetrics: [],
        relatedAtoms: [],
        historyProvenance: { latestEventId: "", latestEventAt: "" },
        scopeFiltered: false,
      },
    });
    setHistory({ data: { events: [] } });

    renderModal(
      <SubmissionDetailModal
        submissionId="sub-zzz"
        engagementId="eng-1"
        onClose={() => {}}
      />,
    );

    const missing = screen.getByTestId("submission-detail-missing");
    expect(missing.textContent).toContain("could not be found");
    // The structured panels must NOT render when the row is missing.
    expect(screen.queryByTestId("submission-detail-note")).toBeNull();
    expect(screen.queryByTestId("submission-detail-event")).toBeNull();
  });

  it(
    "renders the backfill annotation when responseRecordedAt is " +
      "meaningfully later than respondedAt (Task #123)",
    () => {
      // Reply landed on 4/10, recorded into the system on 4/15 — well
      // beyond the 1-hour threshold pinned in submissionBackfill.ts, so
      // the modal should surface the same "backfilled on <date>" cue
      // the engagement timeline already shows on the row itself.
      const respondedAt = "2026-04-10T14:30:00.000Z";
      const responseRecordedAt = "2026-04-15T09:00:00.000Z";
      setSummary({
        data: {
          prose: "Plan-review submission to Moab, UT…",
          typed: {
            id: "sub-1",
            found: true,
            engagementId: "eng-1",
            jurisdiction: "Moab, UT",
            jurisdictionCity: "Moab",
            jurisdictionState: "UT",
            jurisdictionFips: "4950150",
            note: "n",
            submittedAt: "2026-04-09T12:00:00.000Z",
            status: "approved",
            reviewerComment: null,
            respondedAt,
            responseRecordedAt,
          },
          keyMetrics: [],
          relatedAtoms: [],
          historyProvenance: {
            latestEventId: "",
            latestEventAt: "2026-04-09T12:00:00.000Z",
          },
          scopeFiltered: false,
        },
      });
      setHistory({ data: { events: [] } });

      renderModal(
        <SubmissionDetailModal
          submissionId="sub-1"
          engagementId="eng-1"
          onClose={() => {}}
        />,
      );

      // Pin both the testid hook (so the timeline + modal stay in
      // sync as one shared annotation surface) and the rendered copy
      // — the date is locale-formatted via `toLocaleDateString()` so
      // we assert the prefix and the recorded date string for a
      // timezone-independent check.
      const annotation = screen.getByTestId("submission-detail-backfill");
      const expectedDate = new Date(responseRecordedAt).toLocaleDateString();
      expect(annotation.textContent).toBe(`backfilled on ${expectedDate}`);
    },
  );

  it(
    "does not render the backfill annotation for a live recording " +
      "(responseRecordedAt within the threshold)",
    () => {
      // 30 minutes between reply and recording — below the 1-hour
      // threshold, so the modal should NOT surface the annotation.
      // Pinning the absence here guards against a future helper tweak
      // accidentally flipping live rows to backfilled.
      setSummary({
        data: {
          prose: "Plan-review submission to Moab, UT…",
          typed: {
            id: "sub-1",
            found: true,
            engagementId: "eng-1",
            jurisdiction: "Moab, UT",
            jurisdictionCity: "Moab",
            jurisdictionState: "UT",
            jurisdictionFips: "4950150",
            note: "n",
            submittedAt: "2026-04-15T09:00:00.000Z",
            status: "approved",
            reviewerComment: null,
            respondedAt: "2026-04-15T10:00:00.000Z",
            responseRecordedAt: "2026-04-15T10:30:00.000Z",
          },
          keyMetrics: [],
          relatedAtoms: [],
          historyProvenance: {
            latestEventId: "",
            latestEventAt: "2026-04-15T09:00:00.000Z",
          },
          scopeFiltered: false,
        },
      });
      setHistory({ data: { events: [] } });

      renderModal(
        <SubmissionDetailModal
          submissionId="sub-1"
          engagementId="eng-1"
          onClose={() => {}}
        />,
      );

      expect(screen.queryByTestId("submission-detail-backfill")).toBeNull();
    },
  );

  it("calls onClose when the close button is pressed", () => {
    setSummary({
      data: {
        prose: "x",
        typed: { id: "sub-1", found: true, submittedAt: "2026-04-30T00:00:00.000Z" },
        keyMetrics: [],
        relatedAtoms: [],
        historyProvenance: { latestEventId: "", latestEventAt: "2026-04-30T00:00:00.000Z" },
        scopeFiltered: false,
      },
    });
    setHistory({ data: { events: [] } });

    const onClose = vi.fn();
    renderModal(
      <SubmissionDetailModal
        submissionId="sub-1"
        engagementId="eng-1"
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByTestId("submission-detail-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
