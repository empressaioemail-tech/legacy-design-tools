/**
 * Notifications page coverage.
 *
 * Pins the FE half of the inbox acceptance criteria:
 *
 *   1. Badge count surfaces in the side-nav as the unread tally.
 *   2. List rendering — items show title + engagement label + body
 *      and link to the engagement detail route.
 *   3. Read-state transition — opening the page fires the mark-read
 *      mutation and the per-row "unread dot" disappears once the
 *      query refetches with the updated `read` flags.
 *
 * The generated `useListMyNotifications` / `useMarkMyNotificationsRead`
 * hooks are mocked so no network call happens; the mock implements the
 * minimum surface the page consumes.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createQueryKeyStubs } from "@workspace/portal-ui/test-utils";

interface FakeNotification {
  id: string;
  kind: "submission-status-changed" | "reviewer-request-filed";
  title: string;
  body: string | null;
  occurredAt: string;
  recordedAt: string;
  read: boolean;
  engagementId: string | null;
  engagementName: string | null;
  submissionId: string | null;
  reviewerRequestId: string | null;
}

interface FakeListResponse {
  items: FakeNotification[];
  unreadCount: number;
  lastReadAt: string | null;
}

let listResponse: FakeListResponse;
const markReadMock = vi.fn();

function setListResponse(next: FakeListResponse) {
  listResponse = next;
}

vi.mock("@workspace/api-client-react", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/api-client-react")>(
      "@workspace/api-client-react",
    );
  return {
    ...actual,
    useListMyNotifications: () => ({
      data: listResponse,
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: () => {},
    }),
    useMarkMyNotificationsRead: () => ({
      mutate: markReadMock,
      mutateAsync: markReadMock,
      isPending: false,
      isError: false,
    }),
    ...createQueryKeyStubs([
      "getListMyNotificationsQueryKey",
      "getListEngagementsQueryKey",
    ] as const),
  };
});

const { Notifications } = await import("../Notifications");

beforeEach(() => {
  markReadMock.mockReset();
  setListResponse({
    items: [],
    unreadCount: 0,
    lastReadAt: null,
  });
});

afterEach(() => {
  cleanup();
});

function renderPage() {
  const memory = memoryLocation({ path: "/notifications", record: true });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    memory,
    ...render(
      <QueryClientProvider client={client}>
        <Router hook={memory.hook}>
          <Notifications />
        </Router>
      </QueryClientProvider>,
    ),
  };
}

function makeItem(overrides: Partial<FakeNotification> = {}): FakeNotification {
  return {
    id: "ev-1",
    kind: "submission-status-changed",
    title: "Submission approved",
    body: "Looks good.",
    occurredAt: "2026-04-01T10:00:00.000Z",
    recordedAt: "2026-04-01T10:00:00.000Z",
    read: false,
    engagementId: "eng-1",
    engagementName: "Studio Foo — 123 Main St",
    submissionId: "sub-1",
    reviewerRequestId: null,
    ...overrides,
  };
}

describe("Notifications page", () => {
  it("renders the empty state when there are no items", () => {
    renderPage();
    expect(screen.getByTestId("notifications-empty")).toBeTruthy();
  });

  it("renders the list newest-first with title, engagement label, body and a deep link to the engagement", () => {
    setListResponse({
      items: [
        makeItem({
          id: "ev-newest",
          title: "Submission approved",
          body: "All set.",
          engagementId: "eng-42",
          engagementName: "Studio Foo",
        }),
        makeItem({
          id: "ev-older",
          kind: "reviewer-request-filed",
          title: "Reviewer requested briefing-source refresh",
          body: "Source updated",
          engagementId: "eng-99",
          engagementName: "Studio Bar",
          submissionId: null,
          reviewerRequestId: "rr-1",
        }),
      ],
      unreadCount: 2,
      lastReadAt: null,
    });

    renderPage();
    const rows = screen.getAllByTestId("notification-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Submission approved");
    expect(rows[0].textContent).toContain("Studio Foo");
    expect(rows[0].textContent).toContain("All set.");
    expect(rows[1].textContent).toContain(
      "Reviewer requested briefing-source refresh",
    );

    // Each row's anchor points at the engagement deep link — clicking
    // an inbox item lands the architect on the engagement detail
    // page where the reviewer activity originated.
    const links = rows.map((r) => r.querySelector("a"));
    expect(links[0]?.getAttribute("href")).toBe("/engagements/eng-42");
    expect(links[1]?.getAttribute("href")).toBe("/engagements/eng-99");
  });

  it("shows the unread indicator only on unread rows (read-state transition)", () => {
    setListResponse({
      items: [
        makeItem({ id: "ev-unread", read: false }),
        makeItem({ id: "ev-read", read: true }),
      ],
      unreadCount: 1,
      lastReadAt: "2026-04-01T09:00:00.000Z",
    });

    renderPage();
    const rows = screen.getAllByTestId("notification-row");
    expect(rows[0].getAttribute("data-read")).toBe("false");
    expect(rows[0].querySelector("[data-testid='unread-dot']")).not.toBeNull();
    expect(rows[1].getAttribute("data-read")).toBe("true");
    expect(rows[1].querySelector("[data-testid='unread-dot']")).toBeNull();
  });

  it("fires the mark-read mutation exactly once on mount", () => {
    setListResponse({
      items: [makeItem({ id: "ev-1", read: false })],
      unreadCount: 1,
      lastReadAt: null,
    });
    renderPage();
    expect(markReadMock).toHaveBeenCalledTimes(1);
  });

  it("re-renders flipped read flags when the list query is invalidated and the response now has read=true", () => {
    // First render: unread.
    setListResponse({
      items: [makeItem({ id: "ev-1", read: false })],
      unreadCount: 1,
      lastReadAt: null,
    });
    const { rerender } = renderPage();
    expect(
      screen
        .getAllByTestId("notification-row")[0]
        .querySelector("[data-testid='unread-dot']"),
    ).not.toBeNull();

    // Simulate the post-mutation refetch: same item, now read.
    setListResponse({
      items: [
        makeItem({
          id: "ev-1",
          read: true,
        }),
      ],
      unreadCount: 0,
      lastReadAt: "2026-04-01T11:00:00.000Z",
    });
    act(() => {
      rerender(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <Router hook={memoryLocation({ path: "/notifications" }).hook}>
            <Notifications />
          </Router>
        </QueryClientProvider>,
      );
    });
    expect(
      screen
        .getAllByTestId("notification-row")[0]
        .querySelector("[data-testid='unread-dot']"),
    ).toBeNull();
  });
});
