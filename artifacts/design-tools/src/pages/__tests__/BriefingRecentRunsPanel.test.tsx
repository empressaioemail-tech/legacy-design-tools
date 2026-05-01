/**
 * BriefingRecentRunsPanel — UI coverage for Task #230.
 *
 * The sweep that retains the last N briefing-generation rows
 * (`briefingGenerationJobsSweep#DEFAULT_KEEP_PER_ENGAGEMENT`) is
 * silent on its own — once the rows are kept, an auditor still
 * needs a surface to look at them. This test pins the behaviors
 * the disclosure inside the SiteContextTab's BriefingNarrativePanel
 * adds:
 *
 *   1. The disclosure is collapsed by default and does NOT call the
 *      runs hook (saves a round trip on every page load), then opens
 *      to render every retained row newest-first with state badges
 *      and timestamps.
 *   2. Clicking a row reveals its outcome details inline — `error`
 *      for the failed branch, `invalidCitationCount` for the
 *      completed branch — without navigating away from the briefing.
 *   3. A successful kickoff invalidates the runs query key so the
 *      newly-inserted pending row appears at the top of the list
 *      without a manual refresh.
 *
 * The setup mirrors `SiteContextTab.test.tsx` (Task #177) — same
 * hoisted-mock + `?tab=site-context` deep-link approach, with the
 * three Task-#230 hooks (`useListEngagementBriefingGenerationRuns`,
 * `getListEngagementBriefingGenerationRunsQueryKey`,
 * `useGenerateEngagementBriefing`) wired so the test can mutate the
 * runs list between assertions and synthesize a kickoff success.
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
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

type RunState = "pending" | "completed" | "failed";

interface FakeRun {
  generationId: string;
  state: RunState;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  invalidCitationCount: number | null;
}

// ── Hoisted mock state ──────────────────────────────────────────────────
//
// `runs` is the single source of truth the runs hook reads from on
// every queryFn invocation, so a test can push a new pending row
// after firing the kickoff `onSuccess` and the next refetch will
// see it. `capturedGenerateBriefingOptions` captures the kickoff
// hook's `mutation` options so a test can drive `onSuccess`
// directly without having to fabricate a real fetch round-trip
// under happy-dom.
const hoisted = vi.hoisted(() => {
  const initialRuns: Array<{
    generationId: string;
    state: "pending" | "completed" | "failed";
    startedAt: string;
    completedAt: string | null;
    error: string | null;
    invalidCitationCount: number | null;
  }> = [];
  return {
    engagement: {
      id: "eng-1",
      name: "Boulder Studio",
      jurisdiction: "Boulder, CO",
      address: "100 Walnut St, Boulder, CO",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      snapshotCount: 0,
      latestSnapshot: null,
      snapshots: [] as unknown[],
      site: null as unknown,
      revitCentralGuid: null as string | null,
      revitDocumentPath: null as string | null,
    },
    runs: initialRuns,
    runsHookCalls: 0,
    runsFetchCalls: 0,
    capturedGenerateBriefingOptions: null as null | {
      mutation?: {
        onSuccess?: (
          data: unknown,
          variables: unknown,
          context: unknown,
        ) => Promise<void> | void;
      };
    },
    generateBriefingMutate: vi.fn(),
  };
});

vi.mock("wouter", async () => {
  const actual = await vi.importActual<typeof import("wouter")>("wouter");
  return {
    ...actual,
    useParams: () => ({ id: hoisted.engagement.id }),
  };
});

vi.mock("@workspace/api-zod", () => ({
  createEngagementSubmissionBodyNoteMax: 2048,
  recordSubmissionResponseBodyReviewerCommentMax: 2048,
}));

// Leaflet's CSS / image side-effects don't survive happy-dom; the
// page imports SiteMap unconditionally even though the Site tab
// is never activated here.
vi.mock("@workspace/site-context/client", () => ({
  SiteMap: () => null,
}));

vi.mock("@workspace/api-client-react", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  class MockApiError extends Error {
    readonly name = "ApiError" as const;
    status: number;
    data: unknown;
    constructor(status: number, data: unknown = null, message?: string) {
      super(message ?? `HTTP ${status}`);
      Object.setPrototypeOf(this, MockApiError.prototype);
      this.status = status;
      this.data = data;
    }
  }
  return {
    ApiError: MockApiError,
    RecordSubmissionResponseBodyStatus: {
      approved: "approved",
      corrections_requested: "corrections_requested",
      rejected: "rejected",
    },
    useRecordSubmissionResponse: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
    getGetEngagementQueryKey: (id: string) => ["getEngagement", id],
    getGetSnapshotQueryKey: (id: string) => ["getSnapshot", id],
    getListEngagementsQueryKey: () => ["listEngagements"],
    getListEngagementSubmissionsQueryKey: (id: string) => [
      "listEngagementSubmissions",
      id,
    ],
    getGetEngagementBriefingQueryKey: (id: string) => [
      "getEngagementBriefing",
      id,
    ],
    getListEngagementBriefingSourcesQueryKey: (id: string) => [
      "listEngagementBriefingSources",
      id,
    ],
    getListBimModelDivergencesQueryKey: (id: string) => [
      "listBimModelDivergences",
      id,
    ],
    getGetEngagementBriefingGenerationStatusQueryKey: (id: string) => [
      "getEngagementBriefingGenerationStatus",
      id,
    ],
    // Task #230 — the new key the disclosure invalidates on
    // kickoff and on the pending → terminal transition.
    getListEngagementBriefingGenerationRunsQueryKey: (id: string) => [
      "listEngagementBriefingGenerationRuns",
      id,
    ],
    getGetAtomHistoryQueryKey: (
      scope: string,
      id: string,
      params?: unknown,
    ) => ["getAtomHistory", scope, id, params ?? {}],
    getGetAtomSummaryQueryKey: (scope: string, id: string) => [
      "getAtomSummary",
      scope,
      id,
    ],
    getGetSessionQueryKey: () => ["getSession"],
    useGetSession: () =>
      useQuery({
        queryKey: ["getSession"],
        queryFn: async () => ({ permissions: [] as string[] }),
      }),
    useListEngagements: (opts?: {
      query?: { queryKey?: readonly unknown[] };
    }) =>
      useQuery({
        queryKey: opts?.query?.queryKey ?? (["listEngagements"] as const),
        queryFn: async () => [{ ...hoisted.engagement }],
      }),
    useGetEngagement: (
      id: string,
      opts?: { query?: { queryKey?: readonly unknown[] } },
    ) =>
      useQuery({
        queryKey: opts?.query?.queryKey ?? (["getEngagement", id] as const),
        queryFn: async () => ({ ...hoisted.engagement }),
      }),
    useGetSnapshot: (
      id: string,
      opts?: { query?: { enabled?: boolean; queryKey?: readonly unknown[] } },
    ) =>
      useQuery({
        queryKey: opts?.query?.queryKey ?? (["getSnapshot", id] as const),
        queryFn: async () => null,
        enabled: opts?.query?.enabled ?? false,
      }),
    useUpdateEngagement: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
    useGetAtomHistory: () => ({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    }),
    useGetAtomSummary: () => ({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    }),
    useListEngagementSubmissions: (
      id: string,
      opts?: { query?: { queryKey?: readonly unknown[] } },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ?? (["listEngagementSubmissions", id] as const),
        queryFn: async () => [],
      }),
    useCreateEngagementSubmission: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
    useGetEngagementBriefing: (
      id: string,
      opts?: { query?: { queryKey?: readonly unknown[] } },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ?? (["getEngagementBriefing", id] as const),
        queryFn: async () => ({ briefing: null }),
      }),
    useListEngagementBriefingSources: (
      id: string,
      opts?: { query?: { queryKey?: readonly unknown[] } },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ??
          (["listEngagementBriefingSources", id] as const),
        queryFn: async () => [],
      }),
    useGetEngagementBriefingGenerationStatus: (
      id: string,
      opts?: { query?: { queryKey?: readonly unknown[] } },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ??
          (["getEngagementBriefingGenerationStatus", id] as const),
        queryFn: async () => ({ state: "idle" as const }),
      }),
    // Task #230 — the hook the disclosure calls. We honor the
    // `enabled` flag from the panel so the "collapsed = no fetch"
    // assertion can pass; queryFn re-reads `hoisted.runs` on every
    // refetch so a test can push a row after a kickoff and the
    // invalidate triggered by `onSuccess` will pick it up.
    useListEngagementBriefingGenerationRuns: (
      id: string,
      opts?: {
        query?: {
          queryKey?: readonly unknown[];
          enabled?: boolean;
          refetchOnWindowFocus?: boolean;
        };
      },
    ) => {
      hoisted.runsHookCalls += 1;
      return useQuery({
        queryKey:
          opts?.query?.queryKey ??
          (["listEngagementBriefingGenerationRuns", id] as const),
        queryFn: async () => {
          hoisted.runsFetchCalls += 1;
          // The route returns `runs` newest-first; the hoisted
          // array is treated as already in newest-first order so
          // each test can shift new pending rows onto the front.
          return { runs: hoisted.runs.map((r) => ({ ...r })) };
        },
        enabled: opts?.query?.enabled ?? true,
        refetchOnWindowFocus: opts?.query?.refetchOnWindowFocus ?? true,
      });
    },
    useGenerateEngagementBriefing: (
      options: typeof hoisted.capturedGenerateBriefingOptions,
    ) => {
      hoisted.capturedGenerateBriefingOptions = options;
      return {
        mutate: hoisted.generateBriefingMutate,
        isPending: false,
      };
    },
    useCreateEngagementBriefingSource: () => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
    }),
    useRestoreEngagementBriefingSource: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
    useRetryBriefingSourceConversion: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
    useGenerateEngagementLayers: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
    // PushToRevitAffordance fan-in — inert stubs are enough,
    // the affordance is not asserted against here.
    getGetEngagementBimModelQueryKey: (id: string) => [
      "getEngagementBimModel",
      id,
    ],
    getGetBimModelRefreshQueryKey: (id: string) => [
      "getBimModelRefresh",
      id,
    ],
    useGetEngagementBimModel: (
      id: string,
      opts?: { query?: { queryKey?: readonly unknown[] } },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ?? (["getEngagementBimModel", id] as const),
        queryFn: async () => ({ bimModel: null }),
      }),
    useGetBimModelRefresh: (
      id: string,
      opts?: { query?: { enabled?: boolean; queryKey?: readonly unknown[] } },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ?? (["getBimModelRefresh", id] as const),
        queryFn: async () => null,
        enabled: opts?.query?.enabled ?? false,
      }),
    usePushEngagementBimModel: () => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
    }),
    useListBimModelDivergences: (
      id: string,
      opts?: { query?: { enabled?: boolean; queryKey?: readonly unknown[] } },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ??
          (["listBimModelDivergences", id] as const),
        queryFn: async () => ({ divergences: [] }),
        enabled: opts?.query?.enabled ?? false,
      }),
  };
});

const { EngagementDetail } = await import("../EngagementDetail");

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderPage() {
  const client = makeQueryClient();
  // Pre-seed the caches the page reads on first paint so it lands
  // fully on the Site Context tab without async waits.
  client.setQueryData(["getEngagement", hoisted.engagement.id], {
    ...hoisted.engagement,
  });
  client.setQueryData(["listEngagements"], [{ ...hoisted.engagement }]);
  client.setQueryData(["getSession"], { permissions: [] as string[] });
  // The page reads the active tab from `?tab=…` once on mount, so
  // this lands directly on the Site Context tab where
  // BriefingNarrativePanel (and its Recent runs disclosure) is mounted.
  window.history.replaceState(null, "", "/?tab=site-context");
  const node: ReactNode = (
    <QueryClientProvider client={client}>
      <EngagementDetail />
    </QueryClientProvider>
  );
  const utils = render(node);
  return { ...utils, client };
}

function makeRun(overrides: Partial<FakeRun> & { generationId: string }): FakeRun {
  return {
    state: "completed",
    startedAt: "2026-04-01T10:00:00.000Z",
    completedAt: "2026-04-01T10:00:05.000Z",
    error: null,
    invalidCitationCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  hoisted.engagement = {
    id: "eng-1",
    name: "Boulder Studio",
    jurisdiction: "Boulder, CO",
    address: "100 Walnut St, Boulder, CO",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    snapshotCount: 0,
    latestSnapshot: null,
    snapshots: [],
    site: null,
    revitCentralGuid: null,
    revitDocumentPath: null,
  };
  hoisted.runs = [];
  hoisted.runsHookCalls = 0;
  hoisted.runsFetchCalls = 0;
  hoisted.capturedGenerateBriefingOptions = null;
  hoisted.generateBriefingMutate.mockReset();
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("BriefingRecentRunsPanel (Task #230)", () => {
  it("starts collapsed and opens to show retained runs newest-first with state badges", async () => {
    // Three retained runs spanning the wire enum: a pending most-recent
    // attempt, a successfully-completed prior run, and an older failed
    // attempt. Newest-first ordering mirrors what the route returns,
    // so the array is already in display order.
    hoisted.runs = [
      makeRun({
        generationId: "gen-3",
        state: "pending",
        startedAt: "2026-04-03T10:00:00.000Z",
        completedAt: null,
      }),
      makeRun({
        generationId: "gen-2",
        state: "completed",
        startedAt: "2026-04-02T10:00:00.000Z",
        completedAt: "2026-04-02T10:00:04.000Z",
        invalidCitationCount: 2,
      }),
      makeRun({
        generationId: "gen-1",
        state: "failed",
        startedAt: "2026-04-01T10:00:00.000Z",
        completedAt: "2026-04-01T10:00:03.000Z",
        error: "OpenAI 503 — upstream unavailable",
      }),
    ];

    renderPage();

    // The disclosure container is always present; the body and the
    // runs hook itself stay dormant until the toggle flips.
    const container = await screen.findByTestId("briefing-recent-runs");
    expect(container).toBeInTheDocument();
    expect(
      screen.queryByTestId("briefing-recent-runs-body"),
    ).not.toBeInTheDocument();
    // The hook is consulted (so it can register `enabled: false`),
    // but no actual fetch should have fired against the runs route.
    expect(hoisted.runsFetchCalls).toBe(0);

    // Open the disclosure.
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));

    // Once enabled, the runs hook fetches and the body paints with
    // every retained row. We wait on the list because the underlying
    // useQuery resolves on a microtask.
    const list = await screen.findByTestId("briefing-recent-runs-list");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    // Newest-first — `gen-3` (pending) first, `gen-1` (failed) last.
    expect(items[0]).toHaveAttribute(
      "data-testid",
      "briefing-run-gen-3",
    );
    expect(items[1]).toHaveAttribute(
      "data-testid",
      "briefing-run-gen-2",
    );
    expect(items[2]).toHaveAttribute(
      "data-testid",
      "briefing-run-gen-1",
    );
    // State badges render the friendly enum label, one per row.
    expect(
      within(items[0]).getByTestId("briefing-run-state-badge-pending"),
    ).toHaveTextContent(/Running/i);
    expect(
      within(items[1]).getByTestId("briefing-run-state-badge-completed"),
    ).toHaveTextContent(/Completed/i);
    expect(
      within(items[2]).getByTestId("briefing-run-state-badge-failed"),
    ).toHaveTextContent(/Failed/i);
    // The completed-with-invalid-citations row surfaces the
    // count summary in the collapsed header so an auditor can spot
    // the suspicious run without expanding it.
    expect(
      within(items[1]).getByTestId("briefing-run-invalid-count-gen-2"),
    ).toHaveTextContent(/2 invalid citations/i);

    // Clicking the toggle again collapses the body.
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));
    expect(
      screen.queryByTestId("briefing-recent-runs-body"),
    ).not.toBeInTheDocument();
  });

  it("expands a row to surface the failure error and invalid-citation detail inline", async () => {
    hoisted.runs = [
      makeRun({
        generationId: "gen-fail",
        state: "failed",
        startedAt: "2026-04-02T09:00:00.000Z",
        completedAt: "2026-04-02T09:00:02.000Z",
        error: "OpenAI 503 — upstream unavailable",
      }),
      makeRun({
        generationId: "gen-ok-with-invalid",
        state: "completed",
        startedAt: "2026-04-01T09:00:00.000Z",
        completedAt: "2026-04-01T09:00:05.000Z",
        invalidCitationCount: 3,
      }),
    ];

    renderPage();
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));
    await screen.findByTestId("briefing-recent-runs-list");

    // Expand the failed row — the error string should appear in
    // the inline details panel.
    fireEvent.click(screen.getByTestId("briefing-run-toggle-gen-fail"));
    const failDetails = await screen.findByTestId(
      "briefing-run-details-gen-fail",
    );
    expect(
      within(failDetails).getByTestId("briefing-run-error-gen-fail"),
    ).toHaveTextContent("OpenAI 503 — upstream unavailable");

    // The other row's details are NOT mounted — only one row is
    // expanded at a time so the disclosure stays compact.
    expect(
      screen.queryByTestId("briefing-run-details-gen-ok-with-invalid"),
    ).not.toBeInTheDocument();

    // Now expand the completed-with-invalid row — the invalid count
    // is the salient detail (the briefing is technically successful
    // but cited 3 things the engine couldn't validate).
    fireEvent.click(
      screen.getByTestId("briefing-run-toggle-gen-ok-with-invalid"),
    );
    const okDetails = await screen.findByTestId(
      "briefing-run-details-gen-ok-with-invalid",
    );
    expect(
      within(okDetails).getByTestId(
        "briefing-run-invalid-detail-gen-ok-with-invalid",
      ),
    ).toHaveTextContent(/Invalid citations:\s*3/);
    // Expanding the second row collapses the first — the panel
    // commits to one expanded row at a time so the auditor doesn't
    // have to scroll past stale details.
    expect(
      screen.queryByTestId("briefing-run-details-gen-fail"),
    ).not.toBeInTheDocument();
  });

  it("invalidates the runs query on kickoff so a freshly-inserted row appears at the top of the list", async () => {
    hoisted.runs = [
      makeRun({
        generationId: "gen-old",
        state: "completed",
        startedAt: "2026-04-01T08:00:00.000Z",
        completedAt: "2026-04-01T08:00:04.000Z",
      }),
    ];

    const { client } = renderPage();
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));
    const list = await screen.findByTestId("briefing-recent-runs-list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(
      within(list).getByTestId("briefing-run-gen-old"),
    ).toBeInTheDocument();

    // Server-side, kicking off generation inserts a new pending row
    // and the `onSuccess` callback the panel registers re-fetches
    // the runs query so the row appears without a manual refresh.
    // Push the new row, then drive `onSuccess` directly.
    hoisted.runs = [
      makeRun({
        generationId: "gen-new",
        state: "pending",
        startedAt: "2026-04-04T10:00:00.000Z",
        completedAt: null,
      }),
      ...hoisted.runs,
    ];
    expect(
      hoisted.capturedGenerateBriefingOptions?.mutation?.onSuccess,
    ).toBeDefined();
    await act(async () => {
      await hoisted.capturedGenerateBriefingOptions!.mutation!.onSuccess!(
        { generationId: "gen-new" },
        { id: hoisted.engagement.id },
        undefined,
      );
    });

    // The cache invalidation is async — wait for the new row to
    // land at the top of the list.
    await waitFor(() => {
      const refreshed = within(
        screen.getByTestId("briefing-recent-runs-list"),
      ).getAllByRole("listitem");
      expect(refreshed).toHaveLength(2);
      expect(refreshed[0]).toHaveAttribute(
        "data-testid",
        "briefing-run-gen-new",
      );
      expect(refreshed[1]).toHaveAttribute(
        "data-testid",
        "briefing-run-gen-old",
      );
    });
    // The new row carries the `pending` badge — the pending → terminal
    // transition is a separate effect (not exercised here), so the
    // disclosure should be honest that the freshest attempt is still
    // running.
    expect(
      screen.getByTestId("briefing-run-state-badge-pending"),
    ).toHaveTextContent(/Running/i);

    // Sanity: the cache key the panel reads from is the one the
    // public `getListEngagementBriefingGenerationRunsQueryKey`
    // generates, so any future helper that wants to mutate it can
    // rely on the same key.
    expect(
      client.getQueryData([
        "listEngagementBriefingGenerationRuns",
        hoisted.engagement.id,
      ]),
    ).toBeDefined();
  });

  it("renders the empty-state copy when no runs have been retained yet", async () => {
    hoisted.runs = [];

    renderPage();
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));

    expect(
      await screen.findByTestId("briefing-recent-runs-empty"),
    ).toHaveTextContent(/No briefing generations have run yet/i);
    expect(
      screen.queryByTestId("briefing-recent-runs-list"),
    ).not.toBeInTheDocument();
  });

  // Task #262 — auditors comparing the failed-then-rerun pattern on a
  // noisy engagement need a way to slice the retained list down to
  // the suspicious rows. This pins three behaviors:
  //
  //   1. The Failed filter narrows the list to just the failed row,
  //      hiding the otherwise-most-recent completed and pending rows.
  //   2. The "Has invalid citations" filter is distinct from Failed
  //      — a completed-with-invalid run is suspicious (the briefing
  //      cited things the engine couldn't validate) even though the
  //      job itself succeeded — so it surfaces only the completed row
  //      whose `invalidCitationCount > 0`.
  //   3. When a filter narrows the list to zero, the empty-state copy
  //      switches from the "no runs yet" message to a distinct "no
  //      runs match this filter" message so the auditor knows the
  //      list wasn't reset out from under them.
  it("filters the list and switches the empty-state copy when the filter matches nothing", async () => {
    hoisted.runs = [
      makeRun({
        generationId: "gen-pending",
        state: "pending",
        startedAt: "2026-04-04T10:00:00.000Z",
        completedAt: null,
      }),
      makeRun({
        generationId: "gen-completed-clean",
        state: "completed",
        startedAt: "2026-04-03T10:00:00.000Z",
        completedAt: "2026-04-03T10:00:04.000Z",
        invalidCitationCount: 0,
      }),
      makeRun({
        generationId: "gen-completed-invalid",
        state: "completed",
        startedAt: "2026-04-02T10:00:00.000Z",
        completedAt: "2026-04-02T10:00:05.000Z",
        invalidCitationCount: 2,
      }),
      makeRun({
        generationId: "gen-failed",
        state: "failed",
        startedAt: "2026-04-01T10:00:00.000Z",
        completedAt: "2026-04-01T10:00:03.000Z",
        error: "OpenAI 503 — upstream unavailable",
      }),
    ];

    renderPage();
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));

    // Default filter is "All" — every retained row is visible.
    const list = await screen.findByTestId("briefing-recent-runs-list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    expect(
      screen.getByTestId("briefing-recent-runs-filter-all"),
    ).toHaveAttribute("aria-pressed", "true");

    // Switch to "Failed" — only the failed row should remain visible.
    fireEvent.click(screen.getByTestId("briefing-recent-runs-filter-failed"));
    const failedList = screen.getByTestId("briefing-recent-runs-list");
    const failedItems = within(failedList).getAllByRole("listitem");
    expect(failedItems).toHaveLength(1);
    expect(failedItems[0]).toHaveAttribute(
      "data-testid",
      "briefing-run-gen-failed",
    );
    expect(
      screen.getByTestId("briefing-recent-runs-filter-failed"),
    ).toHaveAttribute("aria-pressed", "true");

    // Switch to "Has invalid citations" — only the completed row whose
    // invalid-count is > 0 should remain. The "clean" completed row
    // and the failed row both drop out of the list.
    fireEvent.click(screen.getByTestId("briefing-recent-runs-filter-invalid"));
    const invalidList = screen.getByTestId("briefing-recent-runs-list");
    const invalidItems = within(invalidList).getAllByRole("listitem");
    expect(invalidItems).toHaveLength(1);
    expect(invalidItems[0]).toHaveAttribute(
      "data-testid",
      "briefing-run-gen-completed-invalid",
    );

    // Back to "All" so the disclosure rests on the full list before
    // the next assertion. The next test re-mounts the page with a
    // dataset that contains no failed rows so the empty-state copy
    // switch can be verified in isolation.
    fireEvent.click(screen.getByTestId("briefing-recent-runs-filter-all"));
    expect(
      within(screen.getByTestId("briefing-recent-runs-list")).getAllByRole(
        "listitem",
      ),
    ).toHaveLength(4);
  });

  // Task #276 — surface a per-bucket tally next to each chip so an
  // auditor can decide whether narrowing to that bucket is worth the
  // click. The test pins two things:
  //
  //   1. Each chip renders a numeric count alongside its label, and
  //      each count matches the number of rows that would be visible
  //      if that filter were active. Asserted by reading the count
  //      directly off the chip and then activating the filter and
  //      counting the resulting list rows.
  //   2. Counts update live when the runs list changes — pushing a
  //      new failed row and re-fetching causes the Failed chip's
  //      count to step from 1 → 2 without a re-mount of the panel.
  it("renders a per-bucket count on each filter chip and keeps the counts in sync with the visible rows", async () => {
    hoisted.runs = [
      makeRun({
        generationId: "gen-pending",
        state: "pending",
        startedAt: "2026-04-04T10:00:00.000Z",
        completedAt: null,
      }),
      makeRun({
        generationId: "gen-completed-clean",
        state: "completed",
        startedAt: "2026-04-03T10:00:00.000Z",
        completedAt: "2026-04-03T10:00:04.000Z",
        invalidCitationCount: 0,
      }),
      makeRun({
        generationId: "gen-completed-invalid-a",
        state: "completed",
        startedAt: "2026-04-02T10:00:00.000Z",
        completedAt: "2026-04-02T10:00:05.000Z",
        invalidCitationCount: 2,
      }),
      makeRun({
        generationId: "gen-completed-invalid-b",
        state: "completed",
        startedAt: "2026-04-02T09:00:00.000Z",
        completedAt: "2026-04-02T09:00:05.000Z",
        invalidCitationCount: 1,
      }),
      makeRun({
        generationId: "gen-failed",
        state: "failed",
        startedAt: "2026-04-01T10:00:00.000Z",
        completedAt: "2026-04-01T10:00:03.000Z",
        error: "OpenAI 503 — upstream unavailable",
      }),
    ];

    const { client } = renderPage();
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));
    await screen.findByTestId("briefing-recent-runs-list");

    // The chip counts should reflect the seeded fixture: 5 total,
    // 1 failed, 2 with invalid citations.
    expect(
      screen.getByTestId("briefing-recent-runs-filter-all-count"),
    ).toHaveTextContent("(5)");
    expect(
      screen.getByTestId("briefing-recent-runs-filter-failed-count"),
    ).toHaveTextContent("(1)");
    expect(
      screen.getByTestId("briefing-recent-runs-filter-invalid-count"),
    ).toHaveTextContent("(2)");

    // Each chip's count must equal the number of rows the
    // corresponding filter actually shows when active. Walk every
    // chip → activate → assert row count → return to All.
    for (const bucket of ["all", "failed", "invalid"] as const) {
      const expected = Number(
        (
          screen
            .getByTestId(`briefing-recent-runs-filter-${bucket}-count`)
            .textContent ?? ""
        ).replace(/[()]/g, ""),
      );
      fireEvent.click(
        screen.getByTestId(`briefing-recent-runs-filter-${bucket}`),
      );
      const list = screen.queryByTestId("briefing-recent-runs-list");
      const actual = list ? within(list).getAllByRole("listitem").length : 0;
      expect(actual).toBe(expected);
    }
    // Land back on All so the next assertion sees the full list.
    fireEvent.click(screen.getByTestId("briefing-recent-runs-filter-all"));

    // Push a brand-new failed row and force the runs query to
    // refetch — the Failed chip's count must step from 1 → 2 live,
    // without remounting the panel. We use the same query
    // invalidation path the kickoff `onSuccess` exercises so this
    // test pins the live-update behavior end to end.
    hoisted.runs = [
      makeRun({
        generationId: "gen-failed-2",
        state: "failed",
        startedAt: "2026-04-05T10:00:00.000Z",
        completedAt: "2026-04-05T10:00:03.000Z",
        error: "OpenAI 503 — upstream unavailable",
      }),
      ...hoisted.runs,
    ];
    await act(async () => {
      await client.invalidateQueries({
        queryKey: [
          "listEngagementBriefingGenerationRuns",
          hoisted.engagement.id,
        ],
      });
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("briefing-recent-runs-filter-all-count"),
      ).toHaveTextContent("(6)");
      expect(
        screen.getByTestId("briefing-recent-runs-filter-failed-count"),
      ).toHaveTextContent("(2)");
      expect(
        screen.getByTestId("briefing-recent-runs-filter-invalid-count"),
      ).toHaveTextContent("(2)");
    });
  });

  it("switches the empty-state copy to 'No runs match this filter' when the active filter narrows the list to zero", async () => {
    // A single completed-with-no-invalid-citations row — neither the
    // Failed nor the Has-invalid-citations filter will match it, so
    // either filter is enough to drive the empty-state branch. We
    // pick Failed because it's the more common auditor flow.
    hoisted.runs = [
      makeRun({
        generationId: "gen-clean",
        state: "completed",
        startedAt: "2026-04-05T10:00:00.000Z",
        completedAt: "2026-04-05T10:00:04.000Z",
        invalidCitationCount: 0,
      }),
    ];

    renderPage();
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));

    // Sanity: with the All filter the single row paints normally and
    // the original "no runs yet" copy is NOT mounted.
    const list = await screen.findByTestId("briefing-recent-runs-list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(
      screen.queryByTestId("briefing-recent-runs-empty"),
    ).not.toBeInTheDocument();

    // Switching to the Failed filter narrows the list to zero — the
    // distinct filter-empty copy must replace the list, NOT the
    // "no briefing generations have run yet" copy (the runs are
    // still there, they just don't match).
    fireEvent.click(screen.getByTestId("briefing-recent-runs-filter-failed"));
    const filterEmpty = await screen.findByTestId(
      "briefing-recent-runs-filter-empty",
    );
    expect(filterEmpty).toHaveTextContent(/No runs match this filter/i);
    expect(
      screen.queryByTestId("briefing-recent-runs-empty"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("briefing-recent-runs-list"),
    ).not.toBeInTheDocument();

    // Returning to All re-mounts the row — the empty state flips
    // back off so a stuck filter doesn't leave the disclosure
    // permanently empty.
    fireEvent.click(screen.getByTestId("briefing-recent-runs-filter-all"));
    expect(
      within(screen.getByTestId("briefing-recent-runs-list")).getAllByRole(
        "listitem",
      ),
    ).toHaveLength(1);
    expect(
      screen.queryByTestId("briefing-recent-runs-filter-empty"),
    ).not.toBeInTheDocument();
  });
});
