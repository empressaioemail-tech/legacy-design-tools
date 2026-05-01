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
    // Task #263 — the briefing payload the GET /briefing query mock
    // returns. Tests that need a "narrative is currently on screen"
    // condition can replace this with a fixture that has a
    // non-null `narrative.generatedAt`; the default keeps the
    // existing "no narrative" shape so all of the prior tests
    // continue to render the same way.
    briefing: null as null | {
      narrative: { generatedAt: string | null } | null;
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

  // ── Task #263 ──────────────────────────────────────────────────────
  // Tagging the row whose generation produced the narrative on screen
  // closes the comparison loop the Task #230 disclosure opened. The
  // briefing engine only writes `section_a..g` on `completed` runs,
  // so the row to mark is the most recent `completed` row in the
  // newest-first list — `pending` rows haven't written anything yet
  // and `failed` rows leave the previous narrative intact. With no
  // narrative on screen (brand-new engagement, or the first run is
  // still in flight) no row carries the pill.
  it("marks the most recent completed run as 'Current' when a narrative is on screen", async () => {
    // Narrative is loaded — the briefing-query mock returns a
    // payload with a non-null `generatedAt`, so the parent passes
    // that timestamp into the disclosure.
    hoisted.briefing = {
      narrative: { generatedAt: "2026-04-02T10:00:04.000Z" },
    };
    // A pending newer run, then the completed run that produced
    // what's on screen, then an older failed attempt. Only the
    // middle row should carry the "Current" pill — the pending
    // row hasn't written sections yet, and the failed older row
    // never updated the briefing.
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

    // The middle (most-recent-completed) row carries the pill and
    // is also marked with `aria-current="true"` so assistive tech
    // can announce the same "this is what's on screen" cue the
    // visual highlight conveys.
    const currentRow = within(list).getByTestId("briefing-run-gen-current");
    expect(currentRow).toHaveAttribute("aria-current", "true");
    expect(
      within(currentRow).getByTestId(
        "briefing-run-current-pill-gen-current",
      ),
    ).toHaveTextContent(/Current/i);

    // No other row should carry the pill — the pending row is
    // newer but hasn't completed, and the failed older row never
    // updated the briefing.
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

  it("matches by narrative.generatedAt rather than picking the latest completed row", async () => {
    // The newest completed row is NOT the one that produced the
    // narrative on screen — say a regeneration just landed but
    // the briefing read is still serving the previous body
    // (e.g. cache lag during the pending → terminal transition,
    // or an external cache pin). The narrative's `generatedAt`
    // falls inside the OLDER completed run's [startedAt,
    // completedAt] window, so the disclosure must mark THAT
    // row Current, not the newer one whose interval is
    // strictly after the narrative's stamp.
    hoisted.briefing = {
      narrative: { generatedAt: "2026-04-02T10:00:02.000Z" },
    };
    hoisted.runs = [
      // Newer completed run — its interval [10:00:00, 10:00:05]
      // on April 3 is strictly after the narrative timestamp,
      // so the narrative cannot have come from it.
      makeRun({
        generationId: "gen-newer-completed",
        state: "completed",
        startedAt: "2026-04-03T10:00:00.000Z",
        completedAt: "2026-04-03T10:00:05.000Z",
        invalidCitationCount: 0,
      }),
      // Older completed run whose [startedAt, completedAt]
      // window contains the narrative's generatedAt — this is
      // the producer.
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
    // matcher used the narrative timestamp, not "first completed".
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

  it("marks no row 'Current' when the narrative was produced by a run the sweep already pruned", async () => {
    // Narrative is loaded and stamped at a timestamp that does
    // NOT fall inside any retained run's interval — the
    // producing job was pruned out of the keep-N window. The
    // disclosure stays honest: rather than guessing, no row is
    // marked Current.
    hoisted.briefing = {
      narrative: { generatedAt: "2025-12-31T23:59:59.000Z" },
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
      narrative: { generatedAt: "2026-04-03T10:00:02.000Z" },
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
      narrative: { generatedAt: "2026-04-03T10:00:02.000Z" },
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

  it("renders no Prior pill anywhere when the briefing has never been regenerated (Task #280)", async () => {
    // First-generation-only state: the briefing row exists with
    // a current narrative on screen, but `prior_section_*` are
    // null because no overwrite has happened yet. The runs list
    // has only the producing run; the disclosure marks it
    // Current and renders no Prior pill — the auditor isn't
    // told a prior body is recoverable when it isn't.
    hoisted.briefing = {
      narrative: { generatedAt: "2026-04-03T10:00:02.000Z" },
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
