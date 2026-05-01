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
    // Task #280 — the runs envelope also carries the `prior_section_*`
    // backup snapshot keyed by `generatedAt`. Tests that exercise the
    // "Prior" pill + inline prior-narrative rendering replace this
    // with a non-null payload; the default keeps the wire shape
    // honest without forcing every existing test to mention it.
    priorNarrative: null as null | {
      sectionA: string | null;
      sectionB: string | null;
      sectionC: string | null;
      sectionD: string | null;
      sectionE: string | null;
      sectionF: string | null;
      sectionG: string | null;
      generatedAt: string | null;
      generatedBy: string | null;
    },
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
    // Task #281 — the briefing payload the GET /briefing query mock
    // returns. Tests that need a "narrative is currently on screen"
    // condition can replace this with a fixture that has a
    // non-null `narrative.generationId`; the default keeps the
    // existing "no narrative" shape so all of the prior tests
    // continue to render the same way. The panel now matches
    // by direct id equality against the `briefing_generation_jobs`
    // row id stamped on `parcel_briefings.generation_id`, not by
    // inferring from `generatedAt` timestamp intervals.
    briefing: null as null | {
      narrative: { generationId: string | null } | null;
    },
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
        queryFn: async () => ({ briefing: hoisted.briefing }),
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
          // Task #280 — the same envelope also carries the
          // `prior_section_*` backup snapshot the briefing held
          // before its current narrative was written. Cloned so a
          // test that mutates it post-render doesn't accidentally
          // mutate the cached payload.
          return {
            runs: hoisted.runs.map((r) => ({ ...r })),
            priorNarrative: hoisted.priorNarrative
              ? { ...hoisted.priorNarrative }
              : null,
          };
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

