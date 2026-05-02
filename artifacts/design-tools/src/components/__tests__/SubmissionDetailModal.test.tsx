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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createQueryKeyStubs } from "@workspace/portal-ui/test-utils";

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
  useListSubmissionComments: () => ({ data: { comments: [] }, isLoading: false, isError: false }),
  useCreateSubmissionComment: () => ({ mutate: () => {}, isPending: false, isError: false }),
  // Task #382: shared query-key stub helper. The standard
  // `getGet*QueryKey` → `[<name without "get" prefix and "QueryKey"
  // suffix, lowered>, ...args]` shape matches what the modal expects.
  ...createQueryKeyStubs([
    "getGetAtomSummaryQueryKey",
    "getGetAtomHistoryQueryKey",
    "getListSubmissionCommentsQueryKey",
  ] as const),
}));

const { SubmissionDetailModal } = await import("../SubmissionDetailModal");

function setSummary(value: typeof hoisted.summary) {
  hoisted.summary = value;
}
function setHistory(value: typeof hoisted.history) {
  hoisted.history = value;
}

function renderModal(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
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

  it(
    "renders the STATUS HISTORY timeline (Task #93) with one row per " +
      "entry, attribution, and an optional note",
    () => {
      // Three-entry timeline: synthetic Pending seed, then a
      // corrections-requested transition with a note, then an
      // approved transition with no note. Mirrors what the server
      // builds in `submission.atom.ts`.
      setSummary({
        data: {
          prose: "x",
          typed: {
            id: "sub-1",
            found: true,
            submittedAt: "2026-04-30T12:00:00.000Z",
            statusHistory: [
              {
                status: "pending",
                occurredAt: "2026-04-30T12:00:00.000Z",
                actor: { kind: "user", id: "u_send", displayName: undefined },
                note: null,
                eventId: null,
              },
              {
                status: "corrections_requested",
                occurredAt: "2026-04-30T13:00:00.000Z",
                actor: {
                  kind: "user",
                  id: "u_reviewer",
                  displayName: "Jane Reviewer",
                },
                note: "Please clarify wall assemblies on A-101.",
                eventId: "01HZZZZ0000000000000000777",
              },
              {
                status: "approved",
                occurredAt: "2026-04-30T14:00:00.000Z",
                actor: { kind: "system", id: "submission-response" },
                note: null,
                eventId: "01HZZZZ0000000000000000778",
              },
            ],
          },
          keyMetrics: [],
          relatedAtoms: [],
          historyProvenance: {
            latestEventId: "",
            latestEventAt: "2026-04-30T14:00:00.000Z",
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

      const timeline = screen.getByTestId("submission-status-history");
      expect(timeline).toBeDefined();

      // Three entries, in the order the server provided.
      expect(
        screen.getByTestId("submission-status-history-entry-0"),
      ).toBeDefined();
      expect(
        screen.getByTestId("submission-status-history-entry-1"),
      ).toBeDefined();
      expect(
        screen.getByTestId("submission-status-history-entry-2"),
      ).toBeDefined();

      // Status labels per entry mirror the row badge palette.
      expect(
        screen.getByTestId("submission-status-history-status-0").textContent,
      ).toBe("Pending");
      expect(
        screen.getByTestId("submission-status-history-status-1").textContent,
      ).toBe("Corrections requested");
      expect(
        screen.getByTestId("submission-status-history-status-2").textContent,
      ).toBe("Approved");

      // Note row is only rendered when present.
      expect(
        screen.getByTestId("submission-status-history-note-1").textContent,
      ).toContain("Please clarify wall assemblies");
      expect(
        screen.queryByTestId("submission-status-history-note-0"),
      ).toBeNull();
      expect(
        screen.queryByTestId("submission-status-history-note-2"),
      ).toBeNull();
    },
  );

  it(
    "STATUS HISTORY shows the empty-state copy when statusHistory is " +
      "absent on the typed payload",
    () => {
      setSummary({
        data: {
          prose: "x",
          typed: {
            id: "sub-1",
            found: true,
            submittedAt: "2026-04-30T12:00:00.000Z",
            // No statusHistory at all — older atom server, history
            // outage, etc. Modal must not crash and must show a
            // hint instead of an empty container.
          },
          keyMetrics: [],
          relatedAtoms: [],
          historyProvenance: {
            latestEventId: "",
            latestEventAt: "2026-04-30T12:00:00.000Z",
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

      expect(
        screen.getByTestId("submission-status-history-empty"),
      ).toBeDefined();
      expect(screen.queryByTestId("submission-status-history")).toBeNull();
    },
  );

  it(
    "STATUS HISTORY shows the loading placeholder when the summary " +
      "is refetching and no entries are cached yet (Task #143)",
    () => {
      // The populated and empty branches of `StatusHistoryBlock` are
      // covered above (Task #93 + the empty-state spec). This test
      // pins the third branch — `loading && entries.length === 0` —
      // so a future refactor that always falls through to the
      // empty-state copy (or leaves the placeholder up forever)
      // fails here before reviewers ever see a stuck "Loading status
      // history…" message in the modal.
      //
      // Realistic shape: React Query is mid-refetch (`isLoading: true`)
      // but already has a cached `data` payload whose typed body
      // exists with `found: true` and no `statusHistory` yet — for
      // example, the cache was hydrated from an older atom server
      // version that didn't yet return the field, and we're refetching
      // for the new shape. Setting both `isLoading` and `data` is
      // also the only way to get the modal to render the
      // `StatusHistoryBlock` at all (the surrounding panel is gated
      // on `summary && typed.found !== false`), so this combination
      // is what actually exercises the loading branch.
      setSummary({
        isLoading: true,
        data: {
          prose: "x",
          typed: {
            id: "sub-1",
            found: true,
            submittedAt: "2026-04-30T12:00:00.000Z",
            // No statusHistory yet — the placeholder branch only
            // fires when the entries array is empty.
          },
          keyMetrics: [],
          relatedAtoms: [],
          historyProvenance: {
            latestEventId: "",
            latestEventAt: "2026-04-30T12:00:00.000Z",
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

      // The loading placeholder is rendered with the expected copy.
      const placeholder = screen.getByTestId(
        "submission-status-history-loading",
      );
      expect(placeholder.textContent).toContain("Loading status history");

      // Crucially, neither the empty-state hint nor the populated
      // timeline rendered — the loading branch is exclusive. Without
      // these guards a regression that always returns the empty-state
      // copy (or always renders an empty timeline container) would
      // still pass the placeholder assertion above.
      expect(
        screen.queryByTestId("submission-status-history-empty"),
      ).toBeNull();
      expect(screen.queryByTestId("submission-status-history")).toBeNull();
    },
  );

  it(
    "STATUS HISTORY appends a new row each time a response is recorded " +
      "(Task #131)",
    () => {
      // The existing Task #93 spec proves that a fully-populated
      // statusHistory renders correctly in a single pass. This test
      // proves the *update* contract that the response dialog +
      // query-cache invalidation rely on: when the submission atom
      // refetches and `typed.statusHistory` grows by one entry, the
      // timeline appends a row in place — preserving the previously
      // rendered rows (their testids, status labels, actor labels,
      // and notes), and surfacing the new row's status, actor, and
      // optional note. A future refactor that re-keys, re-orders, or
      // virtualises the timeline will fail here before it can break
      // the e2e suite.

      // Initial state: only the synthetic Pending seed is on the
      // timeline — the package was sent, no response has been
      // recorded yet.
      setSummary({
        data: {
          prose: "x",
          typed: {
            id: "sub-1",
            found: true,
            submittedAt: "2026-04-30T12:00:00.000Z",
            statusHistory: [
              {
                status: "pending",
                occurredAt: "2026-04-30T12:00:00.000Z",
                actor: {
                  kind: "user",
                  id: "u_send",
                  displayName: "Sam Sender",
                },
                note: null,
                eventId: null,
              },
            ],
          },
          keyMetrics: [],
          relatedAtoms: [],
          historyProvenance: {
            latestEventId: "",
            latestEventAt: "2026-04-30T12:00:00.000Z",
          },
          scopeFiltered: false,
        },
      });
      setHistory({ data: { events: [] } });

      const { rerender } = renderModal(
        <SubmissionDetailModal
          submissionId="sub-1"
          engagementId="eng-1"
          onClose={() => {}}
        />,
      );

      // Only the seed row is on screen at first.
      expect(
        screen.getByTestId("submission-status-history-entry-0"),
      ).toBeDefined();
      expect(
        screen.queryByTestId("submission-status-history-entry-1"),
      ).toBeNull();
      expect(
        screen.getByTestId("submission-status-history-status-0").textContent,
      ).toBe("Pending");
      expect(
        screen.getByTestId("submission-status-history-actor-0").textContent,
      ).toContain("Sam Sender");

      // Reviewer records a "corrections requested" response. The
      // RecordSubmissionResponseDialog test pins the cache
      // invalidation; here we simulate the resulting refetch by
      // updating the mocked summary and rerendering the modal.
      setSummary({
        data: {
          prose: "x",
          typed: {
            id: "sub-1",
            found: true,
            submittedAt: "2026-04-30T12:00:00.000Z",
            statusHistory: [
              {
                status: "pending",
                occurredAt: "2026-04-30T12:00:00.000Z",
                actor: {
                  kind: "user",
                  id: "u_send",
                  displayName: "Sam Sender",
                },
                note: null,
                eventId: null,
              },
              {
                status: "corrections_requested",
                occurredAt: "2026-04-30T13:00:00.000Z",
                actor: {
                  kind: "user",
                  id: "u_reviewer",
                  displayName: "Jane Reviewer",
                },
                note: "Please clarify wall assemblies on A-101.",
                eventId: "01HZZZZ0000000000000000777",
              },
            ],
          },
          keyMetrics: [],
          relatedAtoms: [],
          historyProvenance: {
            latestEventId: "",
            latestEventAt: "2026-04-30T13:00:00.000Z",
          },
          scopeFiltered: false,
        },
      });
      rerender(
        <SubmissionDetailModal
          submissionId="sub-1"
          engagementId="eng-1"
          onClose={() => {}}
        />,
      );

      // The seed row is still rendered — the timeline appended,
      // not replaced.
      expect(
        screen.getByTestId("submission-status-history-entry-0"),
      ).toBeDefined();
      expect(
        screen.getByTestId("submission-status-history-status-0").textContent,
      ).toBe("Pending");
      // The new row is rendered with status, actor, and note.
      expect(
        screen.getByTestId("submission-status-history-entry-1"),
      ).toBeDefined();
      expect(
        screen.getByTestId("submission-status-history-status-1").textContent,
      ).toBe("Corrections requested");
      expect(
        screen.getByTestId("submission-status-history-actor-1").textContent,
      ).toContain("Jane Reviewer");
      expect(
        screen.getByTestId("submission-status-history-note-1").textContent,
      ).toContain("Please clarify wall assemblies");

      // A second response — Approved — lands. The timeline appends
      // again. The Approved row has no note, so the optional note
      // testid must be absent on that row while remaining present
      // on the previous one.
      setSummary({
        data: {
          prose: "x",
          typed: {
            id: "sub-1",
            found: true,
            submittedAt: "2026-04-30T12:00:00.000Z",
            statusHistory: [
              {
                status: "pending",
                occurredAt: "2026-04-30T12:00:00.000Z",
                actor: {
                  kind: "user",
                  id: "u_send",
                  displayName: "Sam Sender",
                },
                note: null,
                eventId: null,
              },
              {
                status: "corrections_requested",
                occurredAt: "2026-04-30T13:00:00.000Z",
                actor: {
                  kind: "user",
                  id: "u_reviewer",
                  displayName: "Jane Reviewer",
                },
                note: "Please clarify wall assemblies on A-101.",
                eventId: "01HZZZZ0000000000000000777",
              },
              {
                status: "approved",
                occurredAt: "2026-04-30T14:00:00.000Z",
                actor: { kind: "system", id: "submission-response" },
                note: null,
                eventId: "01HZZZZ0000000000000000778",
              },
            ],
          },
          keyMetrics: [],
          relatedAtoms: [],
          historyProvenance: {
            latestEventId: "",
            latestEventAt: "2026-04-30T14:00:00.000Z",
          },
          scopeFiltered: false,
        },
      });
      rerender(
        <SubmissionDetailModal
          submissionId="sub-1"
          engagementId="eng-1"
          onClose={() => {}}
        />,
      );

      expect(
        screen.getByTestId("submission-status-history-entry-2"),
      ).toBeDefined();
      expect(
        screen.getByTestId("submission-status-history-status-2").textContent,
      ).toBe("Approved");
      // Task #270: known system / agent actor ids resolve to a
      // friendly label via the shared `friendlyAgentLabel` helper
      // instead of leaking the raw `system:submission-response`
      // identifier into the audit row. Unknown ids still fall back
      // to the historical "kind:id" convention from SheetCard.
      expect(
        screen.getByTestId("submission-status-history-actor-2").textContent,
      ).toContain("Submission response");
      expect(
        screen.getByTestId("submission-status-history-actor-2").textContent,
      ).not.toContain("system:submission-response");
      // The new row has no note, so the optional note row must
      // be absent. The previous row's note must still be present.
      expect(
        screen.queryByTestId("submission-status-history-note-2"),
      ).toBeNull();
      expect(
        screen.getByTestId("submission-status-history-note-1").textContent,
      ).toContain("Please clarify wall assemblies");

      // The earlier rows are preserved (testids and labels) across
      // the second response — the timeline grew, it didn't reset.
      expect(
        screen.getByTestId("submission-status-history-status-0").textContent,
      ).toBe("Pending");
      expect(
        screen.getByTestId("submission-status-history-status-1").textContent,
      ).toBe("Corrections requested");
    },
  );

  it("renders the reviewer comment inline when present", () => {
    setSummary({
      data: {
        prose: "x",
        typed: {
          id: "sub-1",
          found: true,
          submittedAt: "2026-04-30T12:00:00.000Z",
          note: "Permit set v2.",
          status: "corrections_requested",
          reviewerComment: "Update egress widths on A2.04 and resubmit.",
          respondedAt: "2026-04-30T13:00:00.000Z",
          responseRecordedAt: "2026-04-30T13:00:00.000Z",
        },
        keyMetrics: [],
        relatedAtoms: [],
        historyProvenance: {
          latestEventId: "",
          latestEventAt: "2026-04-30T13:00:00.000Z",
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

    const comment = screen.getByTestId("submission-reviewer-comment-sub-1");
    expect(comment.textContent).toContain("Update egress widths on A2.04");
    expect(
      screen.getByTestId("submission-detail-reviewer-responded-at")
        .textContent,
    ).toContain("Responded");
  });

  it("omits the reviewer comment section when none was recorded", () => {
    setSummary({
      data: {
        prose: "x",
        typed: {
          id: "sub-1",
          found: true,
          submittedAt: "2026-04-30T12:00:00.000Z",
          note: "Permit set v2.",
          status: "pending",
          reviewerComment: null,
          respondedAt: null,
        },
        keyMetrics: [],
        relatedAtoms: [],
        historyProvenance: {
          latestEventId: "",
          latestEventAt: "2026-04-30T12:00:00.000Z",
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

    expect(
      screen.queryByTestId("submission-reviewer-comment-sub-1"),
    ).toBeNull();
    expect(
      screen.queryByTestId("submission-detail-reviewer-responded-at"),
    ).toBeNull();
  });

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
