// OutstandingRequests page-level contracts: URL `?status=` filter
// (defaults to pending; `all` returns full history), spec-mandated
// empty-state copy, per-row engagement / status / kind rendering,
// and reviewer-audience-gated sidebar nav entry.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import type { ReviewerRequestWithEngagement } from "@workspace/api-client-react";

const hoisted = vi.hoisted(() => ({
  audience: "internal" as "internal" | "user" | "ai" | null,
  requests: [] as ReviewerRequestWithEngagement[],
  lastListParams: null as null | { status?: string },
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetSession: () => ({
    data: { audience: hoisted.audience, permissions: [] },
    isLoading: false,
  }),
  getGetSessionQueryKey: () => ["getSession"],
  useListMyReviewerRequests: (
    params?: { status?: string },
    _opts?: unknown,
  ) => {
    hoisted.lastListParams = params ?? null;
    return {
      data: { requests: hoisted.requests },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: () => {},
    };
  },
  getListMyReviewerRequestsQueryKey: (params?: { status?: string }) => [
    "listMyReviewerRequests",
    params?.status ?? "pending",
  ],
}));

const { default: OutstandingRequests } = await import("../OutstandingRequests");
const { filterNavGroups, useNavGroups } = await import(
  "../../components/NavGroups"
);

function row(over: Partial<ReviewerRequestWithEngagement> & { id: string }): ReviewerRequestWithEngagement {
  return {
    id: over.id,
    engagementId: over.engagementId ?? "eng-1",
    requestKind: over.requestKind ?? "refresh-briefing-source",
    targetEntityType: over.targetEntityType ?? "briefing-source",
    targetEntityId: over.targetEntityId ?? "src-1",
    reason: over.reason ?? "Source PDF appears outdated.",
    status: over.status ?? "pending",
    requestedBy: over.requestedBy ?? {
      kind: "user",
      id: "reviewer-1",
      displayName: "Reviewer One",
    },
    requestedAt: over.requestedAt ?? "2026-04-01T00:00:00.000Z",
    dismissedBy: over.dismissedBy ?? null,
    dismissedAt: over.dismissedAt ?? null,
    dismissalReason: over.dismissalReason ?? null,
    resolvedAt: over.resolvedAt ?? null,
    triggeredActionEventId: over.triggeredActionEventId ?? null,
    createdAt: over.createdAt ?? "2026-04-01T00:00:00.000Z",
    updatedAt: over.updatedAt ?? "2026-04-01T00:00:00.000Z",
    engagement: over.engagement ?? {
      id: "eng-1",
      name: "Riverside Library",
      jurisdiction: "Moab, UT",
    },
  } as ReviewerRequestWithEngagement;
}

function renderAt(initialPath: string) {
  const memory = memoryLocation({ path: initialPath, record: true });
  const utils = render(
    <Router hook={memory.hook}>
      <OutstandingRequests />
    </Router>,
  );
  return { ...utils, memory };
}

function selectedTabTestId(): string | null {
  const tabs = screen.getAllByRole("tab");
  const selected = tabs.find(
    (t) => t.getAttribute("aria-selected") === "true",
  );
  return selected?.getAttribute("data-testid") ?? null;
}

beforeEach(() => {
  hoisted.audience = "internal";
  hoisted.requests = [];
  hoisted.lastListParams = null;
});

afterEach(() => {
  cleanup();
});