function renderPage(opts?: { search?: string }) {
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
  // Tests that need the disclosure pre-opened or pre-filtered (Task
  // #275) pass an `opts.search` that augments the base query string.
  const baseSearch = "tab=site-context";
  const search = opts?.search
    ? `${baseSearch}&${opts.search.replace(/^\?/, "")}`
    : baseSearch;
  window.history.replaceState(null, "", `/?${search}`);
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
  // Task #263 — default to "no narrative on screen" so prior tests
  // keep their existing semantics; the Current-pill tests below
  // override this with a non-null narrative payload.
  hoisted.briefing = null;
  // Task #280 — default to "no prior backup" so existing tests
  // keep rendering as they did before; the prior-narrative tests
  // below override this with a populated payload.
  hoisted.priorNarrative = null;
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

  // ── Task #281 ──────────────────────────────────────────────────────
  // Tagging the row whose generation produced the narrative on screen
  // closes the comparison loop the Task #230 disclosure opened. Task
  // #263 originally inferred this by matching the narrative's
  // `generatedAt` against each completed run's [startedAt, completedAt]
  // window — correct in practice today but it quietly drifts the moment
  // a backfill writes sections without inserting a job row, the runs
  // route paginates, or two completions race. Task #281 replaces the
  // heuristic with the producing job's id, stamped onto the briefing
  // row in the same transaction that overwrites the section columns,
  // so the panel matches by direct id equality. With no producing run
  // on file (`narrative.generationId === null` — brand-new engagement,
  // unbackfilled legacy row, or the producing job has been pruned)
  // no row carries the pill.
  it("marks the run whose id matches narrative.generationId as 'Current' when a narrative is on screen", async () => {
    // Narrative is loaded and carries the producing job's id — the
    // briefing-query mock returns a payload with a non-null
    // `generationId`, so the parent passes that id into the
    // disclosure. The id matches one of the retained rows.
    hoisted.briefing = {
      narrative: { generationId: "gen-current" },
    };
    // A pending newer run, then the completed run that produced
    // what's on screen, then an older failed attempt. Only the
    // middle row should carry the "Current" pill — the pending
    // row's id is `gen-pending` (no match) and the failed older
    // row's id is `gen-old-fail` (no match either).
    hoisted.runs = [
      makeRun({
        generationId: "gen-pending",
        state: "pending",
        startedAt: "2026-04-03T10:00:00.000Z",
        completedAt: null,
      }),
      makeRun({
        generationId: "gen-current",
        state: "completed",
        startedAt: "2026-04-02T10:00:00.000Z",
        completedAt: "2026-04-02T10:00:04.000Z",
        invalidCitationCount: 0,
      }),
      makeRun({
        generationId: "gen-old-fail",
        state: "failed",
        startedAt: "2026-04-01T10:00:00.000Z",
        completedAt: "2026-04-01T10:00:03.000Z",
        error: "OpenAI 503 — upstream unavailable",
      }),
    ];

    renderPage();
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));
    const list = await screen.findByTestId("briefing-recent-runs-list");

    // The middle (id-matching) row carries the pill and is also
    // marked with `aria-current="true"` so assistive tech can
    // announce the same "this is what's on screen" cue the
    // visual highlight conveys.
    const currentRow = within(list).getByTestId("briefing-run-gen-current");
    expect(currentRow).toHaveAttribute("aria-current", "true");
    expect(
      within(currentRow).getByTestId(
        "briefing-run-current-pill-gen-current",
      ),
    ).toHaveTextContent(/Current/i);

    // No other row should carry the pill — only id equality counts,
    // not state ordering.
    expect(
      screen.queryByTestId("briefing-run-current-pill-gen-pending"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("briefing-run-current-pill-gen-old-fail"),
    ).not.toBeInTheDocument();
    expect(
      within(list).getByTestId("briefing-run-gen-pending"),
    ).not.toHaveAttribute("aria-current");
    expect(
      within(list).getByTestId("briefing-run-gen-old-fail"),
    ).not.toHaveAttribute("aria-current");
  });

  it("matches by narrative.generationId rather than picking the latest completed row", async () => {
    // The newest completed row is NOT the one that produced the
    // narrative on screen — say a regeneration just landed but
    // the briefing read is still serving the previous body
    // (e.g. cache lag during the pending → terminal transition,
    // or an external cache pin). `narrative.generationId` points
    // at the OLDER completed run's id, so the disclosure must
    // mark THAT row Current, not the newer one. This test would
    // pass under the old timestamp-window heuristic too — but
    // only because the timestamps were constructed to agree;
    // the pin is on id equality, so re-using the same row ids
    // here would catch any future regression that silently
    // re-introduced a state-ordering shortcut.
    hoisted.briefing = {
      narrative: { generationId: "gen-producer" },
    };
    hoisted.runs = [
      // Newer completed run — its id doesn't match
      // `narrative.generationId`, so it cannot be the producer.
      makeRun({
        generationId: "gen-newer-completed",
        state: "completed",
        startedAt: "2026-04-03T10:00:00.000Z",
        completedAt: "2026-04-03T10:00:05.000Z",
        invalidCitationCount: 0,
      }),
      // Older completed run whose id matches the briefing's
      // stamped `generationId` — this is the producer.
      makeRun({
        generationId: "gen-producer",
        state: "completed",
        startedAt: "2026-04-02T10:00:00.000Z",
        completedAt: "2026-04-02T10:00:04.000Z",
        invalidCitationCount: 0,
      }),
    ];

    renderPage();
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));
    const list = await screen.findByTestId("briefing-recent-runs-list");

    // The producing row gets the pill + aria-current — the
    // matcher used the narrative's stamped id, not "first completed".
    const producerRow = within(list).getByTestId(
      "briefing-run-gen-producer",
    );
    expect(producerRow).toHaveAttribute("aria-current", "true");
    expect(
      within(producerRow).getByTestId(
        "briefing-run-current-pill-gen-producer",
      ),
    ).toBeInTheDocument();

    // The newer completed row, which would have been picked by a
    // naive "latest completed" heuristic, is left unmarked.
    const newerRow = within(list).getByTestId(
      "briefing-run-gen-newer-completed",
    );
    expect(newerRow).not.toHaveAttribute("aria-current");
    expect(
      screen.queryByTestId(
        "briefing-run-current-pill-gen-newer-completed",
      ),
    ).not.toBeInTheDocument();
  });

  it("marks no row 'Current' when the narrative's producing run is not in the retained list", async () => {
    // Narrative is loaded and stamped with a `generationId` that
    // does NOT appear in the retained runs — the producing job
    // was pruned out of the keep-N window between the briefing
    // fetch and the runs fetch (the FK is `ON DELETE SET NULL`,
    // so this can also surface as `narrative.generationId ===
    // null` after the sweep races; the case here is the older
    // pre-sweep id still cached on the briefing's narrative).
    // The disclosure stays honest: rather than guessing, no row
    // is marked Current.
    hoisted.briefing = {
      narrative: { generationId: "gen-pruned-no-longer-in-list" },
    };
    hoisted.runs = [
      makeRun({
        generationId: "gen-recent",
        state: "completed",
        startedAt: "2026-04-02T10:00:00.000Z",
        completedAt: "2026-04-02T10:00:04.000Z",
        invalidCitationCount: 0,
      }),
    ];

    renderPage();
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));
    const list = await screen.findByTestId("briefing-recent-runs-list");

    const row = within(list).getByTestId("briefing-run-gen-recent");
    expect(row).not.toHaveAttribute("aria-current");
    expect(
      screen.queryByTestId("briefing-run-current-pill-gen-recent"),
    ).not.toBeInTheDocument();
  });

  it("renders the prior briefing narrative inline on the row whose interval contains prior_generated_at (Task #280)", async () => {
    // Two completed runs: the most recent one produced what's
    // currently on screen (Current pill), and the older one
    // produced what was on screen *before* that — its
    // [startedAt, completedAt] window contains
    // priorNarrative.generatedAt, so its expanded details
    // should surface the seven A–G section bodies the briefing
    // held before the regeneration overwrote them. The Current
    // row's expanded details should *not* duplicate the
    // narrative (it's already rendered above the disclosure).
    hoisted.briefing = {
      narrative: { generationId: "gen-current" },
    };
    hoisted.priorNarrative = {
      sectionA: "Prior Section A — buildable thesis as of run 1.",
      sectionB: "Prior Section B — threshold issues as of run 1.",
      sectionC: "Prior Section C — regulatory gates as of run 1.",
      sectionD: "Prior Section D — site infrastructure as of run 1.",
      sectionE: "Prior Section E — buildable envelope as of run 1.",
      sectionF: "Prior Section F — neighboring context as of run 1.",
      sectionG: "Prior Section G — next-step checklist as of run 1.",
      generatedAt: "2026-04-02T10:00:02.000Z",
      generatedBy: "system:briefing-engine",
    };
    hoisted.runs = [
      makeRun({
        generationId: "gen-current",
        state: "completed",
        startedAt: "2026-04-03T10:00:00.000Z",
        completedAt: "2026-04-03T10:00:05.000Z",
        invalidCitationCount: 0,
      }),
      makeRun({
        generationId: "gen-prior",
        state: "completed",
        startedAt: "2026-04-02T10:00:00.000Z",
        completedAt: "2026-04-02T10:00:04.000Z",
        invalidCitationCount: 0,
      }),
    ];

    renderPage();
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));
    const list = await screen.findByTestId("briefing-recent-runs-list");

    // The matching row carries the "Prior" pill alongside its
    // existing state badge so the comparison story reads
    // end-to-end ("Current" + "Prior") at a glance.
    const priorRow = within(list).getByTestId("briefing-run-gen-prior");
    expect(
      within(priorRow).getByTestId("briefing-run-prior-pill-gen-prior"),
    ).toHaveTextContent(/Prior/i);
    // The Current row does NOT also get the Prior pill — it's
    // the producer of what's on screen now, not what was on
    // screen before.
    expect(
      screen.queryByTestId("briefing-run-prior-pill-gen-current"),
    ).not.toBeInTheDocument();

    // Expanding the prior row surfaces the seven section bodies
    // inline — same A–G ordering as the on-screen briefing
    // panel so the auditor can read them top-to-bottom.
    fireEvent.click(screen.getByTestId("briefing-run-toggle-gen-prior"));
    const priorNarrativeBlock = await screen.findByTestId(
      "briefing-run-prior-narrative-gen-prior",
    );
    expect(
      within(priorNarrativeBlock).getByTestId(
        "briefing-run-prior-section-a-gen-prior",
      ),
    ).toHaveTextContent("Prior Section A — buildable thesis as of run 1.");
    expect(
      within(priorNarrativeBlock).getByTestId(
        "briefing-run-prior-section-g-gen-prior",
      ),
    ).toHaveTextContent("Prior Section G — next-step checklist as of run 1.");

    // The Current row's expanded details stay unchanged — no
    // prior-narrative block, since duplicating the on-screen
    // narrative there would be noise.
    fireEvent.click(screen.getByTestId("briefing-run-toggle-gen-current"));
    await screen.findByTestId("briefing-run-details-gen-current");
    expect(
      screen.queryByTestId("briefing-run-prior-narrative-gen-current"),
    ).not.toBeInTheDocument();
  });

  it("hides the prior narrative on older rows whose backups have already been overwritten (Task #280)", async () => {
    // Three completed runs: the newest produced what's on screen
    // (Current), the middle produced what was on screen before
    // that (Prior — its interval contains priorNarrative.generatedAt),
    // and an older one whose body has *already been overwritten*
    // by the middle run's regeneration. The briefing row only
    // retains one `prior_section_*` snapshot, so the older row
    // has no body to honestly surface — its expanded details
    // must NOT render a prior-narrative block.
    hoisted.briefing = {
      narrative: { generationId: "gen-current" },
    };
    hoisted.priorNarrative = {
      sectionA: "Prior Section A from run 2.",
      sectionB: null,
      sectionC: null,
      sectionD: null,
      sectionE: null,
      sectionF: null,
      sectionG: "Prior Section G from run 2.",
      generatedAt: "2026-04-02T10:00:02.000Z",
      generatedBy: "system:briefing-engine",
    };
    hoisted.runs = [
      makeRun({
        generationId: "gen-current",
        state: "completed",
        startedAt: "2026-04-03T10:00:00.000Z",
        completedAt: "2026-04-03T10:00:05.000Z",
      }),
      makeRun({
        generationId: "gen-prior",
        state: "completed",
        startedAt: "2026-04-02T10:00:00.000Z",
        completedAt: "2026-04-02T10:00:04.000Z",
      }),
      makeRun({
        generationId: "gen-overwritten",
        state: "completed",
        startedAt: "2026-04-01T10:00:00.000Z",
        completedAt: "2026-04-01T10:00:03.000Z",
      }),
    ];

    renderPage();
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));
    const list = await screen.findByTestId("briefing-recent-runs-list");

    // Only the matching row carries the Prior pill — the older
    // row does NOT, since its narrative was overwritten by the
    // middle row's regeneration and is no longer recoverable
    // from the briefing's backup columns.
    expect(
      within(list).getByTestId("briefing-run-prior-pill-gen-prior"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("briefing-run-prior-pill-gen-overwritten"),
    ).not.toBeInTheDocument();

    // Expanding the older row shows its existing details (the
    // Started/Completed/Invalid citations lines) but no prior
    // narrative block — the disclosure stays honest about what
    // it can recover from the wire envelope.
    fireEvent.click(screen.getByTestId("briefing-run-toggle-gen-overwritten"));
    await screen.findByTestId("briefing-run-details-gen-overwritten");
    expect(
      screen.queryByTestId(
        "briefing-run-prior-narrative-gen-overwritten",
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(
        "briefing-run-prior-section-a-gen-overwritten",
      ),
    ).not.toBeInTheDocument();

    // And expanding the matching row still surfaces the prior
    // body as expected — proving the "hidden on older rows"
    // behavior is row-specific, not a global suppression.
    fireEvent.click(screen.getByTestId("briefing-run-toggle-gen-prior"));
    const priorNarrativeBlock = await screen.findByTestId(
      "briefing-run-prior-narrative-gen-prior",
    );
    expect(
      within(priorNarrativeBlock).getByTestId(
        "briefing-run-prior-section-a-gen-prior",
      ),
    ).toHaveTextContent("Prior Section A from run 2.");
  });

  it("attaches the prior body to the most recent completed pre-current run when only the actor is recorded (Task #313)", async () => {
    // Legacy backups can carry `generatedBy` without a
    // `generatedAt` (per-row provenance was added after the
    // section_* backup columns on some installs). The interval
    // matcher can't decide which row owns the prior body in
    // that case, so before #313 the entire prior block was
    // suppressed even though we had the actor on file. The
    // fallback now picks the most recent completed run that
    // pre-dates the current narrative so the auditor still
    // sees who regenerated the briefing last; the meta line
    // gracefully shows just the "by …" half (no fabricated
    // date).
    hoisted.briefing = {
      narrative: { generationId: "gen-current" },
    };
    hoisted.priorNarrative = {
      sectionA: "Legacy prior body — actor on file but no timestamp.",
      sectionB: null,
      sectionC: null,
      sectionD: null,
      sectionE: null,
      sectionF: null,
      sectionG: "Legacy prior G body.",
      // The legacy half: no `generatedAt`, but `generatedBy`
      // survived. This is the exact wire shape the fallback
      // exists to cover.
      generatedAt: null,
      generatedBy: "user:alice@example.com",
    };
    hoisted.runs = [
      makeRun({
        generationId: "gen-current",
        state: "completed",
        startedAt: "2026-04-03T10:00:00.000Z",
        completedAt: "2026-04-03T10:00:05.000Z",
      }),
      // Most recent completed run that pre-dates the current
      // narrative — this is the row the fallback should attach
      // the prior body to.
      makeRun({
        generationId: "gen-prior",
        state: "completed",
        startedAt: "2026-04-02T10:00:00.000Z",
        completedAt: "2026-04-02T10:00:04.000Z",
      }),
      // An even older completed run — the fallback must pick
      // the *most recent* eligible row, not just any pre-current
      // one, so this row should NOT carry the Prior pill.
      makeRun({
        generationId: "gen-older",
        state: "completed",
        startedAt: "2026-04-01T10:00:00.000Z",
        completedAt: "2026-04-01T10:00:03.000Z",
      }),
    ];

    renderPage();
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));
    const list = await screen.findByTestId("briefing-recent-runs-list");

    // The most recent pre-current completed row carries the Prior
    // pill — proves the fallback picked a sensible row instead of
    // suppressing the whole block.
    expect(
      within(list).getByTestId("briefing-run-prior-pill-gen-prior"),
    ).toBeInTheDocument();
    // The Current row does not double up as Prior, and the older
    // pre-current row is not mislabelled either — the fallback
    // is row-specific.
    expect(
      screen.queryByTestId("briefing-run-prior-pill-gen-current"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("briefing-run-prior-pill-gen-older"),
    ).not.toBeInTheDocument();

    // Expanding the prior row surfaces the legacy body and the
    // meta line, and the meta line shows just the "by …" half —
    // no fabricated "Generated …" timestamp.
    fireEvent.click(screen.getByTestId("briefing-run-toggle-gen-prior"));
    const priorBlock = await screen.findByTestId(
      "briefing-run-prior-narrative-gen-prior",
    );
    expect(
      within(priorBlock).getByTestId("briefing-run-prior-section-a-gen-prior"),
    ).toHaveTextContent("Legacy prior body — actor on file but no timestamp.");
    const meta = within(priorBlock).getByTestId(
      "briefing-run-prior-narrative-meta-gen-prior",
    );
    expect(
      within(meta).getByTestId(
        "briefing-run-prior-narrative-generated-by-gen-prior",
      ),
    ).toHaveTextContent(/by user:alice@example\.com/);
    // The "Generated …" half stays absent — the fallback never
    // invents a date for legacy backups.
    expect(
      screen.queryByTestId(
        "briefing-run-prior-narrative-generated-at-gen-prior",
      ),
    ).not.toBeInTheDocument();
  });

  it("does NOT engage the legacy-actor fallback when both generatedAt and generatedBy are null (Task #313)", async () => {
    // Symmetric guard: when neither half of the provenance is on
    // file, there's nothing useful to surface, so the fallback
    // must stay dormant — picking a row purely to render an
    // empty meta line would be exactly the noise the interval
    // matcher exists to avoid.
    hoisted.briefing = {
      narrative: { generationId: "gen-current" },
    };
    hoisted.priorNarrative = {
      sectionA: "Body present, provenance entirely missing.",
      sectionB: null,
      sectionC: null,
      sectionD: null,
      sectionE: null,
      sectionF: null,
      sectionG: null,
      generatedAt: null,
      generatedBy: null,
    };
    hoisted.runs = [
      makeRun({
        generationId: "gen-current",
        state: "completed",
        startedAt: "2026-04-03T10:00:00.000Z",
        completedAt: "2026-04-03T10:00:05.000Z",
      }),
      makeRun({
        generationId: "gen-eligible",
        state: "completed",
        startedAt: "2026-04-02T10:00:00.000Z",
        completedAt: "2026-04-02T10:00:04.000Z",
      }),
    ];

    renderPage();
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));
    const list = await screen.findByTestId("briefing-recent-runs-list");

    // No row anywhere in the list carries the Prior pill — the
    // fallback stayed dormant because there was no actor to
    // surface.
    expect(within(list).queryByText(/Prior/i)).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("briefing-run-prior-pill-gen-eligible"),
    ).not.toBeInTheDocument();
  });

  it("renders no Prior pill anywhere when the briefing has never been regenerated (Task #280)", async () => {
    // First-generation-only state: the briefing row exists with
    // a current narrative on screen, but `prior_section_*` are
    // null because no overwrite has happened yet. The runs list
    // has only the producing run; the disclosure marks it
    // Current and renders no Prior pill — the auditor isn't
    // told a prior body is recoverable when it isn't.
    hoisted.briefing = {
      narrative: { generationId: "gen-only" },
    };
    hoisted.priorNarrative = null;
    hoisted.runs = [
      makeRun({
        generationId: "gen-only",
        state: "completed",
        startedAt: "2026-04-03T10:00:00.000Z",
        completedAt: "2026-04-03T10:00:05.000Z",
      }),
    ];

    renderPage();
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));
    const list = await screen.findByTestId("briefing-recent-runs-list");

    expect(
      within(list).getByTestId("briefing-run-current-pill-gen-only"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("briefing-run-prior-pill-gen-only"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("briefing-run-toggle-gen-only"));
    await screen.findByTestId("briefing-run-details-gen-only");
    expect(
      screen.queryByTestId("briefing-run-prior-narrative-gen-only"),
    ).not.toBeInTheDocument();
  });

  it("does not mark any row 'Current' when no narrative is loaded", async () => {
    // Briefing exists in the cache (otherwise the parent's whole
    // narrative panel would render its empty state) but has never
    // been generated — `narrative` is null. The runs list still
    // has a completed row from a prior attempt that, say,
    // produced a narrative since-purged or for a different
    // engagement; the disclosure should NOT label it Current.
    hoisted.briefing = { narrative: null };
    hoisted.runs = [
      makeRun({
        generationId: "gen-orphaned",
        state: "completed",
        startedAt: "2026-04-01T10:00:00.000Z",
        completedAt: "2026-04-01T10:00:04.000Z",
        invalidCitationCount: 0,
      }),
    ];

    renderPage();
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));
    const list = await screen.findByTestId("briefing-recent-runs-list");

    // The single completed row renders normally — same toggle and
    // badge wiring as the other tests — but no Current pill and
    // no `aria-current` attribute, so the auditor isn't told that
    // a run produced what's on screen when it didn't.
    const row = within(list).getByTestId("briefing-run-gen-orphaned");
    expect(row).toBeInTheDocument();
    expect(row).not.toHaveAttribute("aria-current");
    expect(
      screen.queryByTestId("briefing-run-current-pill-gen-orphaned"),
    ).not.toBeInTheDocument();
  });

  // ── Task #301 ──────────────────────────────────────────────────────
  // Task #281 made the Current pill exact by matching on
  // `narrative.generationId`. When that id is null but the narrative
  // itself is on screen (legacy unbackfilled row, or the producing
  // job has aged out of the keep-N sweep window) no row in the list
  // can be marked Current — correct, but with no signal an auditor
  // reads the missing pill as "the disclosure is broken." A small
  // caption above the runs list closes that loop. The caption is
  // suppressed when `narrative` itself is null (no producing run was
  // ever stamped) since the absence of a Current pill is already
  // self-explanatory in that case. Both branches are pinned here.
  it("renders a 'producing run was pruned' caption when the narrative is loaded but its generationId is null (Task #301)", async () => {
    // Narrative is on screen (the parent's BriefingNarrativePanel
    // is rendering the seven A–G section bodies above the
    // disclosure) but its `generationId` is null — the FK is
    // `ON DELETE SET NULL`, so the producing job aging out of
    // the keep window nulls out the column on the briefing row.
    hoisted.briefing = {
      narrative: { generationId: null },
    };
    hoisted.runs = [
      makeRun({
        generationId: "gen-survivor",
        state: "completed",
        startedAt: "2026-04-02T10:00:00.000Z",
        completedAt: "2026-04-02T10:00:04.000Z",
        invalidCitationCount: 0,
      }),
    ];

    renderPage();
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));
    const list = await screen.findByTestId("briefing-recent-runs-list");

    // The caption renders inside the open body, above the list,
    // explaining why no row can be marked Current.
    expect(
      screen.getByTestId("briefing-recent-runs-pruned-caption"),
    ).toHaveTextContent(
      /run that produced this narrative is no longer in the retained window/i,
    );
    // The retained row still renders normally — but with no
    // Current pill and no `aria-current`, since
    // `narrative.generationId` is null. The caption is the only
    // signal, and that's exactly the point.
    const row = within(list).getByTestId("briefing-run-gen-survivor");
    expect(row).not.toHaveAttribute("aria-current");
    expect(
      screen.queryByTestId("briefing-run-current-pill-gen-survivor"),
    ).not.toBeInTheDocument();
  });

  it("does not render the 'producing run was pruned' caption when the narrative itself is null (Task #301)", async () => {
    // No narrative on screen — the engine has never run for this
    // engagement (or the very first generation is still pending).
    // The absence of a Current pill below is already
    // self-explanatory; no caption should appear.
    hoisted.briefing = { narrative: null };
    hoisted.runs = [
      makeRun({
        generationId: "gen-orphaned",
        state: "completed",
        startedAt: "2026-04-01T10:00:00.000Z",
        completedAt: "2026-04-01T10:00:04.000Z",
        invalidCitationCount: 0,
      }),
    ];

    renderPage();
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));
    await screen.findByTestId("briefing-recent-runs-list");

    expect(
      screen.queryByTestId("briefing-recent-runs-pruned-caption"),
    ).not.toBeInTheDocument();
  });

  it("does not render the 'producing run was pruned' caption when the narrative's generationId is on file (Task #301)", async () => {
    // Healthy state: the narrative is on screen and its
    // producing run is still in the retained list. The Current
    // pill is the signal here — the caption must not double up
    // and tell the auditor a perfectly attributed narrative was
    // pruned.
    hoisted.briefing = {
      narrative: { generationId: "gen-current" },
    };
    hoisted.runs = [
      makeRun({
        generationId: "gen-current",
        state: "completed",
        startedAt: "2026-04-02T10:00:00.000Z",
        completedAt: "2026-04-02T10:00:04.000Z",
        invalidCitationCount: 0,
      }),
    ];

    renderPage();
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));
    const list = await screen.findByTestId("briefing-recent-runs-list");

    expect(
      within(list).getByTestId("briefing-run-current-pill-gen-current"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("briefing-recent-runs-pruned-caption"),
    ).not.toBeInTheDocument();
  });

  // Task #275 — the active recent-runs filter (and the open/closed
  // state of the disclosure) are mirrored to the URL so an auditor
  // who notices a suspicious failed-then-rerun pattern can drop a
  // link in a Slack thread that lands a teammate on the same
  // filtered, already-open view. These tests pin three behaviors:
  //
  //   1. Loading the page with `?recentRunsOpen=1&recentRunsFilter=failed`
  //      lands the disclosure already open AND already filtered to
  //      Failed on first paint, with no extra clicks needed.
  //   2. Toggling the disclosure or changing the filter writes the
  //      new state back to the URL via `replaceState` (no full
  //      navigation, no back-button entry per click).
  //   3. The defaults — collapsed + "All" — are encoded by *removing*
  //      the params, so the canonical engagement URL stays bare when
  //      no filter is applied.
  it("restores the open disclosure and active filter from the URL on first paint", async () => {
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
        generationId: "gen-failed",
        state: "failed",
        startedAt: "2026-04-01T10:00:00.000Z",
        completedAt: "2026-04-01T10:00:03.000Z",
        error: "OpenAI 503 — upstream unavailable",
      }),
    ];

    renderPage({ search: "recentRunsOpen=1&recentRunsFilter=failed" });

    // The disclosure is open on first paint — no toggle click needed.
    // The toggle's `aria-expanded` confirms the open state was
    // hydrated from the URL, not from a delayed effect.
    const toggle = await screen.findByTestId("briefing-recent-runs-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(
      await screen.findByTestId("briefing-recent-runs-body"),
    ).toBeInTheDocument();

    // The Failed filter chip is pre-pressed and the list is already
    // narrowed — only the failed row is visible. The other two rows
    // (pending + clean completed) drop out, proving the filter ran
    // on the first render rather than waiting for a click.
    const failedChip = await screen.findByTestId(
      "briefing-recent-runs-filter-failed",
    );
    expect(failedChip).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByTestId("briefing-recent-runs-filter-all"),
    ).toHaveAttribute("aria-pressed", "false");
    const list = await screen.findByTestId("briefing-recent-runs-list");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveAttribute("data-testid", "briefing-run-gen-failed");
  });

  it("restores the 'invalid' filter from the URL and ignores hand-edited unknown values", async () => {
    hoisted.runs = [
      makeRun({
        generationId: "gen-completed-invalid",
        state: "completed",
        startedAt: "2026-04-02T10:00:00.000Z",
        completedAt: "2026-04-02T10:00:05.000Z",
        invalidCitationCount: 3,
      }),
      makeRun({
        generationId: "gen-completed-clean",
        state: "completed",
        startedAt: "2026-04-01T10:00:00.000Z",
        completedAt: "2026-04-01T10:00:04.000Z",
        invalidCitationCount: 0,
      }),
    ];

    renderPage({ search: "recentRunsOpen=1&recentRunsFilter=invalid" });

    // The filter chips only mount once the runs query resolves
    // (`count > 0`), so wait on the chip itself before asserting its
    // pressed state.
    expect(
      await screen.findByTestId("briefing-recent-runs-filter-invalid"),
    ).toHaveAttribute("aria-pressed", "true");
    const list = await screen.findByTestId("briefing-recent-runs-list");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveAttribute(
      "data-testid",
      "briefing-run-gen-completed-invalid",
    );

    // A second mount with a hand-edited unknown value falls back to
    // the "All" default rather than wedging the panel in an undefined
    // state. This mirrors the allow-list pattern `readTabFromUrl`
    // and `readBackfillFilterFromUrl` use upstream.
    cleanup();
    renderPage({ search: "recentRunsOpen=1&recentRunsFilter=bogus" });
    expect(
      await screen.findByTestId("briefing-recent-runs-filter-all"),
    ).toHaveAttribute("aria-pressed", "true");
    const fallbackList = await screen.findByTestId(
      "briefing-recent-runs-list",
    );
    expect(within(fallbackList).getAllByRole("listitem")).toHaveLength(2);
  });

  it("writes the open state and active filter back to the URL via replaceState as the auditor toggles them", async () => {
    hoisted.runs = [
      makeRun({
        generationId: "gen-failed",
        state: "failed",
        startedAt: "2026-04-01T10:00:00.000Z",
        completedAt: "2026-04-01T10:00:03.000Z",
        error: "OpenAI 503 — upstream unavailable",
      }),
    ];

    renderPage();

    // Defaults: collapsed + "All" are encoded by *omitting* the
    // params, so the canonical engagement URL stays bare on first
    // paint.
    expect(
      new URLSearchParams(window.location.search).get("recentRunsOpen"),
    ).toBeNull();
    expect(
      new URLSearchParams(window.location.search).get("recentRunsFilter"),
    ).toBeNull();

    // Open the disclosure — the URL gains `recentRunsOpen=1`.
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));
    await screen.findByTestId("briefing-recent-runs-list");
    expect(
      new URLSearchParams(window.location.search).get("recentRunsOpen"),
    ).toBe("1");

    // Switch to the Failed filter — the URL gains `recentRunsFilter=failed`.
    fireEvent.click(screen.getByTestId("briefing-recent-runs-filter-failed"));
    expect(
      new URLSearchParams(window.location.search).get("recentRunsFilter"),
    ).toBe("failed");

    // Switching back to "All" *removes* the param rather than writing
    // `recentRunsFilter=all` — the canonical URL stays clean for the
    // default state.
    fireEvent.click(screen.getByTestId("briefing-recent-runs-filter-all"));
    expect(
      new URLSearchParams(window.location.search).get("recentRunsFilter"),
    ).toBeNull();

    // Collapsing the disclosure removes `recentRunsOpen` for the
    // same reason — both defaults are encoded by omission.
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));
    expect(
      new URLSearchParams(window.location.search).get("recentRunsOpen"),
    ).toBeNull();
  });
});

