/**
 * ReviewerRequestsStrip + DismissReviewerRequestDialog — Wave 2
 * Sprint D / V1-2 / Task #423.
 *
 * Coverage:
 *   - Strip is self-hiding when the queue is empty.
 *   - Strip renders one row per pending request with the right
 *     kind label, requested-by displayName, and reason verbatim.
 *   - "Dismiss" opens DismissReviewerRequestDialog scoped to the
 *     clicked request; submitting the dialog calls the generated
 *     `useDismissReviewerRequest` mutation with the right body shape.
 *   - The 409 already-resolved error surfaces inline.
 *   - Optimistic dismiss: `onMutate` rewrites the cache so the row
 *     disappears immediately; on success the strip flashes a
 *     "Request dismissed" pill.
 *   - Error rollback: when the mutation `onError` fires, the
 *     optimistic snapshot is restored (the row is back) and the
 *     dialog stays open with the inline error message.
 *   - Implicit-resolve indicator: when the polled list shrinks
 *     because the backend resolved a request (the architect ran the
 *     underlying domain action elsewhere), the strip flashes a
 *     "1 request resolved by your refresh" pill.
 *   - The implicit-resolve pill does NOT fire for rows the architect
 *     just dismissed in-strip (no double-counting between the
 *     "dismissed" and "resolved by your refresh" affordances).
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";

const hoisted = vi.hoisted(() => ({
  listData: undefined as
    | { requests: Array<Record<string, unknown>> }
    | undefined,
  listIsLoading: false,
  dismissedListData: { requests: [] } as
    | { requests: Array<Record<string, unknown>> }
    | undefined,
  dismissedIsLoading: false,
  resolvedListData: { requests: [] } as
    | { requests: Array<Record<string, unknown>> }
    | undefined,
  resolvedIsLoading: false,
  dismissMutate: vi.fn(),
  dismissIsPending: false,
  dismissOnMutate: undefined as
    | ((vars: { id: string; data: { dismissalReason: string } }) =>
        | Promise<unknown>
        | unknown)
    | undefined,
  dismissOnSuccess: undefined as
    | ((response: { request: unknown }) => void)
    | undefined,
  dismissOnError: undefined as
    | ((err: unknown, vars: unknown, context: unknown) => void)
    | undefined,
}));

class MockApiError extends Error {
  status: number;
  data: unknown;
  constructor(status: number, data?: unknown) {
    super(`MockApiError ${status}`);
    this.status = status;
    this.data = data ?? {};
  }
}

vi.mock("@workspace/api-client-react", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/api-client-react")>(
      "@workspace/api-client-react",
    );
  return {
    ...actual,
    ApiError: MockApiError,
    useListEngagementReviewerRequests: (
      _engagementId: string,
      params?: { status?: string },
    ) => {
      const status = params?.status;
      if (status === "dismissed") {
        return {
          data: hoisted.dismissedListData,
          isLoading: hoisted.dismissedIsLoading,
          isError: false,
        };
      }
      if (status === "resolved") {
        return {
          data: hoisted.resolvedListData,
          isLoading: hoisted.resolvedIsLoading,
          isError: false,
        };
      }
      return {
        data: hoisted.listData,
        isLoading: hoisted.listIsLoading,
        isError: false,
      };
    },
    useDismissReviewerRequest: (opts?: {
      mutation?: {
        onMutate?: (vars: {
          id: string;
          data: { dismissalReason: string };
        }) => Promise<unknown> | unknown;
        onSuccess?: (response: { request: unknown }) => void;
        onError?: (err: unknown, vars: unknown, context: unknown) => void;
      };
    }) => {
      hoisted.dismissOnMutate = opts?.mutation?.onMutate;
      hoisted.dismissOnSuccess = opts?.mutation?.onSuccess;
      hoisted.dismissOnError = opts?.mutation?.onError;
      return {
        mutate: hoisted.dismissMutate,
        isPending: hoisted.dismissIsPending,
      };
    },
    getListEngagementReviewerRequestsQueryKey: (
      id: string,
      params?: { status?: string },
    ) => {
      // Mirror Orval's "key the params object too" shape so the
      // strip's snapshot/restore round-trip writes against the same
      // key the query consumer reads from.
      const base: unknown[] = ["listEngagementReviewerRequests", id];
      if (params) base.push(params);
      return base;
    },
    getGetAtomHistoryQueryKey: (entityType: string, entityId: string) => [
      "getAtomHistory",
      entityType,
      entityId,
    ],
  };
});

const { ReviewerRequestsStrip, ReviewerRequestsHistory } = await import(
  "../ReviewerRequestsStrip"
);

function withQuery(node: ReactNode): { ui: ReactNode; client: QueryClient } {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return {
    ui: <QueryClientProvider client={client}>{node}</QueryClientProvider>,
    client,
  };
}

/**
 * Stateful harness that exposes a `bump()` callback through the
 * supplied ref. Lets a test force a re-render of the strip after
 * mutating `hoisted.listData` so the mocked
 * `useListEngagementReviewerRequests` re-reads the new shape — the
 * implicit-resolve diff fires off a fresh data tick, not off a JSX
 * identity change, so we need a real React state nudge to drive it.
 */