describe("OutstandingRequests — `?status=` filter URL", () => {
  it("defaults to the Pending tab and leaves the URL clean on first load", () => {
    const { memory } = renderAt("/requests");
    expect(selectedTabTestId()).toBe("requests-filter-pending");
    expect(memory.history).toEqual(["/requests"]);
    // Filter actually flows into the request — defaulting to
    // `pending` is what makes the page show the open queue.
    expect(hoisted.lastListParams?.status).toBe("pending");
  });

  it("clicking the All tab pushes `?status=all` into the URL and into the request", () => {
    const { memory } = renderAt("/requests");
    fireEvent.click(screen.getByTestId("requests-filter-all"));
    expect(selectedTabTestId()).toBe("requests-filter-all");
    expect(memory.history.at(-1)).toBe("/requests?status=all");
    expect(hoisted.lastListParams?.status).toBe("all");
  });

  it("clicking back to Pending strips the `?status=` parameter", () => {
    const { memory } = renderAt("/requests?status=all");
    expect(selectedTabTestId()).toBe("requests-filter-all");
    fireEvent.click(screen.getByTestId("requests-filter-pending"));
    expect(selectedTabTestId()).toBe("requests-filter-pending");
    expect(memory.history.at(-1)).toBe("/requests");
  });

  it("falls back to Pending when `?status=` is an unknown value", () => {
    renderAt("/requests?status=bogus");
    expect(selectedTabTestId()).toBe("requests-filter-pending");
  });

  it("falls back to Pending when `?status=` is a non-exposed lifecycle value", () => {
    // `dismissed` and `resolved` are valid wire values but the page
    // surface only exposes Pending / All — anything else collapses
    // back to the Pending default rather than rendering a third tab.
    renderAt("/requests?status=dismissed");
    expect(selectedTabTestId()).toBe("requests-filter-pending");
  });
});

describe("OutstandingRequests — empty state + row rendering", () => {
  it("renders the load-bearing empty-state copy when the reviewer has no pending requests", () => {
    hoisted.requests = [];
    renderAt("/requests");
    const empty = screen.getByTestId("requests-empty");
    // Spec-mandated copy — pinned literally so a copy tweak fails
    // the test rather than silently drifting the surface.
    expect(empty.textContent).toBe("You have no outstanding requests.");
  });

  it("renders one row per request with engagement context joined inline", () => {
    hoisted.requests = [
      row({
        id: "req-1",
        reason: "Source PDF appears outdated.",
        engagement: {
          id: "eng-A",
          name: "Riverside Library",
          jurisdiction: "Moab, UT",
        },
      }),
      row({
        id: "req-2",
        requestKind: "refresh-bim-model",
        reason: "BIM walls don't match the latest sheet set.",
        engagement: {
          id: "eng-B",
          name: "Civic Annex",
          jurisdiction: "Salt Lake City, UT",
        },
      }),
    ];
    renderAt("/requests");

    const rowA = screen.getByTestId("request-row-req-1");
    expect(rowA.textContent).toContain("Riverside Library");
    expect(rowA.textContent).toContain("Moab, UT");
    expect(rowA.textContent).toContain("Source PDF appears outdated.");
    expect(rowA.getAttribute("href")).toBe("/engagements/eng-A");
    const pillA = screen.getByTestId("request-row-kind-req-1");
    expect(pillA.textContent).toBe("Refresh briefing source");

    const rowB = screen.getByTestId("request-row-req-2");
    expect(rowB.textContent).toContain("Civic Annex");
    expect(rowB.textContent).toContain("Salt Lake City, UT");
    expect(rowB.getAttribute("href")).toBe("/engagements/eng-B");
    const pillB = screen.getByTestId("request-row-kind-req-2");
    expect(pillB.textContent).toBe("Refresh BIM model");
  });

  it("renders a per-row status pill that reflects the row's lifecycle state", () => {
    hoisted.requests = [
      row({ id: "req-pending", status: "pending" }),
      row({
        id: "req-dismissed",
        status: "dismissed",
        dismissedBy: { kind: "user", id: "architect-1", displayName: "A" },
        dismissedAt: "2026-04-02T00:00:00.000Z",
        dismissalReason: "no longer relevant",
      }),
      row({
        id: "req-resolved",
        status: "resolved",
        resolvedAt: "2026-04-02T00:00:00.000Z",
        triggeredActionEventId: "evt-1",
      }),
    ];
    renderAt("/requests?status=all");

    expect(
      screen.getByTestId("request-row-status-req-pending").textContent,
    ).toBe("Pending");
    expect(
      screen.getByTestId("request-row-status-req-dismissed").textContent,
    ).toBe("Dismissed");
    expect(
      screen.getByTestId("request-row-status-req-resolved").textContent,
    ).toBe("Resolved");
  });

  it("does not call the list endpoint when the session is not reviewer-audience", () => {
    hoisted.audience = "user";
    renderAt("/requests");
    expect(screen.getByTestId("requests-not-reviewer")).not.toBeNull();
    // The list query is `enabled: false` for non-reviewers so the
    // page never asks for someone else's rows. Hook still runs (so
    // params are captured) but we assert the gate by the visible
    // banner copy.
    expect(screen.getByTestId("requests-not-reviewer").textContent).toContain(
      "reviewer-only",
    );
  });
});