/**
 * Prior-narrative polish — Task #303 B.3 / B.4 / B.5.
 *
 * The Prior row's expanded details became the auditor's primary
 * "what changed in this regeneration?" surface in Task #280. The
 * polish sub-bundle layers three related improvements on top:
 *
 *   - B.3: surface the prior narrative's `generatedAt` +
 *     `generatedBy` so the auditor sees the snapshot's provenance
 *     in-place rather than having to read it off the producing run
 *     row above.
 *   - B.4: a "Copy plain text" button that concatenates the seven
 *     section bodies as `Label\n\nbody` blocks so the snapshot
 *     can be pasted into Slack or a ticket without manual
 *     reformatting.
 *   - B.5: per-section word-level diff vs the current narrative
 *     so the auditor can see the precise edit instead of being
 *     handed two big paragraphs to compare visually. When a
 *     section is byte-identical we render an "(unchanged)" pill
 *     so the auditor isn't asked to scan for diffs that aren't
 *     there.
 */
describe("BriefingRecentRunsPanel — prior-narrative polish (Task #303 B.3/B.4/B.5)", () => {
  function seedPriorRow(opts: {
    priorSectionA?: string | null;
    priorSectionG?: string | null;
    currentSectionA?: string | null;
    currentSectionG?: string | null;
    priorGeneratedBy?: string | null;
  }) {
    hoisted.briefing = {
      narrative: {
        // Pretend the API also surfaced the section bodies on the
        // current narrative so the panel can diff them against the
        // prior body. The real wire envelope from
        // useGetEngagementBriefing carries the section_* columns
        // alongside generationId; this fixture mirrors that.
        generationId: "gen-current",
        sectionA: opts.currentSectionA ?? null,
        sectionB: null,
        sectionC: null,
        sectionD: null,
        sectionE: null,
        sectionF: null,
        sectionG: opts.currentSectionG ?? null,
        generatedAt: "2026-04-03T10:00:05.000Z",
        generatedBy: "system:briefing-engine",
      } as unknown as { generationId: string | null },
    };
    hoisted.priorNarrative = {
      sectionA: opts.priorSectionA ?? null,
      sectionB: null,
      sectionC: null,
      sectionD: null,
      sectionE: null,
      sectionF: null,
      sectionG: opts.priorSectionG ?? null,
      generatedAt: "2026-04-02T10:00:02.000Z",
      generatedBy: opts.priorGeneratedBy ?? "system:briefing-engine",
    };
    hoisted.runs = [
      makeRun({
        generationId: "gen-current",
        state: "completed",
        startedAt: "2026-04-03T10:00:00.000Z",
        completedAt: "2026-04-03T10:00:05.000Z",
        invalidCitationCount: 0,
      }),
      makeRun({
        generationId: "gen-prior",
        state: "completed",
        startedAt: "2026-04-02T10:00:00.000Z",
        completedAt: "2026-04-02T10:00:04.000Z",
        invalidCitationCount: 0,
      }),
    ];
  }

  it("B.3 — renders the prior narrative's generatedAt and generatedBy in the meta line", async () => {
    seedPriorRow({
      priorSectionA: "Same body in both runs.",
      currentSectionA: "Same body in both runs.",
      priorGeneratedBy: "system:briefing-engine",
    });
    renderPage();
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));
    fireEvent.click(
      await screen.findByTestId("briefing-run-toggle-gen-prior"),
    );
    const meta = await screen.findByTestId(
      "briefing-run-prior-narrative-meta-gen-prior",
    );
    // The "system:briefing-engine" actor is rewritten to a friendly
    // label so the auditor sees "Briefing engine (mock)" rather
    // than the raw system actor token.
    expect(
      within(meta).getByTestId(
        "briefing-run-prior-narrative-generated-by-gen-prior",
      ),
    ).toHaveTextContent(/Briefing engine \(mock\)/);
    expect(
      within(meta).getByTestId(
        "briefing-run-prior-narrative-generated-at-gen-prior",
      ),
    ).toHaveTextContent(/Generated/);
  });

  it("B.3 — renders only the half of the meta line that's present (legacy backups)", async () => {
    // Legacy backups can carry `generatedAt` but no `generatedBy`
    // (or vice versa) because the actor column post-dates the
    // section_* backups on some installs. The panel must render
    // only the half that's set so we never show "by null". We
    // can't drop `generatedAt` here too — the prior-row matcher
    // relies on its [startedAt, completedAt] interval containing
    // `priorNarrative.generatedAt`, so a null on that field would
    // also tear down the prior-narrative block entirely (a
    // separate concern than this branch is testing).
    seedPriorRow({
      priorSectionA: "Body present, actor missing.",
      currentSectionA: "Body present, actor missing.",
    });
    hoisted.priorNarrative!.generatedBy = null;
    renderPage();
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));
    fireEvent.click(
      await screen.findByTestId("briefing-run-toggle-gen-prior"),
    );
    const meta = await screen.findByTestId(
      "briefing-run-prior-narrative-meta-gen-prior",
    );
    expect(
      within(meta).getByTestId(
        "briefing-run-prior-narrative-generated-at-gen-prior",
      ),
    ).toBeInTheDocument();
    // The "by …" half is gone — proves we never show "by null".
    expect(
      screen.queryByTestId(
        "briefing-run-prior-narrative-generated-by-gen-prior",
      ),
    ).not.toBeInTheDocument();
  });

  it("B.4 — Copy plain text writes the concatenated A–G bodies to the clipboard", async () => {
    seedPriorRow({
      priorSectionA: "Prior A body.",
      priorSectionG: "Prior G body.",
      currentSectionA: "Current A body.",
      currentSectionG: "Current G body.",
    });
    // JSDOM/happy-dom may or may not ship navigator.clipboard; pin
    // a spy regardless so we can assert the button hit it with the
    // right payload.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderPage();
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));
    fireEvent.click(
      await screen.findByTestId("briefing-run-toggle-gen-prior"),
    );
    fireEvent.click(
      await screen.findByTestId(
        "briefing-run-prior-narrative-copy-gen-prior",
      ),
    );
    expect(writeText).toHaveBeenCalledTimes(1);
    const payload = writeText.mock.calls[0][0] as string;
    // The payload preserves both populated bodies so the auditor
    // can paste the snapshot somewhere readable.
    expect(payload).toMatch(/Prior A body\./);
    expect(payload).toMatch(/Prior G body\./);
    // Empty sections (B–F) render as "—" rather than blank lines
    // so the pasted output has visible structure.
    expect(payload).toMatch(/—/);
  });

  // Task #338 — closes the loop on the Task #303 B.4 copy button.
  // Clipboard writes are silent on success, so without a visible
  // indicator an auditor has to paste somewhere else just to
  // confirm the copy happened. The button now flips its label to
  // "Copied!" for ~2s on a successful write and reverts on its
  // own. The mirroring plan-review test
  // (`artifacts/plan-review/src/components/__tests__/BriefingRecentRunsPanel.test.tsx`)
  // pins the same testid + timing so an auditor moving between
  // the two surfaces sees the same feedback.
  it("B.4 — flips the Copy plain text button to 'Copied!' for ~2s on a successful write", async () => {
    seedPriorRow({
      priorSectionA: "Prior A body.",
      currentSectionA: "Current A body.",
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    // Intentionally NOT using fake timers here — the disclosure
    // and queries lean on react-query's internal timing, and
    // hijacking `setTimeout` globally was observed to deadlock
    // those queries (the test would time out before the runs
    // list ever rendered). Real timers + `waitFor` keep the
    // assertions tight (the revert is gated at 2 s, so the
    // 2.5 s waitFor budget gives a small safety margin).
    renderPage();
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));
    fireEvent.click(
      await screen.findByTestId("briefing-run-toggle-gen-prior"),
    );
    const button = await screen.findByTestId(
      "briefing-run-prior-narrative-copy-gen-prior",
    );
    // Default state: original label, no confirmation node in
    // the tree — proves the flip is gated on click + resolve.
    expect(button).toHaveTextContent("Copy plain text");
    expect(
      screen.queryByTestId(
        "briefing-run-prior-narrative-copy-confirm-gen-prior",
      ),
    ).not.toBeInTheDocument();
    fireEvent.click(button);
    // The confirmation pill mounts once the writeText promise
    // resolves — `findByTestId` polls until React flushes the
    // resulting state update.
    expect(
      await screen.findByTestId(
        "briefing-run-prior-narrative-copy-confirm-gen-prior",
      ),
    ).toHaveTextContent(/copied/i);
    // After ~2s the label reverts so the disclosure doesn't
    // stay frozen on a stale "Copied!" indicator. waitFor's
    // default 1 s budget is too tight for the 2 s revert, so
    // bump it just enough to cover the revert plus a small
    // scheduler-jitter margin.
    await waitFor(
      () => {
        expect(
          screen.queryByTestId(
            "briefing-run-prior-narrative-copy-confirm-gen-prior",
          ),
        ).not.toBeInTheDocument();
      },
      { timeout: 2500 },
    );
    expect(
      screen.getByTestId("briefing-run-prior-narrative-copy-gen-prior"),
    ).toHaveTextContent("Copy plain text");
  });

  // Task #338 — explicit no-false-positive coverage. When the
  // Clipboard API isn't available (older browsers, locked-down
  // contexts, or test environments that don't polyfill it) the
  // button must NOT show the "Copied!" indicator, because the
  // copy didn't actually happen.
  it("B.4 — does not show the 'Copied!' confirmation when navigator.clipboard is unavailable", async () => {
    seedPriorRow({
      priorSectionA: "Prior A body.",
      currentSectionA: "Current A body.",
    });
    // Restore the descriptor in `finally` so the override doesn't
    // leak into sibling tests.
    const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    try {
      renderPage();
      fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));
      fireEvent.click(
        await screen.findByTestId("briefing-run-toggle-gen-prior"),
      );
      const button = await screen.findByTestId(
        "briefing-run-prior-narrative-copy-gen-prior",
      );
      fireEvent.click(button);
      await act(async () => {
        await Promise.resolve();
      });
      expect(
        screen.queryByTestId(
          "briefing-run-prior-narrative-copy-confirm-gen-prior",
        ),
      ).not.toBeInTheDocument();
      expect(button).toHaveTextContent("Copy plain text");
    } finally {
      if (originalClipboardDescriptor) {
        Object.defineProperty(
          navigator,
          "clipboard",
          originalClipboardDescriptor,
        );
      } else {
        delete (navigator as unknown as { clipboard?: unknown }).clipboard;
      }
    }
  });

  it("B.5 — renders an inline word diff when prior and current sections differ", async () => {
    seedPriorRow({
      priorSectionA: "The buildable area is 4500 square feet.",
      currentSectionA: "The buildable area is 5200 square feet.",
    });
    renderPage();
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));
    fireEvent.click(
      await screen.findByTestId("briefing-run-toggle-gen-prior"),
    );
    const diff = await screen.findByTestId(
      "briefing-run-prior-section-diff-a-gen-prior",
    );
    // The dropped "4500" token survives in the prior body wrapped
    // in a strike-through span; the inserted "5200" token shows
    // up in the same diff span. Together they tell the auditor
    // exactly what the regeneration changed.
    expect(diff).toHaveTextContent(/4500/);
    expect(diff).toHaveTextContent(/5200/);
    expect(
      within(diff).getByTestId(
        "briefing-run-prior-section-diff-removed-a-gen-prior",
      ),
    ).toHaveTextContent("4500");
  });

  it("B.5 — surfaces an (unchanged) pill when a section is byte-identical", async () => {
    seedPriorRow({
      priorSectionA: "Identical body.",
      currentSectionA: "Identical body.",
      priorSectionG: "Different prior G.",
      currentSectionG: "Different current G.",
    });
    renderPage();
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));
    fireEvent.click(
      await screen.findByTestId("briefing-run-toggle-gen-prior"),
    );
    // Section A has the unchanged pill (and no diff span)…
    expect(
      await screen.findByTestId(
        "briefing-run-prior-section-unchanged-a-gen-prior",
      ),
    ).toHaveTextContent(/unchanged/i);
    expect(
      screen.queryByTestId("briefing-run-prior-section-diff-a-gen-prior"),
    ).not.toBeInTheDocument();
    // …while section G keeps the diff span (and no unchanged pill).
    // Proves the unchanged-detection is per-section, not a global
    // flag.
    expect(
      screen.getByTestId("briefing-run-prior-section-diff-g-gen-prior"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId(
        "briefing-run-prior-section-unchanged-g-gen-prior",
      ),
    ).not.toBeInTheDocument();
  });
});