function HarnessedStrip({
  bumpRef,
  engagementId,
}: {
  bumpRef: { current: () => void };
  engagementId: string;
}) {
  const [, setTick] = useState(0);
  bumpRef.current = () => setTick((n) => n + 1);
  return <ReviewerRequestsStrip engagementId={engagementId} />;
}

const STABLE_REQUEST = {
  id: "req-1",
  engagementId: "eng-123",
  requestKind: "refresh-briefing-source" as const,
  targetEntityType: "briefing-source" as const,
  targetEntityId: "src-uuid-1",
  reason: "Source PDF appears outdated.",
  status: "pending" as const,
  requestedBy: {
    kind: "user" as const,
    id: "reviewer-1",
    displayName: "Alex Reviewer",
  },
  requestedAt: new Date("2026-04-30T12:00:00Z").toISOString(),
  dismissedBy: null,
  dismissedAt: null,
  dismissalReason: null,
  resolvedAt: null,
  triggeredActionEventId: null,
  createdAt: new Date("2026-04-30T12:00:00Z").toISOString(),
  updatedAt: new Date("2026-04-30T12:00:00Z").toISOString(),
};

const SECOND_REQUEST = {
  ...STABLE_REQUEST,
  id: "req-2",
  requestKind: "regenerate-briefing" as const,
  targetEntityType: "briefing" as const,
  targetEntityId: "brief-uuid-1",
  reason: "Tone is off-brand on page 3.",
};