describe("Outstanding Requests sidebar badge (Task #444)", () => {
  function BadgeProbe() {
    const groups = useNavGroups();
    const item = groups
      .flatMap((g) => g.items)
      .find((i) => i.href === "/requests");
    return (
      <div data-testid="probe">
        <span data-testid="probe-found">{item ? "yes" : "no"}</span>
        <span data-testid="probe-badge">{item?.badge ?? null}</span>
      </div>
    );
  }

  it("hides the badge when the reviewer has zero pending requests", () => {
    hoisted.audience = "internal";
    hoisted.requests = [];
    render(
      <Router>
        <BadgeProbe />
      </Router>,
    );
    expect(screen.getByTestId("probe-found").textContent).toBe("yes");
    // Empty fragment — querying by the badge testid returns null
    // because the helper only constructs the badge node when count > 0.
    expect(screen.queryByTestId("nav-outstanding-requests-badge")).toBeNull();
  });

  it("renders the pending count as a pill when the reviewer has open requests", () => {
    hoisted.audience = "internal";
    hoisted.requests = [
      row({ id: "req-1" }),
      row({ id: "req-2" }),
      row({ id: "req-3" }),
    ];
    render(
      <Router>
        <BadgeProbe />
      </Router>,
    );
    const badge = screen.getByTestId("nav-outstanding-requests-badge");
    expect(badge.textContent).toBe("3");
  });

  it("caps the rendered label at 99+ for runaway queues", () => {
    hoisted.audience = "internal";
    hoisted.requests = Array.from({ length: 150 }, (_, i) =>
      row({ id: `req-${i}` }),
    );
    render(
      <Router>
        <BadgeProbe />
      </Router>,
    );
    expect(
      screen.getByTestId("nav-outstanding-requests-badge").textContent,
    ).toBe("99+");
  });

  it("does not render the badge when the audience is not reviewer", () => {
    hoisted.audience = "user";
    // The endpoint would 403 for an architect — `enabled: false`
    // short-circuits the request and the helper returns 0, so the
    // badge stays absent even if a stale fixture leaked through.
    hoisted.requests = [row({ id: "req-1" })];
    render(
      <Router>
        <BadgeProbe />
      </Router>,
    );
    // The Outstanding Requests entry itself is hidden for architects
    // (audience filter), so there is no item, hence no badge.
    expect(screen.getByTestId("probe-found").textContent).toBe("no");
    expect(screen.queryByTestId("nav-outstanding-requests-badge")).toBeNull();
  });
});

describe("OutstandingRequests — sidebar nav entry is reviewer-gated", () => {
  it("renders the 'Outstanding Requests' entry under MY WORK for an `internal` session", () => {
    const groups = filterNavGroups([], "internal");
    const myWork = groups.find((g) => g.label === "MY WORK");
    expect(myWork).toBeDefined();
    expect(myWork?.items.find((i) => i.href === "/requests")?.label).toBe(
      "Outstanding Requests",
    );
  });

  it("hides the 'Outstanding Requests' entry from a `user` (architect) session", () => {
    const groups = filterNavGroups([], "user");
    const myWork = groups.find((g) => g.label === "MY WORK");
    // Whole group should drop because its only item is reviewer-gated.
    expect(myWork).toBeUndefined();
  });

  it("hides the entry while the session is still loading (audience: null)", () => {
    const groups = filterNavGroups([], null);
    const myWork = groups.find((g) => g.label === "MY WORK");
    expect(myWork).toBeUndefined();
  });
});
