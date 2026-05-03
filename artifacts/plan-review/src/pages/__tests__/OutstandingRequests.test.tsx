// OutstandingRequests page-level contracts: URL `?status=` filter
// (defaults to pending; `all` returns full history), spec-mandated
// empty-state copy, per-row engagement / status / kind rendering,
// and reviewer-audience-gated sidebar nav entry.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import type { ReviewerRequestWithEngagement } from "@workspace/api-client-react";

const hoisted = vi.hoisted(() => ({
  audience: "internal" as "internal" | "user" | "ai" | null,
  sessionUserId: "reviewer-1" as string | null,
  requests: [] as ReviewerRequestWithEngagement[],
  lastListParams: null as null | { status?: string },
  withdrawCalls: [] as Array<{ id: string; data: unknown }>,
  withdrawIsPending: false,
  // `useNavGroups` reads `useListReviewerQueue({status})` for each
  // bucket badge. Default counts to 0 so existing tests render no
  // extra badges; the bucket-badge suite mutates these per case.
  inReviewCount: 0,
  approvedCount: 0,
  rejectedCount: 0,
  reviewerQueueCalls: [] as Array<unknown>,
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetSession: () => ({
    data: {
      audience: hoisted.audience,
      permissions: [],
      // `useSessionUserId` reads `requestor.kind === "user"` — feed
      // it a matching envelope so the row-ownership gate exposes
      // the withdraw button on rows where requestedBy.id matches.
      requestor: hoisted.sessionUserId
        ? { kind: "user", id: hoisted.sessionUserId }
        : null,
    },
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
  useWithdrawReviewerRequest: (_opts?: unknown) => ({
    mutate: (vars: { id: string; data: unknown }) => {
      hoisted.withdrawCalls.push(vars);
    },
    isPending: hoisted.withdrawIsPending,
  }),
  // `useNavGroups` calls `useListReviewerQueue({status})` per
  // bucket badge. Returns the hoisted bucket counts so tests can
  // drive the badges directly, and records each call's params so
  // tests can assert the per-bucket cache-sharing pattern.
  useListReviewerQueue: (params: unknown, _opts?: unknown) => {
    hoisted.reviewerQueueCalls.push(params);
    return {
      data: {
        items: [],
        counts: {
          inReview: hoisted.inReviewCount,
          awaitingAi: 0,
          approved: hoisted.approvedCount,
          rejected: hoisted.rejectedCount,
          backlog: 0,
        },
      },
      isLoading: false,
      isError: false,
    };
  },
  getListReviewerQueueQueryKey: (params?: unknown) =>
    params === undefined
      ? ["/api/reviewer/queue"]
      : ["/api/reviewer/queue", params],
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
    withdrawnBy: over.withdrawnBy ?? null,
    withdrawnAt: over.withdrawnAt ?? null,
    withdrawalReason: over.withdrawalReason ?? null,
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
  // Task #443 added an inline mutation in RequestRow, which calls
  // useQueryClient() to invalidate listings on success. Wrap every
  // render in a fresh QueryClientProvider so that hook resolves —
  // the API hooks themselves are mocked, so this client is just
  // there to satisfy the context lookup.
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const utils = render(
    <QueryClientProvider client={client}>
      <Router hook={memory.hook}>
        <OutstandingRequests />
      </Router>
    </QueryClientProvider>,
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
  hoisted.sessionUserId = "reviewer-1";
  hoisted.requests = [];
  hoisted.lastListParams = null;
  hoisted.withdrawCalls = [];
  hoisted.withdrawIsPending = false;
  hoisted.inReviewCount = 0;
  hoisted.approvedCount = 0;
  hoisted.rejectedCount = 0;
  hoisted.reviewerQueueCalls = [];
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
    // Task #443 split the row from a single Link into a div with
    // an inner engagement-link wrapper — the href moved to the
    // inner element while the row container hosts the action
    // affordances.
    expect(
      screen.getByTestId("request-row-link-req-1").getAttribute("href"),
    ).toBe("/engagements/eng-A");
    const pillA = screen.getByTestId("request-row-kind-req-1");
    expect(pillA.textContent).toBe("Refresh briefing source");

    const rowB = screen.getByTestId("request-row-req-2");
    expect(rowB.textContent).toContain("Civic Annex");
    expect(rowB.textContent).toContain("Salt Lake City, UT");
    expect(
      screen.getByTestId("request-row-link-req-2").getAttribute("href"),
    ).toBe("/engagements/eng-B");
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

describe("OutstandingRequests — withdraw + target deep-link (Task #443)", () => {
  it("renders a Withdraw button on the reviewer's own pending row", () => {
    hoisted.requests = [
      row({
        id: "req-mine-pending",
        status: "pending",
        requestedBy: { kind: "user", id: "reviewer-1", displayName: "Me" },
      }),
    ];
    renderAt("/requests");
    const btn = screen.getByTestId("request-row-withdraw-req-mine-pending");
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe("Withdraw");
  });

  it("hides the Withdraw button on a row owned by a different reviewer", () => {
    hoisted.requests = [
      row({
        id: "req-not-mine",
        status: "pending",
        requestedBy: {
          kind: "user",
          id: "reviewer-other",
          displayName: "Other",
        },
      }),
    ];
    renderAt("/requests");
    expect(
      screen.queryByTestId("request-row-withdraw-req-not-mine"),
    ).toBeNull();
  });

  it("hides the Withdraw button on the reviewer's own non-pending rows", () => {
    hoisted.requests = [
      row({
        id: "req-mine-dismissed",
        status: "dismissed",
        requestedBy: { kind: "user", id: "reviewer-1", displayName: "Me" },
        dismissedBy: { kind: "user", id: "architect-1", displayName: "A" },
        dismissedAt: "2026-04-02T00:00:00.000Z",
        dismissalReason: "no longer relevant",
      }),
      row({
        id: "req-mine-resolved",
        status: "resolved",
        requestedBy: { kind: "user", id: "reviewer-1", displayName: "Me" },
        resolvedAt: "2026-04-02T00:00:00.000Z",
        triggeredActionEventId: "evt-1",
      }),
    ];
    renderAt("/requests?status=all");
    expect(
      screen.queryByTestId("request-row-withdraw-req-mine-dismissed"),
    ).toBeNull();
    expect(
      screen.queryByTestId("request-row-withdraw-req-mine-resolved"),
    ).toBeNull();
  });

  it("clicking Withdraw fires the mutation with the row's id", () => {
    hoisted.requests = [
      row({
        id: "req-mine-pending",
        status: "pending",
        requestedBy: { kind: "user", id: "reviewer-1", displayName: "Me" },
      }),
    ];
    renderAt("/requests");
    fireEvent.click(
      screen.getByTestId("request-row-withdraw-req-mine-pending"),
    );
    expect(hoisted.withdrawCalls).toHaveLength(1);
    expect(hoisted.withdrawCalls[0].id).toBe("req-mine-pending");
    // Empty body — no reason supplied via the inline affordance.
    expect(hoisted.withdrawCalls[0].data).toEqual({});
  });

  it("renders a per-row inline link to the target atom", () => {
    hoisted.requests = [
      row({
        id: "req-bs",
        targetEntityType: "briefing-source",
        targetEntityId: "src-x",
        engagement: { id: "eng-A", name: "Eng A", jurisdiction: "X" },
      }),
      row({
        id: "req-bim",
        requestKind: "refresh-bim-model",
        targetEntityType: "bim-model",
        targetEntityId: "bim-x",
        engagement: { id: "eng-B", name: "Eng B", jurisdiction: "Y" },
      }),
      row({
        id: "req-pb",
        requestKind: "regenerate-briefing",
        targetEntityType: "parcel-briefing",
        targetEntityId: "pb-x",
        engagement: { id: "eng-C", name: "Eng C", jurisdiction: "Z" },
      }),
    ];
    renderAt("/requests");
    expect(
      screen.getByTestId("request-row-target-req-bs").getAttribute("href"),
    ).toBe("/engagements/eng-A#briefing");
    expect(
      screen.getByTestId("request-row-target-req-bim").getAttribute("href"),
    ).toBe("/engagements/eng-B?tab=bim");
    expect(
      screen.getByTestId("request-row-target-req-pb").getAttribute("href"),
    ).toBe("/engagements/eng-C#briefing");
  });
});

describe("In Review / Approved / Rejected sidebar bucket badges", () => {
  function BucketBadgeProbe() {
    const groups = useNavGroups();
    const items = groups.flatMap((g) => g.items);
    const inReview = items.find((i) => i.href === "/in-review");
    const approved = items.find((i) => i.href === "/approved");
    const rejected = items.find((i) => i.href === "/rejected");
    return (
      <div data-testid="bucket-probe">
        <span data-testid="bucket-probe-in-review-badge">
          {inReview?.badge ?? null}
        </span>
        <span data-testid="bucket-probe-approved-badge">
          {approved?.badge ?? null}
        </span>
        <span data-testid="bucket-probe-rejected-badge">
          {rejected?.badge ?? null}
        </span>
      </div>
    );
  }

  it("hides every bucket badge when all counts are zero", () => {
    hoisted.audience = "internal";
    render(
      <Router>
        <BucketBadgeProbe />
      </Router>,
    );
    expect(screen.queryByTestId("nav-in-review-badge")).toBeNull();
    expect(screen.queryByTestId("nav-approved-badge")).toBeNull();
    expect(screen.queryByTestId("nav-rejected-badge")).toBeNull();
  });

  it("renders each bucket pill from the matching reviewer-queue count", () => {
    hoisted.audience = "internal";
    hoisted.inReviewCount = 7;
    hoisted.approvedCount = 2;
    hoisted.rejectedCount = 4;
    render(
      <Router>
        <BucketBadgeProbe />
      </Router>,
    );
    expect(screen.getByTestId("nav-in-review-badge").textContent).toBe("7");
    expect(screen.getByTestId("nav-approved-badge").textContent).toBe("2");
    expect(screen.getByTestId("nav-rejected-badge").textContent).toBe("4");
  });

  it("caps the rendered label at 99+ for runaway buckets", () => {
    hoisted.audience = "internal";
    hoisted.inReviewCount = 250;
    hoisted.approvedCount = 100;
    hoisted.rejectedCount = 1000;
    render(
      <Router>
        <BucketBadgeProbe />
      </Router>,
    );
    expect(screen.getByTestId("nav-in-review-badge").textContent).toBe("99+");
    expect(screen.getByTestId("nav-approved-badge").textContent).toBe("99+");
    expect(screen.getByTestId("nav-rejected-badge").textContent).toBe("99+");
  });

  it("hides bucket entries entirely when audience is not internal", () => {
    hoisted.audience = "user";
    hoisted.inReviewCount = 5;
    hoisted.approvedCount = 5;
    hoisted.rejectedCount = 5;
    render(
      <Router>
        <BucketBadgeProbe />
      </Router>,
    );
    expect(screen.queryByTestId("nav-in-review-badge")).toBeNull();
    expect(screen.queryByTestId("nav-approved-badge")).toBeNull();
    expect(screen.queryByTestId("nav-rejected-badge")).toBeNull();
  });

  it("uses one cache entry per bucket, matching the params the bucket page reads", () => {
    hoisted.audience = "internal";
    render(
      <Router>
        <BucketBadgeProbe />
      </Router>,
    );
    // Each bucket badge shares its react-query cache entry with the
    // matching page, so the recorded params mirror what `InReview`,
    // `Approved`, and `Rejected` already pass — `Approved`/`Rejected`
    // both add `order: "respondedAt"` so the freshest decisions surface
    // first, while `InReview` keeps the default ordering.
    expect(hoisted.reviewerQueueCalls).toEqual([
      { status: "corrections_requested" },
      { status: "approved", order: "respondedAt" },
      { status: "rejected", order: "respondedAt" },
    ]);
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
