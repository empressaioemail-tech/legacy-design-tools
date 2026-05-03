import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";

type QueueItem = {
  submissionId: string;
  engagementId: string;
  engagementName: string;
  jurisdiction: string | null;
  address: string | null;
  applicantFirm: string | null;
  submittedAt: string;
  status: "pending" | "approved" | "corrections_requested" | "rejected";
  note: string | null;
  reviewerComment: string | null;
};

const hoisted = vi.hoisted(() => ({
  audience: "internal" as "internal" | "user" | "ai" | null,
  audienceLoading: false,
  items: [] as QueueItem[],
  isLoading: false,
  isError: false,
  hookCalls: [] as Array<{
    params: unknown;
    options: unknown;
  }>,
}));

vi.mock("@workspace/api-client-react", () => ({
  useListReviewerQueue: (params: unknown, options: unknown) => {
    hoisted.hookCalls.push({ params, options });
    return {
      data: { items: hoisted.items },
      isLoading: hoisted.isLoading,
      isError: hoisted.isError,
    };
  },
  getListReviewerQueueQueryKey: (params: unknown) => [
    "/api/reviewer/queue",
    params,
  ],
}));

vi.mock("@workspace/portal-ui", () => ({
  DashboardLayout: ({
    children,
    title,
  }: {
    children: ReactNode;
    title?: string;
  }) => (
    <div data-testid="dashboard-layout" data-title={title}>
      {children}
    </div>
  ),
}));

vi.mock("../../components/NavGroups", () => ({
  useNavGroups: () => [],
}));

vi.mock("../../lib/session", () => ({
  useSessionAudience: () => ({
    audience: hoisted.audience,
    isLoading: hoisted.audienceLoading,
  }),
}));

const InReview = (await import("../InReview")).default;
const Approved = (await import("../Approved")).default;
const Rejected = (await import("../Rejected")).default;

beforeEach(() => {
  hoisted.audience = "internal";
  hoisted.audienceLoading = false;
  hoisted.items = [];
  hoisted.isLoading = false;
  hoisted.isError = false;
  hoisted.hookCalls = [];
});

afterEach(() => {
  cleanup();
});

function makeItem(overrides: Partial<QueueItem>): QueueItem {
  return {
    submissionId: "sub-1",
    engagementId: "eng-1",
    engagementName: "Riverside Clinic",
    jurisdiction: "Bastrop, TX",
    address: "100 River Rd",
    applicantFirm: null,
    submittedAt: "2026-04-30T12:00:00Z",
    status: "approved",
    note: null,
    reviewerComment: null,
    ...overrides,
  };
}

describe("QueueBucketPage", () => {
  it("forwards the corrections_requested status filter for InReview", () => {
    render(<InReview />);
    expect(hoisted.hookCalls).toHaveLength(1);
    expect(hoisted.hookCalls[0]!.params).toEqual({
      status: "corrections_requested",
    });
  });

  it("forwards the approved status filter + respondedAt order for Approved", () => {
    // Approved.tsx + Rejected.tsx pass `order="respondedAt"` (Task #380
    // pre-Track-1) so freshest decisions surface first; the sidebar
    // count and page share the same react-query cache entry, so the
    // expected params here must spell the param out verbatim.
    render(<Approved />);
    expect(hoisted.hookCalls[0]!.params).toEqual({
      status: "approved",
      order: "respondedAt",
    });
  });

  it("forwards the rejected status filter + respondedAt order for Rejected", () => {
    render(<Rejected />);
    expect(hoisted.hookCalls[0]!.params).toEqual({
      status: "rejected",
      order: "respondedAt",
    });
  });

  it("renders the bucket-specific empty copy when the queue is empty", () => {
    render(<Approved />);
    const empty = screen.getByTestId("review-queue-empty");
    expect(empty).toHaveTextContent("No approved submissions yet.");
  });

  it("renders rows that deep-link to EngagementDetail with submission + tab", () => {
    hoisted.items = [
      makeItem({
        submissionId: "sub-A",
        engagementId: "eng-A",
        engagementName: "Riverside Clinic",
        status: "approved",
      }),
    ];
    render(<Approved />);
    const row = screen.getByTestId("reviewer-queue-row-sub-A");
    expect(row.getAttribute("href")).toBe(
      "/engagements/eng-A?submission=sub-A&tab=note",
    );
    expect(row).toHaveTextContent("Riverside Clinic");
  });

  it("renders the access-denied banner and skips the fetch for non-reviewer audiences", () => {
    hoisted.audience = "user";
    render(<InReview />);
    expect(
      screen.getByTestId("in-review-not-reviewer"),
    ).toHaveTextContent("In Review is reviewer-only.");
    expect(hoisted.hookCalls).toHaveLength(1);
    const opts = hoisted.hookCalls[0]!.options as {
      query?: { enabled?: boolean };
    };
    expect(opts.query?.enabled).toBe(false);
    expect(
      screen.queryByTestId("reviewer-queue-row-sub-1"),
    ).not.toBeInTheDocument();
  });

  it("enables the fetch when the audience is internal", () => {
    hoisted.audience = "internal";
    render(<Rejected />);
    const opts = hoisted.hookCalls[0]!.options as {
      query?: { enabled?: boolean };
    };
    expect(opts.query?.enabled).toBe(true);
  });

  it("renders the page count summary off the rendered rows", () => {
    hoisted.items = [
      makeItem({ submissionId: "s1", status: "approved" }),
      makeItem({ submissionId: "s2", status: "approved" }),
      makeItem({ submissionId: "s3", status: "approved" }),
    ];
    render(<Approved />);
    expect(screen.getByTestId("approved-summary")).toHaveTextContent(
      "3 submissions",
    );
  });
});
