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

class MockApiError extends Error {
  readonly name = "ApiError";
  constructor(public readonly status: number) {
    super(`mock api error ${status}`);
  }
}

vi.mock("@workspace/api-client-react", () => ({
  ApiError: MockApiError,
  useListReviewerQueue: () => ({
    data: hoisted.queue,
    isLoading: hoisted.isLoading,
    isError: hoisted.isError,
  }),
  getListReviewerQueueQueryKey: () => ["listReviewerQueue"],
}));

// Hoisted holder for the discipline-filter mock state — each test
// reassigns this between renders to drive the no-disciplines / admin
// / configured-reviewer branches without re-mocking the whole module.
const disciplineFilterState = vi.hoisted(() => ({
  selected: new Set<string>(),
  isShowingAll: true,
  userHasNoDisciplines: false,
  isAdmin: false,
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
  // Track 1 — the chip-bar narrowing hook + presentational chip strip.
  // Tests drive the four hook branches via `disciplineFilterState` so a
  // single shared mock factory suffices for every adopting test.
  useReviewerDisciplineFilter: () => ({
    selected: disciplineFilterState.selected,
    allDisciplines: [
      "building",
      "electrical",
      "mechanical",
      "plumbing",
      "residential",
      "fire-life-safety",
      "accessibility",
    ],
    isShowingAll: disciplineFilterState.isShowingAll,
    userHasNoDisciplines: disciplineFilterState.userHasNoDisciplines,
    isAdmin: disciplineFilterState.isAdmin,
    toggle: () => {},
    showAll: () => {},
    resetToMine: () => {},
  }),
  DisciplineFilterChipBar: () => (
    <div data-testid="discipline-filter-chip-bar" />
  ),
  PLAN_REVIEW_DISCIPLINE_LABELS: {
    building: "Building",
    electrical: "Electrical",
    mechanical: "Mechanical",
    plumbing: "Plumbing",
    residential: "Residential",
    "fire-life-safety": "Fire/Life Safety",
    accessibility: "Accessibility",
  },
  // ReviewerQueueList renders the strip from the new module — but
  // the queue-list component itself isn't mocked in this test, only
  // its inner ReviewerQueueTriageStrip indirectly imports the badge.
  // Stub the badge so it doesn't crash on missing CSS.
  ReviewerDisciplineBadge: ({ discipline }: { discipline: string }) => (
    <span data-testid={`reviewer-discipline-badge-${discipline}`} />
  ),
  Hovercard: ({
    trigger,
    children,
  }: {
    trigger: ReactNode;
    children: ReactNode;
  }) => (
    <span>
      {trigger}
      {children}
    </span>
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
  // Reset the discipline-filter state so tests opt into specific
  // branches rather than carrying state across them.
  disciplineFilterState.selected = new Set();
  disciplineFilterState.isShowingAll = true;
  disciplineFilterState.userHasNoDisciplines = false;
  disciplineFilterState.isAdmin = false;
  // Each test starts with the banner-dismissed key cleared so the
  // banner renders by default for the no-disciplines branch.
  window.localStorage.clear();
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

  it("renders applicantFirm next to the engagement title when present", () => {
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
    const firm = screen.getByTestId("reviewer-queue-row-sub-A-firm");
    expect(firm).toHaveTextContent("Civic Design LLC");
    const subtitle = screen.getByTestId(
      "reviewer-queue-row-sub-A-subtitle",
    );
    expect(subtitle).toHaveTextContent("Bastrop, TX");
    expect(subtitle).toHaveTextContent("100 River Rd");
  });

  it("omits the firm pill when applicantFirm is null", () => {
    hoisted.queue = {
      items: [
        makeItem({
          submissionId: "sub-A",
          applicantFirm: null,
        }),
      ],
      counts: { inReview: 0, awaitingAi: 1, rejected: 0, backlog: 1 },
    };
    render(<ReviewConsole />);
    expect(
      screen.queryByTestId("reviewer-queue-row-sub-A-firm"),
    ).not.toBeInTheDocument();
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

  describe("Track 1 — discipline filter + no-disciplines banner", () => {
    it("renders the no-disciplines banner for a non-admin reviewer with empty disciplines", () => {
      // Empty disciplines + non-admin → the banner is the FE's
      // ask-your-admin nudge, since the brief defers self-edit
      // out of Track 1 scope (Q3 resolution: option (a)).
      disciplineFilterState.userHasNoDisciplines = true;
      disciplineFilterState.isAdmin = false;
      hoisted.queue = {
        items: [],
        counts: { inReview: 0, awaitingAi: 0, rejected: 0, backlog: 0 },
      };
      render(<ReviewConsole />);
      const banner = screen.getByTestId(
        "review-console-no-disciplines-banner",
      );
      expect(banner).toHaveTextContent(/ask your admin/i);
    });

    it("hides the banner for an admin (admins see everything by default)", () => {
      disciplineFilterState.userHasNoDisciplines = true;
      disciplineFilterState.isAdmin = true;
      hoisted.queue = {
        items: [],
        counts: { inReview: 0, awaitingAi: 0, rejected: 0, backlog: 0 },
      };
      render(<ReviewConsole />);
      expect(
        screen.queryByTestId("review-console-no-disciplines-banner"),
      ).not.toBeInTheDocument();
    });

    it("dismissing the banner persists the dismissal across remount", () => {
      disciplineFilterState.userHasNoDisciplines = true;
      disciplineFilterState.isAdmin = false;
      hoisted.queue = {
        items: [],
        counts: { inReview: 0, awaitingAi: 0, rejected: 0, backlog: 0 },
      };
      const { unmount } = render(<ReviewConsole />);
      fireEvent.click(
        screen.getByTestId(
          "review-console-no-disciplines-banner-dismiss",
        ),
      );
      // Dismissed in this render — gone immediately.
      expect(
        screen.queryByTestId("review-console-no-disciplines-banner"),
      ).not.toBeInTheDocument();
      unmount();
      cleanup();
      // Re-mount; the banner stays dismissed because the localStorage
      // flag was written. Surface tests assert that the banner does
      // not re-appear on every page navigation.
      render(<ReviewConsole />);
      expect(
        screen.queryByTestId("review-console-no-disciplines-banner"),
      ).not.toBeInTheDocument();
    });

    it("renders the discipline-attributable empty-state when the chip-bar zeroes the queue", () => {
      // The queue has a row, but the active discipline filter
      // (electrical) doesn't intersect the row's classification
      // (building only) — empty-state copy must call this out
      // explicitly so the reviewer doesn't think the queue is
      // genuinely empty.
      disciplineFilterState.userHasNoDisciplines = false;
      disciplineFilterState.isAdmin = false;
      disciplineFilterState.isShowingAll = false;
      disciplineFilterState.selected = new Set(["electrical"]);
      hoisted.queue = {
        items: [
          {
            ...makeItem({ submissionId: "sub-1", engagementId: "eng-1" }),
            classification: {
              submissionId: "sub-1",
              projectType: "single-family-residence",
              disciplines: ["building"],
              applicableCodeBooks: [],
              confidence: 0.9,
              source: "auto",
              classifiedAt: "2026-05-01T12:00:00Z",
              classifiedBy: null,
            },
          } as NonNullable<typeof hoisted.queue>["items"][number],
        ],
        counts: { inReview: 0, awaitingAi: 1, rejected: 0, backlog: 1 },
      };
      render(<ReviewConsole />);
      const empty = screen.getByTestId(
        "review-queue-empty-discipline-filter",
      );
      expect(empty).toHaveTextContent("Electrical");
      expect(
        screen.getByTestId("review-queue-empty-discipline-show-all"),
      ).toBeInTheDocument();
    });
  });
});
