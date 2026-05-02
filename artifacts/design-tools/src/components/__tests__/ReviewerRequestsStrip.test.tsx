/**
 * ReviewerRequestsStrip + DismissReviewerRequestDialog — Wave 2
 * Sprint D / V1-2.
 *
 * Coverage:
 *   - Strip is self-hiding when the queue is empty.
 *   - Strip renders one row per pending request with the right
 *     kind label, requested-by displayName, and reason verbatim.
 *   - "Dismiss" opens DismissReviewerRequestDialog scoped to the
 *     clicked request; submitting the dialog calls the generated
 *     `useDismissReviewerRequest` mutation with the right body shape.
 *   - The 409 already-resolved error surfaces inline.
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
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const hoisted = vi.hoisted(() => ({
  listData: undefined as
    | { requests: Array<Record<string, unknown>> }
    | undefined,
  listIsLoading: false,
  dismissMutate: vi.fn(),
  dismissIsPending: false,
  dismissOnSuccess: undefined as
    | ((response: { request: unknown }) => void)
    | undefined,
  dismissOnError: undefined as ((err: unknown) => void) | undefined,
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
    useListEngagementReviewerRequests: () => ({
      data: hoisted.listData,
      isLoading: hoisted.listIsLoading,
      isError: false,
    }),
    useDismissReviewerRequest: (opts?: {
      mutation?: {
        onSuccess?: (response: { request: unknown }) => void;
        onError?: (err: unknown) => void;
      };
    }) => {
      hoisted.dismissOnSuccess = opts?.mutation?.onSuccess;
      hoisted.dismissOnError = opts?.mutation?.onError;
      return {
        mutate: hoisted.dismissMutate,
        isPending: hoisted.dismissIsPending,
      };
    },
    getListEngagementReviewerRequestsQueryKey: (id: string) => [
      "listEngagementReviewerRequests",
      id,
    ],
    getGetAtomHistoryQueryKey: (entityType: string, entityId: string) => [
      "getAtomHistory",
      entityType,
      entityId,
    ],
  };
});

const { ReviewerRequestsStrip } = await import("../ReviewerRequestsStrip");

function withQuery(node: ReactNode): ReactNode {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
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

describe("ReviewerRequestsStrip", () => {
  beforeEach(() => {
    hoisted.listData = undefined;
    hoisted.listIsLoading = false;
    hoisted.dismissMutate.mockReset();
    hoisted.dismissIsPending = false;
    hoisted.dismissOnSuccess = undefined;
    hoisted.dismissOnError = undefined;
  });
  afterEach(() => cleanup());

  it("renders nothing when the pending queue is empty", () => {
    hoisted.listData = { requests: [] };
    render(withQuery(<ReviewerRequestsStrip engagementId="eng-123" />));
    expect(screen.queryByTestId("reviewer-requests-strip")).toBeNull();
  });

  it("renders one row per pending request", () => {
    hoisted.listData = { requests: [STABLE_REQUEST] };
    render(withQuery(<ReviewerRequestsStrip engagementId="eng-123" />));
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
    render(withQuery(<ReviewerRequestsStrip engagementId="eng-123" />));
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
    render(withQuery(<ReviewerRequestsStrip engagementId="eng-123" />));
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
    render(withQuery(<ReviewerRequestsStrip engagementId="eng-123" />));
    fireEvent.click(screen.getByTestId("reviewer-request-dismiss-req-1"));
    fireEvent.change(
      screen.getByTestId("dismiss-reviewer-request-reason"),
      { target: { value: "no" } },
    );
    fireEvent.click(screen.getByTestId("dismiss-reviewer-request-confirm"));
    expect(hoisted.dismissOnError).toBeDefined();
    hoisted.dismissOnError!(new MockApiError(409, {}));
    const errMsg = await screen.findByTestId(
      "dismiss-reviewer-request-error",
    );
    expect(errMsg).toHaveTextContent(/already resolved/i);
  });
});