/**
 * "Producing run pruned" pill — Task #303 B.8.
 *
 * When `parcel_briefings.generation_id` points at a job the sweeper
 * has already aged out of the keep window, the briefing card's
 * "Last generated by …" line reads more authoritatively than the
 * audit trail can support: there's no row left in the disclosure to
 * mark Current. We annotate the meta line with a small pill so the
 * auditor knows the on-screen narrative is real but its provenance
 * run is no longer available for inspection.
 */
describe("BriefingRecentRunsPanel — producing-run-pruned pill (Task #303 B.8)", () => {
  it("renders the pill when narrative.generationId has no matching run in the list", async () => {
    hoisted.briefing = {
      narrative: { generationId: "gen-aged-out" },
    };
    // Deliberately empty runs list — the producing job aged out
    // before this auditor opened the card.
    hoisted.runs = [];
    renderPage();
    expect(
      await screen.findByTestId("briefing-narrative-producing-run-pruned"),
    ).toHaveTextContent(/producing run pruned from history/i);
  });

  it("does NOT render the pill when the producing run is still on file", async () => {
    hoisted.briefing = {
      narrative: { generationId: "gen-live" },
    };
    hoisted.runs = [
      makeRun({
        generationId: "gen-live",
        state: "completed",
        startedAt: "2026-04-03T10:00:00.000Z",
        completedAt: "2026-04-03T10:00:05.000Z",
      }),
    ];
    renderPage();
    // Wait for the briefing card to mount so the absence assertion
    // isn't checking against a still-loading state.
    await screen.findByTestId("briefing-narrative-panel");
    expect(
      screen.queryByTestId("briefing-narrative-producing-run-pruned"),
    ).not.toBeInTheDocument();
  });

  it("does NOT render the pill when the briefing has no generationId at all", async () => {
    // Brand-new engagement, never generated a briefing — the pill
    // would be a generic "stale briefing" warning here, which the
    // B.8 spec is explicit about avoiding.
    hoisted.briefing = { narrative: { generationId: null } };
    hoisted.runs = [];
    renderPage();
    await screen.findByTestId("briefing-narrative-panel");
    expect(
      screen.queryByTestId("briefing-narrative-producing-run-pruned"),
    ).not.toBeInTheDocument();
  });
});
