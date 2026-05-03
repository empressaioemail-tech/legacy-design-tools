/**
 * Task #493 — Compliance Engine console tests.
 *
 * Pinned behaviors:
 *  1. Reviewer-only: nav entry hides for non-internal audience and
 *     `/compliance` route renders the shared `access-denied` screen.
 *  2. Filter tabs flip the typed `state` query param passed to
 *     `useListFindingsRuns` (`all` omits it; `pending|succeeded|failed`
 *     pass through).
 *  3. Each row exposes a deep link into the SubmissionDetailModal
 *     Findings tab (`/engagements/:id?submission=:sid&tab=findings`),
 *     not just the side detail panel.
 *  4. Re-run is disabled whenever any pending run for the same
 *     submission is in the feed (single-flight UX), independent of
 *     local mutation state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router, Route, Switch } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import type { ReactNode } from "react";

const hoisted = vi.hoisted(() => ({
  audience: "internal" as "internal" | "user" | "ai" | null,
  audienceLoading: false,
  runs: [] as Array<{
    generationId: string;
    submissionId: string;
    engagementId: string;
    engagementName: string;
    jurisdiction: string | null;
    state: "pending" | "succeeded" | "failed";
    startedAt: string;
    completedAt: string | null;
    durationMs: number | null;
    error: string | null;
    invalidCitationCount: number | null;
    invalidCitations: string[] | null;
    discardedFindingCount: number | null;
  }>,
  lastListParams: undefined as undefined | { state?: string },
  generateMutate: vi.fn() as ReturnType<typeof vi.fn>,
  generateIsPending: false,
  statusState: "idle" as "idle" | "pending" | "completed" | "failed",
}));

vi.mock("@workspace/api-client-react", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    data: unknown;
    constructor(status: number, message: string, data: unknown) {
      super(message);
      this.status = status;
      this.data = data;
    }
  },
  useGetSession: () => ({
    data: { audience: hoisted.audience, permissions: [], requestor: null },
    isLoading: hoisted.audienceLoading,
  }),
  getGetSessionQueryKey: () => ["getSession"],
  useListMyReviewerRequests: () => ({
    data: { requests: [] },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: () => {},
  }),
  getListMyReviewerRequestsQueryKey: () => ["listMyReviewerRequests"],
  useListFindingsRuns: (
    params?: { state?: string },
    _opts?: unknown,
  ) => {
    hoisted.lastListParams = params;
    return {
      data: { runs: hoisted.runs },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: () => {},
    };
  },
  getListFindingsRunsQueryKey: (params?: { state?: string }) => [
    "listFindingsRuns",
    params?.state ?? "all",
  ],
  useGetFindingsRunsSummary: () => ({
    data: {
      totalRuns: { value: 12 },
      successRate: { value: 83 },
      avgDurationMs: { value: 4200 },
      invalidCitationsTotal: { value: 0 },
      discardedFindingsTotal: { value: 0 },
    },
    isLoading: false,
    isFetching: false,
    refetch: () => {},
  }),
  getGetFindingsRunsSummaryQueryKey: () => ["findingsRunsSummary"],
  useGenerateSubmissionFindings: (opts?: {
    mutation?: {
      onSuccess?: (d: unknown, v: unknown, c: unknown) => void;
      onError?: (e: unknown, v: unknown, c: unknown) => void;
    };
  }) => ({
    mutate: (vars: unknown) => {
      hoisted.generateMutate(vars);
      opts?.mutation?.onSuccess?.({ generationId: "g_new" }, vars, undefined);
    },
    isPending: hoisted.generateIsPending,
  }),
  useGetSubmissionFindingsGenerationStatus: (
    submissionId: string,
    _opts?: unknown,
  ) => ({
    data: submissionId
      ? {
          generationId: null,
          state: hoisted.statusState,
          startedAt: null,
          completedAt: null,
          error: null,
          invalidCitationCount: null,
          invalidCitations: null,
          discardedFindingCount: null,
        }
      : undefined,
    isLoading: false,
  }),
  getGetSubmissionFindingsGenerationStatusQueryKey: (id: string) => [
    "findingsGenerationStatus",
    id,
  ],
}));

vi.mock("@workspace/portal-ui", () => ({
  DashboardLayout: ({
    children,
    rightPanel,
  }: {
    children: ReactNode;
    rightPanel?: ReactNode;
  }) => (
    <div data-testid="dashboard-layout">
      {children}
      {rightPanel}
    </div>
  ),
}));

const ComplianceEngine = (await import("../ComplianceEngine")).default;
const { RequireAudience } = await import("../../components/permissions");
const { filterNavGroups, useNavGroups } = await import(
  "../../components/NavGroups"
);

function makeRun(over: Partial<(typeof hoisted.runs)[number]> & {
  generationId: string;
  submissionId: string;
}): (typeof hoisted.runs)[number] {
  return {
    generationId: over.generationId,
    submissionId: over.submissionId,
    engagementId: over.engagementId ?? "eng-1",
    engagementName: over.engagementName ?? "Riverside Library",
    jurisdiction: over.jurisdiction ?? "Moab, UT",
    state: over.state ?? "succeeded",
    startedAt: over.startedAt ?? "2026-04-01T00:00:00.000Z",
    completedAt: over.completedAt ?? "2026-04-01T00:00:05.000Z",
    durationMs: over.durationMs ?? 5000,
    error: over.error ?? null,
    invalidCitationCount: over.invalidCitationCount ?? 0,
    invalidCitations: over.invalidCitations ?? null,
    discardedFindingCount: over.discardedFindingCount ?? 0,
  };
}

function renderAt(initialPath: string) {
  const memory = memoryLocation({ path: initialPath, record: true });
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <Router hook={memory.hook}>
        <Switch>
          <Route path="/compliance">
            <RequireAudience audience="internal">
              <ComplianceEngine />
            </RequireAudience>
          </Route>
        </Switch>
      </Router>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  hoisted.audience = "internal";
  hoisted.audienceLoading = false;
  hoisted.runs = [];
  hoisted.lastListParams = undefined;
  hoisted.generateMutate = vi.fn();
  hoisted.generateIsPending = false;
  hoisted.statusState = "idle";
});

afterEach(() => cleanup());

describe("ComplianceEngine — audience gating", () => {
  it("hides the Compliance Engine nav entry for non-internal audiences", () => {
    // Non-internal audience: every `requiresAudience: "internal"`
    // entry — including Compliance Engine — must be filtered out.
    const groups = filterNavGroups([], "user");
    const labels = groups.flatMap((g) => g.items.map((i) => i.label));
    expect(labels).not.toContain("Compliance Engine");

    // And the matching internal-audience render does include it,
    // so the gate is genuinely audience-driven not perma-hidden.
    const internalGroups = filterNavGroups([], "internal");
    const internalLabels = internalGroups.flatMap((g) =>
      g.items.map((i) => i.label),
    );
    expect(internalLabels).toContain("Compliance Engine");
  });

  it("renders the shared access-denied screen when audience !== internal", () => {
    hoisted.audience = "user";
    renderAt("/compliance");
    expect(screen.getByTestId("access-denied")).toBeTruthy();
    expect(screen.queryByTestId("compliance-runs-list")).toBeNull();
  });
});

describe("ComplianceEngine — filters", () => {
  it("omits the state param when 'All' is selected and passes it for explicit tabs", () => {
    hoisted.runs = [makeRun({ generationId: "g_1", submissionId: "sub_1" })];
    renderAt("/compliance");
    expect(hoisted.lastListParams).toBeUndefined();

    fireEvent.click(screen.getByTestId("compliance-filter-pending"));
    expect(hoisted.lastListParams).toEqual({ state: "pending" });

    fireEvent.click(screen.getByTestId("compliance-filter-failed"));
    expect(hoisted.lastListParams).toEqual({ state: "failed" });

    fireEvent.click(screen.getByTestId("compliance-filter-all"));
    expect(hoisted.lastListParams).toBeUndefined();
  });
});

describe("ComplianceEngine — row deep links", () => {
  it("renders each row's title and chevron as Findings-tab deep links", () => {
    hoisted.runs = [
      makeRun({
        generationId: "g_1",
        submissionId: "sub_1",
        engagementId: "eng_42",
      }),
    ];
    renderAt("/compliance");
    const expected = "/engagements/eng_42?submission=sub_1&tab=findings";
    const titleLink = screen
      .getByTestId("compliance-run-row-g_1-link")
      .getAttribute("href");
    const chevronLink = screen
      .getByTestId("compliance-run-row-g_1-chevron")
      .getAttribute("href");
    expect(titleLink).toBe(expected);
    expect(chevronLink).toBe(expected);
  });
});

describe("ComplianceEngine — re-run single-flight", () => {
  it("disables the re-run button when a pending run for the submission exists in the feed", () => {
    // Two rows for the same submission: a fresh pending one + an older
    // completed one. Selecting the older row must STILL disable re-run
    // because a pending run already covers this submission.
    hoisted.runs = [
      makeRun({
        generationId: "g_pending",
        submissionId: "sub_1",
        state: "pending",
        completedAt: null,
        durationMs: null,
      }),
      makeRun({
        generationId: "g_old",
        submissionId: "sub_1",
        state: "succeeded",
      }),
    ];
    renderAt("/compliance");

    // Select the older row — pending row exists for the same submission
    fireEvent.click(screen.getByTestId("compliance-run-row-g_old"));
    const button = screen.getByTestId(
      "compliance-run-detail-rerun",
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toMatch(/Re-running/);
  });

  it("invokes useGenerateSubmissionFindings with the selected submissionId on click", () => {
    hoisted.runs = [
      makeRun({
        generationId: "g_done",
        submissionId: "sub_99",
        state: "succeeded",
      }),
    ];
    renderAt("/compliance");
    fireEvent.click(screen.getByTestId("compliance-run-detail-rerun"));
    expect(hoisted.generateMutate).toHaveBeenCalledWith({
      submissionId: "sub_99",
      data: {},
    });
  });
});