describe("ReviewerRequestsStrip", () => {
  beforeEach(() => {
    hoisted.listData = undefined;
    hoisted.listIsLoading = false;
    hoisted.dismissedListData = { requests: [] };
    hoisted.dismissedIsLoading = false;
    hoisted.resolvedListData = { requests: [] };
    hoisted.resolvedIsLoading = false;
    hoisted.dismissMutate.mockReset();
    hoisted.dismissIsPending = false;
    hoisted.dismissOnMutate = undefined;
    hoisted.dismissOnSuccess = undefined;
    hoisted.dismissOnError = undefined;
  });
  afterEach(() => cleanup());

  it("renders nothing when the pending queue is empty", () => {
    hoisted.listData = { requests: [] };
    const { ui } = withQuery(<ReviewerRequestsStrip engagementId="eng-123" />);
    render(ui);
    expect(screen.queryByTestId("reviewer-requests-strip")).toBeNull();
  });

  it("renders one row per pending request", () => {
    hoisted.listData = { requests: [STABLE_REQUEST] };
    const { ui } = withQuery(<ReviewerRequestsStrip engagementId="eng-123" />);
    render(ui);
    expect(screen.getByTestId("reviewer-requests-strip")).toBeInTheDocument();
    expect(screen.getByTestId("reviewer-requests-strip-count")).toHaveTextContent(
      "1 pending",
    );
    expect(
      screen.getByTestId("reviewer-request-row-req-1"),
    ).toBeInTheDocument();
    expect(screen.getByText("Refresh briefing source")).toBeInTheDocument();
    expect(
      screen.getByTestId("reviewer-request-reason-req-1"),
    ).toHaveTextContent("Source PDF appears outdated.");
    // Requested-by uses displayName (via formatActorLabel).
    expect(screen.getByText("Alex Reviewer")).toBeInTheDocument();
  });

  it("opens the dismiss dialog scoped to the clicked request", () => {
    hoisted.listData = { requests: [STABLE_REQUEST] };
    const { ui } = withQuery(<ReviewerRequestsStrip engagementId="eng-123" />);
    render(ui);
    fireEvent.click(screen.getByTestId("reviewer-request-dismiss-req-1"));
    const dialog = screen.getByTestId("dismiss-reviewer-request-dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute("data-request-id", "req-1");
    // Surfaces the original reviewer reason inside the dialog body.
    expect(
      screen.getByTestId("dismiss-reviewer-request-original-reason"),
    ).toHaveTextContent("Source PDF appears outdated.");
  });

  it("dismiss submission calls the mutation with the architect's reason", () => {
    hoisted.listData = { requests: [STABLE_REQUEST] };
    const { ui } = withQuery(<ReviewerRequestsStrip engagementId="eng-123" />);
    render(ui);
    fireEvent.click(screen.getByTestId("reviewer-request-dismiss-req-1"));
    fireEvent.change(
      screen.getByTestId("dismiss-reviewer-request-reason"),
      { target: { value: "Source is current." } },
    );
    fireEvent.click(screen.getByTestId("dismiss-reviewer-request-confirm"));
    expect(hoisted.dismissMutate).toHaveBeenCalledTimes(1);
    expect(hoisted.dismissMutate).toHaveBeenCalledWith({
      id: "req-1",
      data: { dismissalReason: "Source is current." },
    });
  });

  it("surfaces a 409 already-resolved error inline", async () => {
    hoisted.listData = { requests: [STABLE_REQUEST] };
    const { ui } = withQuery(<ReviewerRequestsStrip engagementId="eng-123" />);
    render(ui);
    fireEvent.click(screen.getByTestId("reviewer-request-dismiss-req-1"));
    fireEvent.change(
      screen.getByTestId("dismiss-reviewer-request-reason"),
      { target: { value: "no" } },
    );
    fireEvent.click(screen.getByTestId("dismiss-reviewer-request-confirm"));
    expect(hoisted.dismissOnError).toBeDefined();
    act(() => {
      hoisted.dismissOnError!(
        new MockApiError(409, {}),
        { id: "req-1", data: { dismissalReason: "no" } },
        undefined,
      );
    });
    const errMsg = await screen.findByTestId(
      "dismiss-reviewer-request-error",
    );
    expect(errMsg).toHaveTextContent(/already resolved/i);
  });

  it("optimistically removes the row from the pending-list cache and flashes a 'Request dismissed' pill on success", async () => {
    hoisted.listData = { requests: [STABLE_REQUEST, SECOND_REQUEST] };
    const { ui, client } = withQuery(
      <ReviewerRequestsStrip engagementId="eng-123" />,
    );
    // Seed the cache with the same shape the strip's hook will read
    // so onMutate's setQueryData has something to write over and
    // onError can roll back to.
    const queryKey = [
      "listEngagementReviewerRequests",
      "eng-123",
      { status: "pending" },
    ];
    client.setQueryData(queryKey, {
      requests: [STABLE_REQUEST, SECOND_REQUEST],
    });
    render(ui);

    fireEvent.click(screen.getByTestId("reviewer-request-dismiss-req-1"));
    fireEvent.change(
      screen.getByTestId("dismiss-reviewer-request-reason"),
      { target: { value: "Source is current — verified yesterday." } },
    );
    fireEvent.click(screen.getByTestId("dismiss-reviewer-request-confirm"));

    // The dialog wires `onMutate` for optimistic cache work — fire it
    // by hand the same way React Query would.
    expect(hoisted.dismissOnMutate).toBeDefined();
    let optimisticCtx: unknown;
    await act(async () => {
      optimisticCtx = await hoisted.dismissOnMutate!({
        id: "req-1",
        data: { dismissalReason: "Source is current — verified yesterday." },
      });
    });

    // Optimistic write: req-1 is gone from the seeded cache, req-2 stays.
    const after = client.getQueryData<{
      requests: Array<{ id: string }>;
    }>(queryKey);
    expect(after?.requests.map((r) => r.id)).toEqual(["req-2"]);

    // Settle as success — the strip flashes the "Request dismissed" pill.
    expect(hoisted.dismissOnSuccess).toBeDefined();
    await act(async () => {
      await hoisted.dismissOnSuccess!({
        request: { ...STABLE_REQUEST, status: "dismissed" },
      });
    });
    expect(
      screen.getByTestId("reviewer-requests-strip-pill-dismissed"),
    ).toHaveTextContent(/dismissed/i);

    // Sanity: the optimistic context surfaced both the queryKey + the
    // pre-mutate snapshot so an error rollback can restore exactly
    // what the user saw.
    expect(optimisticCtx).toBeTruthy();
  });

  it("rolls the cache back when the mutation errors so the row reappears in the strip", async () => {
    hoisted.listData = { requests: [STABLE_REQUEST, SECOND_REQUEST] };
    const { ui, client } = withQuery(
      <ReviewerRequestsStrip engagementId="eng-123" />,
    );
    const queryKey = [
      "listEngagementReviewerRequests",
      "eng-123",
      { status: "pending" },
    ];
    client.setQueryData(queryKey, {
      requests: [STABLE_REQUEST, SECOND_REQUEST],
    });
    render(ui);

    fireEvent.click(screen.getByTestId("reviewer-request-dismiss-req-1"));
    fireEvent.change(
      screen.getByTestId("dismiss-reviewer-request-reason"),
      { target: { value: "Out of scope." } },
    );
    fireEvent.click(screen.getByTestId("dismiss-reviewer-request-confirm"));

    let ctx: unknown;
    await act(async () => {
      ctx = await hoisted.dismissOnMutate!({
        id: "req-1",
        data: { dismissalReason: "Out of scope." },
      });
    });
    // Optimistic state confirmed.
    expect(
      client.getQueryData<{ requests: Array<{ id: string }> }>(queryKey)
        ?.requests.map((r) => r.id),
    ).toEqual(["req-2"]);

    // Server flips a 500 — the dialog rolls back the cache + shows
    // the formatted error inline.
    await act(async () => {
      hoisted.dismissOnError!(
        new MockApiError(500, {}),
        { id: "req-1", data: { dismissalReason: "Out of scope." } },
        ctx,
      );
    });

    // Row is back in the cache exactly as it was before onMutate.
    expect(
      client.getQueryData<{ requests: Array<{ id: string }> }>(queryKey)
        ?.requests.map((r) => r.id),
    ).toEqual(["req-1", "req-2"]);
    // Dialog stays open with the formatted error so the architect
    // can adjust their reason and retry.
    expect(
      screen.getByTestId("dismiss-reviewer-request-dialog"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("dismiss-reviewer-request-error"),
    ).toHaveTextContent(/snag/i);
  });

  it("flashes a 'resolved by your refresh' pill when the polled list shrinks without the architect dismissing", () => {
    // First render with two pending requests — establishes the
    // baseline the implicit-resolve diff compares against.
    hoisted.listData = {
      requests: [STABLE_REQUEST, SECOND_REQUEST],
    };
    const bumpRef = { current: () => {} };
    const { ui } = withQuery(
      <HarnessedStrip bumpRef={bumpRef} engagementId="eng-123" />,
    );
    render(ui);
    expect(
      screen.getByTestId("reviewer-requests-strip-count"),
    ).toHaveTextContent("2 pending");

    // Simulate a backend-driven implicit-resolve: the architect
    // refreshed the briefing source on its own surface, the route
    // flipped req-1 to `resolved`, the polled list now returns one
    // row. Bump the harness so the strip's mocked hook re-reads the
    // new `hoisted.listData`.
    hoisted.listData = { requests: [SECOND_REQUEST] };
    act(() => {
      bumpRef.current();
    });

    expect(
      screen.getByTestId("reviewer-requests-strip-count"),
    ).toHaveTextContent("1 pending");
    expect(
      screen.getByTestId("reviewer-requests-strip-pill-implicit-resolved"),
    ).toHaveTextContent(/1 request resolved by your refresh/i);
  });

  it("keeps the dismiss dialog mounted when the only pending request is optimistically removed mid-flight, and surfaces the inline error on rollback", async () => {
    // Last-row optimistic dismiss: the strip must NOT unmount when
    // `requests` goes empty between onMutate and onError, otherwise
    // the dialog disappears and the architect never sees the
    // server-error surface.
    hoisted.listData = { requests: [STABLE_REQUEST] };
    const bumpRef = { current: () => {} };
    const { ui } = withQuery(
      <HarnessedStrip bumpRef={bumpRef} engagementId="eng-123" />,
    );
    render(ui);

    fireEvent.click(screen.getByTestId("reviewer-request-dismiss-req-1"));
    fireEvent.change(
      screen.getByTestId("dismiss-reviewer-request-reason"),
      { target: { value: "Out of scope." } },
    );
    fireEvent.click(screen.getByTestId("dismiss-reviewer-request-confirm"));

    await act(async () => {
      await hoisted.dismissOnMutate!({
        id: "req-1",
        data: { dismissalReason: "Out of scope." },
      });
    });

    // The optimistic shrink reaches the strip — the queue is now
    // empty but the dialog is still in flight, so both the strip and
    // the dialog must remain mounted.
    hoisted.listData = { requests: [] };
    act(() => {
      bumpRef.current();
    });

    expect(
      screen.getByTestId("dismiss-reviewer-request-dialog"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("reviewer-requests-strip")).toBeInTheDocument();

    // Server errors → onError fires the inline error. The dialog is
    // still mounted, so the alert renders where the architect can see
    // it.
    await act(async () => {
      await hoisted.dismissOnError!(
        new MockApiError(500),
        { id: "req-1", data: { dismissalReason: "Out of scope." } },
        undefined,
      );
    });

    expect(
      screen.getByTestId("dismiss-reviewer-request-error"),
    ).toHaveTextContent(/snag/i);
    expect(
      screen.getByTestId("dismiss-reviewer-request-dialog"),
    ).toBeInTheDocument();
  });

  it("does NOT flash the implicit-resolve pill while a user dismiss is still in flight (between onMutate and onSuccess)", async () => {
    // Catches the timing bug where marking the row as user-dismissed
    // only on success would let the optimistic cache shrink reach the
    // diff effect before the mark, mis-attributing the row to the
    // backend implicit-resolve.
    hoisted.listData = {
      requests: [STABLE_REQUEST, SECOND_REQUEST],
    };
    const bumpRef = { current: () => {} };
    const { ui } = withQuery(
      <HarnessedStrip bumpRef={bumpRef} engagementId="eng-123" />,
    );
    render(ui);

    fireEvent.click(screen.getByTestId("reviewer-request-dismiss-req-1"));
    fireEvent.change(
      screen.getByTestId("dismiss-reviewer-request-reason"),
      { target: { value: "Out of scope." } },
    );
    fireEvent.click(screen.getByTestId("dismiss-reviewer-request-confirm"));

    // Run onMutate only — onSuccess hasn't fired yet (network in
    // flight). The dialog must mark the row as user-dismissed inside
    // onMutate.
    await act(async () => {
      await hoisted.dismissOnMutate!({
        id: "req-1",
        data: { dismissalReason: "Out of scope." },
      });
    });

    // Optimistic shrink reaches the strip's data (the production
    // useQuery subscription does this; the mock simulates it via
    // listData + bump).
    hoisted.listData = { requests: [SECOND_REQUEST] };
    act(() => {
      bumpRef.current();
    });

    expect(
      screen.queryByTestId(
        "reviewer-requests-strip-pill-implicit-resolved",
      ),
    ).toBeNull();

    // Server then errors and the dialog rolls the cache back. The
    // strip must not retroactively flash an implicit-resolve pill
    // when the row reappears.
    await act(async () => {
      await hoisted.dismissOnError!(
        new MockApiError(500),
        { id: "req-1", data: { dismissalReason: "Out of scope." } },
        undefined,
      );
    });
    hoisted.listData = { requests: [STABLE_REQUEST, SECOND_REQUEST] };
    act(() => {
      bumpRef.current();
    });

    expect(
      screen.queryByTestId(
        "reviewer-requests-strip-pill-implicit-resolved",
      ),
    ).toBeNull();
  });

  it("does NOT show the implicit-resolve pill for rows the architect just dismissed in-strip", async () => {
    hoisted.listData = {
      requests: [STABLE_REQUEST, SECOND_REQUEST],
    };
    const bumpRef = { current: () => {} };
    const { ui, client } = withQuery(
      <HarnessedStrip bumpRef={bumpRef} engagementId="eng-123" />,
    );
    const queryKey = [
      "listEngagementReviewerRequests",
      "eng-123",
      { status: "pending" },
    ];
    client.setQueryData(queryKey, {
      requests: [STABLE_REQUEST, SECOND_REQUEST],
    });
    render(ui);

    // Architect dismisses req-1 in-strip — record the mark + simulate
    // the optimistic cache write, then fire onSuccess so the
    // "Request dismissed" pill fires.
    fireEvent.click(screen.getByTestId("reviewer-request-dismiss-req-1"));
    fireEvent.change(
      screen.getByTestId("dismiss-reviewer-request-reason"),
      { target: { value: "Out of scope." } },
    );
    fireEvent.click(screen.getByTestId("dismiss-reviewer-request-confirm"));
    await act(async () => {
      await hoisted.dismissOnMutate!({
        id: "req-1",
        data: { dismissalReason: "Out of scope." },
      });
    });
    await act(async () => {
      await hoisted.dismissOnSuccess!({
        request: { ...STABLE_REQUEST, status: "dismissed" },
      });
    });

    // The polled list now reflects the dismiss too — but because the
    // architect dismissed it in-strip the implicit-resolve pill must
    // NOT fire (only the "Request dismissed" pill).
    hoisted.listData = { requests: [SECOND_REQUEST] };
    act(() => {
      bumpRef.current();
    });

    expect(
      screen.queryByTestId(
        "reviewer-requests-strip-pill-implicit-resolved",
      ),
    ).toBeNull();
    expect(
      screen.getByTestId("reviewer-requests-strip-pill-dismissed"),
    ).toBeInTheDocument();
  });
});

/**
 * ReviewerRequestsHistory — Task #441.
 *
 * Coverage:
 *   - Self-hides when there are no resolved/dismissed requests
 *     (post-load, both list reads return zero rows).
 *   - Renders the disclosure shell while the list reads are still
 *     in flight so the affordance doesn't pop in after the network
 *     settles. Loading copy surfaces only after the user expands.
 *   - Populated state: collapsed by default; clicking the toggle
 *     reveals one row per closed request, newest-first across both
 *     statuses, with status pill, who closed it, when, and the
 *     dismissal reason for dismissed rows.
 */
const DISMISSED_REQUEST = {
  ...STABLE_REQUEST,
  id: "req-d-1",
  status: "dismissed" as const,
  reason: "Source PDF appears outdated.",
  dismissedBy: {
    kind: "user" as const,
    id: "architect-7",
    displayName: "Pat Architect",
  },
  dismissedAt: new Date("2026-04-30T14:00:00Z").toISOString(),
  dismissalReason: "Source is current — verified yesterday.",
  resolvedAt: null,
  triggeredActionEventId: null,
};

const RESOLVED_REQUEST = {
  ...STABLE_REQUEST,
  id: "req-r-1",
  requestKind: "regenerate-briefing" as const,
  targetEntityType: "briefing" as const,
  targetEntityId: "brief-uuid-1",
  status: "resolved" as const,
  reason: "Tone is off-brand on page 3.",
  dismissedBy: null,
  dismissedAt: null,
  dismissalReason: null,
  // Newer than the dismissed row — must sort to the top of the list.
  resolvedAt: new Date("2026-04-30T16:00:00Z").toISOString(),
  triggeredActionEventId: "evt-uuid-9",
};

describe("ReviewerRequestsHistory", () => {
  beforeEach(() => {
    hoisted.listData = undefined;
    hoisted.listIsLoading = false;
    hoisted.dismissedListData = { requests: [] };
    hoisted.dismissedIsLoading = false;
    hoisted.resolvedListData = { requests: [] };
    hoisted.resolvedIsLoading = false;
    hoisted.dismissMutate.mockReset();
    hoisted.dismissIsPending = false;
    hoisted.dismissOnMutate = undefined;
    hoisted.dismissOnSuccess = undefined;
    hoisted.dismissOnError = undefined;
  });
  afterEach(() => cleanup());

  it("renders nothing when there is no resolved/dismissed history", () => {
    const { ui } = withQuery(
      <ReviewerRequestsHistory engagementId="eng-123" />,
    );
    render(ui);
    expect(screen.queryByTestId("reviewer-requests-history")).toBeNull();
  });

  it("renders the disclosure shell while history reads are loading and surfaces the loading copy when expanded", () => {
    hoisted.dismissedListData = undefined;
    hoisted.resolvedListData = undefined;
    hoisted.dismissedIsLoading = true;
    hoisted.resolvedIsLoading = true;
    const { ui } = withQuery(
      <ReviewerRequestsHistory engagementId="eng-123" />,
    );
    render(ui);
    const shell = screen.getByTestId("reviewer-requests-history");
    expect(shell).toBeInTheDocument();
    // Collapsed by default — no panel rendered yet.
    expect(
      screen.queryByTestId("reviewer-requests-history-panel"),
    ).toBeNull();
    expect(
      screen.getByTestId("reviewer-requests-history-count"),
    ).toHaveTextContent("…");
    // Expand → loading copy visible.
    fireEvent.click(screen.getByTestId("reviewer-requests-history-toggle"));
    expect(
      screen.getByTestId("reviewer-requests-history-loading"),
    ).toHaveTextContent(/loading history/i);
  });

  it("is collapsed by default and reveals merged, newest-first rows on toggle with closer attribution and dismissal reason", () => {
    hoisted.dismissedListData = { requests: [DISMISSED_REQUEST] };
    hoisted.resolvedListData = { requests: [RESOLVED_REQUEST] };
    const { ui } = withQuery(
      <ReviewerRequestsHistory engagementId="eng-123" />,
    );
    render(ui);

    // Disclosure is mounted but closed; the list is not in the DOM
    // until the architect opts in.
    expect(
      screen.getByTestId("reviewer-requests-history"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("reviewer-requests-history-toggle"),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByTestId("reviewer-requests-history-list"),
    ).toBeNull();
    expect(
      screen.getByTestId("reviewer-requests-history-count"),
    ).toHaveTextContent("2 closed");

    fireEvent.click(screen.getByTestId("reviewer-requests-history-toggle"));
    expect(
      screen.getByTestId("reviewer-requests-history-toggle"),
    ).toHaveAttribute("aria-expanded", "true");

    // Newest-first: resolvedAt 16:00 wins over dismissedAt 14:00.
    const rows = screen
      .getByTestId("reviewer-requests-history-list")
      .querySelectorAll("li");
    expect(Array.from(rows).map((r) => r.getAttribute("data-testid"))).toEqual(
      [
        "reviewer-request-history-row-req-r-1",
        "reviewer-request-history-row-req-d-1",
      ],
    );

    // Resolved row: status pill says "resolved", closer line falls
    // back to the underlying-action attribution (no dismissedBy on a
    // resolved row), no dismissal reason rendered.
    expect(
      screen.getByTestId("reviewer-request-history-status-req-r-1"),
    ).toHaveTextContent(/resolved/i);
    expect(
      screen.getByTestId("reviewer-request-history-closed-req-r-1"),
    ).toHaveTextContent(/Resolved by/i);
    expect(
      screen.getByTestId("reviewer-request-history-closed-req-r-1"),
    ).toHaveTextContent(/underlying refresh action/i);
    expect(
      screen.queryByTestId(
        "reviewer-request-history-dismissal-reason-req-r-1",
      ),
    ).toBeNull();

    // Dismissed row: status pill, dismisser displayName, dismissal
    // reason verbatim.
    expect(
      screen.getByTestId("reviewer-request-history-status-req-d-1"),
    ).toHaveTextContent(/dismissed/i);
    expect(
      screen.getByTestId("reviewer-request-history-closed-req-d-1"),
    ).toHaveTextContent(/Dismissed by/i);
    expect(
      screen.getByTestId("reviewer-request-history-closed-req-d-1"),
    ).toHaveTextContent(/Pat Architect/i);
    expect(
      screen.getByTestId(
        "reviewer-request-history-dismissal-reason-req-d-1",
      ),
    ).toHaveTextContent("Source is current — verified yesterday.");

    // Collapse again hides the panel without unmounting the shell.
    fireEvent.click(screen.getByTestId("reviewer-requests-history-toggle"));
    expect(
      screen.queryByTestId("reviewer-requests-history-list"),
    ).toBeNull();
    expect(
      screen.getByTestId("reviewer-requests-history"),
    ).toBeInTheDocument();
  });
});
