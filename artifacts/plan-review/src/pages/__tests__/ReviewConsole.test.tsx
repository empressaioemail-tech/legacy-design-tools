/**
 * ReviewConsole — wiring tests against `useListReviewerQueue`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";

const hoisted = vi.hoisted(() => ({
  queue: null as null | {
    items: Array<{
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
    }>;
    counts: {
      inReview: number;
      awaitingAi: number;
      rejected: number;
      backlog: number;
    };
  },
  isLoading: false,
  isError: false,
}));

vi.mock("@workspace/api-client-react", () => ({
  useListReviewerQueue: () => ({
    data: hoisted.queue,
    isLoading: hoisted.isLoading,
    isError: hoisted.isError,
  }),
  getListReviewerQueueQueryKey: () => ["listReviewerQueue"],
}));

vi.mock("@workspace/portal-ui", () => ({
  DashboardLayout: ({
    children,
    rightPanel,
    search,
  }: {
    children: ReactNode;
    rightPanel?: ReactNode;
    search?: {
      placeholder?: string;
      value: string;
      onChange: (v: string) => void;
    };
  }) => (
    <div data-testid="dashboard-layout">
      {search ? (
        <input
          data-testid="dashboard-search"
          placeholder={search.placeholder}
          value={search.value}
          onChange={(e) => search.onChange(e.target.value)}
        />
      ) : null}
      <div data-testid="dashboard-children">{children}</div>
      <div data-testid="dashboard-right-panel">{rightPanel}</div>
    </div>
  ),
}));

vi.mock("../../components/NavGroups", () => ({
  useNavGroups: () => [],
}));

vi.mock("../../components/AIBriefingPanel", () => ({
  AIBriefingPanel: () => <div data-testid="ai-briefing-panel" />,
}));

const ReviewConsole = (await import("../ReviewConsole")).default;

beforeEach(() => {
  hoisted.queue = null;
  hoisted.isLoading = false;
  hoisted.isError = false;
});

afterEach(() => {
  cleanup();
});

function makeItem(
  overrides: Partial<NonNullable<typeof hoisted.queue>["items"][number]>,
): NonNullable<typeof hoisted.queue>["items"][number] {
  return {
    submissionId: "sub-1",
    engagementId: "eng-1",
    engagementName: "Riverside Clinic",
    jurisdiction: "Bastrop, TX",
    address: "100 River Rd",
    applicantFirm: null,
    submittedAt: "2026-04-30T12:00:00Z",
    status: "pending",
    note: null,
    reviewerComment: null,
    ...overrides,
  };
}

describe("ReviewConsole", () => {
  it("renders the loading state", () => {
    hoisted.isLoading = true;
    render(<ReviewConsole />);
    expect(screen.getByTestId("review-queue-loading")).toBeInTheDocument();
  });

  it("renders the error state", () => {
    hoisted.isError = true;
    render(<ReviewConsole />);
    expect(screen.getByTestId("review-queue-error")).toBeInTheDocument();
  });

  it("renders the empty state with zeroed BACKLOG and placeholder tiles", () => {
    hoisted.queue = {
      items: [],
      counts: { inReview: 0, awaitingAi: 0, rejected: 0, backlog: 0 },
    };
    render(<ReviewConsole />);
    expect(screen.getByTestId("review-queue-empty")).toBeInTheDocument();
    expect(screen.getByTestId("kpi-tile-BACKLOG")).toHaveTextContent("0");
    expect(
      screen.getByTestId("kpi-tile-AVG REVIEW TIME-no-data"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("kpi-tile-AI ACCURACY-no-data"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("kpi-tile-COMPLIANCE RATE-no-data"),
    ).toBeInTheDocument();
  });

  it("renders the BACKLOG dash while loading", () => {
    hoisted.isLoading = true;
    render(<ReviewConsole />);
    expect(screen.getByTestId("kpi-tile-BACKLOG")).toHaveTextContent("—");
  });

  it("renders the header summary + KPI BACKLOG from counts", () => {
    hoisted.queue = {
      items: [makeItem({})],
      counts: { inReview: 4, awaitingAi: 7, rejected: 2, backlog: 11 },
    };
    render(<ReviewConsole />);
    const summary = screen.getByTestId("review-console-summary");
    expect(summary).toHaveTextContent("4 in review");
    expect(summary).toHaveTextContent("7 awaiting AI");
    expect(summary).toHaveTextContent("2 rejected");
    expect(screen.getByTestId("kpi-tile-BACKLOG")).toHaveTextContent("11");
  });

  it("renders one row per item with engagement metadata + deep-link href", () => {
    hoisted.queue = {
      items: [
        makeItem({
          submissionId: "sub-A",
          engagementId: "eng-A",
          engagementName: "Riverside Clinic",
          jurisdiction: "Bastrop, TX",
          address: "100 River Rd",
          status: "pending",
        }),
        makeItem({
          submissionId: "sub-B",
          engagementId: "eng-B",
          engagementName: "Lost Pines Townhomes",
          jurisdiction: "Smithville, TX",
          address: "200 Pine Ave",
          status: "corrections_requested",
        }),
      ],
      counts: { inReview: 1, awaitingAi: 1, rejected: 0, backlog: 2 },
    };
    render(<ReviewConsole />);

    const rowA = screen.getByTestId("reviewer-queue-row-sub-A");
    expect(rowA).toHaveTextContent("Riverside Clinic");
    expect(rowA).toHaveTextContent("Bastrop, TX");
    expect(rowA).toHaveTextContent("100 River Rd");
    expect(rowA.getAttribute("href")).toBe(
      "/engagements/eng-A?submission=sub-A&tab=note",
    );

    const rowB = screen.getByTestId("reviewer-queue-row-sub-B");
    expect(rowB).toHaveTextContent("Lost Pines Townhomes");
    expect(rowB).toHaveTextContent("corrections");
    expect(rowB.getAttribute("href")).toBe(
      "/engagements/eng-B?submission=sub-B&tab=note",
    );
  });

  it("renders applicantFirm in the row subtitle when present", () => {
    hoisted.queue = {
      items: [
        makeItem({
          submissionId: "sub-A",
          engagementId: "eng-A",
          engagementName: "Riverside Clinic",
          applicantFirm: "Civic Design LLC",
          jurisdiction: "Bastrop, TX",
          address: "100 River Rd",
        }),
      ],
      counts: { inReview: 0, awaitingAi: 1, rejected: 0, backlog: 1 },
    };
    render(<ReviewConsole />);
    const subtitle = screen.getByTestId(
      "reviewer-queue-row-sub-A-subtitle",
    );
    expect(subtitle).toHaveTextContent("Civic Design LLC");
    expect(subtitle).toHaveTextContent("Bastrop, TX");
    expect(subtitle).toHaveTextContent("100 River Rd");
  });

  it("filters rows by the search box", () => {
    hoisted.queue = {
      items: [
        makeItem({
          submissionId: "sub-A",
          engagementId: "eng-A",
          engagementName: "Riverside Clinic",
          jurisdiction: "Bastrop, TX",
        }),
        makeItem({
          submissionId: "sub-B",
          engagementId: "eng-B",
          engagementName: "Lost Pines Townhomes",
          jurisdiction: "Smithville, TX",
        }),
      ],
      counts: { inReview: 0, awaitingAi: 2, rejected: 0, backlog: 2 },
    };
    render(<ReviewConsole />);

    const search = screen.getByTestId("dashboard-search");
    fireEvent.change(search, { target: { value: "smithville" } });

    expect(
      screen.queryByTestId("reviewer-queue-row-sub-A"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("reviewer-queue-row-sub-B"),
    ).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "no-such-thing" } });
    expect(
      screen.getByTestId("review-queue-no-matches"),
    ).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "civic design" } });
    expect(
      screen.getByTestId("review-queue-no-matches"),
    ).toBeInTheDocument();
  });

  it("matches search against applicantFirm when present", () => {
    hoisted.queue = {
      items: [
        makeItem({
          submissionId: "sub-A",
          engagementId: "eng-A",
          engagementName: "Riverside Clinic",
          applicantFirm: "Civic Design LLC",
        }),
        makeItem({
          submissionId: "sub-B",
          engagementId: "eng-B",
          engagementName: "Lost Pines Townhomes",
          applicantFirm: "Atlas Architects",
        }),
      ],
      counts: { inReview: 0, awaitingAi: 2, rejected: 0, backlog: 2 },
    };
    render(<ReviewConsole />);
    fireEvent.change(screen.getByTestId("dashboard-search"), {
      target: { value: "atlas" },
    });
    expect(
      screen.queryByTestId("reviewer-queue-row-sub-A"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("reviewer-queue-row-sub-B"),
    ).toBeInTheDocument();
  });
});
