/**
 * BriefingRecentRunsPanel — Plan Review-side audit coverage for Task #261.
 *
 * Mirrors the Design Tools test of the same name
 * (`artifacts/design-tools/src/pages/__tests__/BriefingRecentRunsPanel.test.tsx`,
 * Task #230) so the two surfaces stay in lock-step on the disclosure
 * behavior an auditor relies on:
 *
 *   1. The disclosure is collapsed by default and does NOT call the
 *      runs hook (saves a round trip on every page load), then opens
 *      to render every retained row newest-first with state badges
 *      and timestamps.
 *   2. Clicking a row reveals its outcome details inline — `error`
 *      for the failed branch, `invalidCitationCount` for the
 *      completed branch — without navigating away from the page.
 *
 * Plan Review has no kickoff button (auditors don't generate
 * briefings), so the kickoff-invalidation test from the Design
 * Tools file is intentionally not mirrored here.
 *
 * The setup mirrors `EngagementDetail.test.tsx` (Task #112) — the
 * page reads the engagement id off `useParams`, so we hard-pin
 * wouter's `useParams` and mount `<EngagementDetail />` directly
 * without a Router wrapper. The runs hook is wired through a real
 * `useQuery` against hoisted state so opening the disclosure
 * triggers a real refetch.
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
// every queryFn invocation. `runsFetchCalls` counts actual fetches
// so the "collapsed = no fetch" assertion can verify the runs route
// stays dormant until the toggle flips.
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
      name: "Seguin Residence",
      jurisdiction: "Moab, UT",
      address: "123 Main St",
      site: null as { address: string | null } | null,
    } as {
      id: string;
      name: string;
      jurisdiction: string | null;
      address: string | null;
      site: { address: string | null } | null;
    },
    submissions: [] as Array<{
      id: string;
      submittedAt: string;
      jurisdiction: string | null;
      note: string | null;
      status: "pending" | "approved" | "corrections_requested" | "rejected";
      reviewerComment: string | null;
      respondedAt: string | null;
    }>,
    runs: initialRuns,
    runsFetchCalls: 0,
    // Task #314 — the runs envelope also carries the `prior_section_*`
    // backup snapshot the briefing held before its current narrative
    // was written. Default to `null` so existing tests keep their
    // previous semantics (no prior block rendered); tests that
    // exercise the inline diff replace this with a populated
    // payload via `seedPriorRow` below.
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
    // Task #314 — the briefing payload the GET /briefing query mock
    // returns. The diff renderer needs the *current* narrative to
    // diff each prior section against. Default `null` keeps the
    // existing "no narrative" shape so all of the prior tests
    // continue to render the same way; the B.5 tests below
    // populate it via `seedPriorRow`.
    briefing: null as null | {
      narrative: {
        generationId: string | null;
        sectionA: string | null;
        sectionB: string | null;
        sectionC: string | null;
        sectionD: string | null;
        sectionE: string | null;
        sectionF: string | null;
        sectionG: string | null;
        generatedAt: string | null;
        generatedBy: string | null;
      } | null;
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

// The 2 KB note ceiling — the parent page imports the Submit dialog
// which reads this constant from `@workspace/api-zod`.
vi.mock("@workspace/api-zod", () => ({
  createEngagementSubmissionBodyNoteMax: 2048,
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
    getGetEngagementQueryKey: (id: string) => ["getEngagement", id],
    getListEngagementSubmissionsQueryKey: (id: string) => [
      "listEngagementSubmissions",
      id,
    ],
    getGetSessionQueryKey: () => ["getSession"],
    // Task #261 — the new key the disclosure reads from.
    getListEngagementBriefingGenerationRunsQueryKey: (id: string) => [
      "listEngagementBriefingGenerationRuns",
      id,
    ],
    // Task #314 — the panel now also pulls the current narrative so
    // the prior-narrative block can diff each A–G section against
    // the live body on screen.
    getGetEngagementBriefingQueryKey: (id: string) => [
      "getEngagementBriefing",
      id,
    ],
    useGetEngagementBriefing: (
      id: string,
      opts?: {
        query?: {
          queryKey?: readonly unknown[];
          enabled?: boolean;
          refetchOnWindowFocus?: boolean;
        };
      },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ?? (["getEngagementBriefing", id] as const),
        queryFn: async () => ({
          // Cloned so a test that mutates the hoisted briefing
          // post-render doesn't accidentally mutate the cached
          // payload react-query is holding.
          briefing: hoisted.briefing
            ? {
                narrative: hoisted.briefing.narrative
                  ? { ...hoisted.briefing.narrative }
                  : null,
              }
            : null,
        }),
        enabled: opts?.query?.enabled ?? true,
        refetchOnWindowFocus: opts?.query?.refetchOnWindowFocus ?? true,
      }),
    useGetSession: () =>
      useQuery({
        queryKey: ["getSession"],
        queryFn: async () => ({ permissions: [] as string[] }),
      }),
    useGetEngagement: (
      id: string,
      opts?: { query?: { queryKey?: readonly unknown[] } },
    ) =>
      useQuery({
        queryKey: opts?.query?.queryKey ?? (["getEngagement", id] as const),
        queryFn: async () => ({ ...hoisted.engagement }),
      }),
    useListEngagementSubmissions: (
      id: string,
      opts?: { query?: { queryKey?: readonly unknown[] } },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ?? (["listEngagementSubmissions", id] as const),
        queryFn: async () => hoisted.submissions.map((s) => ({ ...s })),
      }),
    useCreateEngagementSubmission: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
    // Task #261 — the hook the disclosure calls. We honor the
    // `enabled` flag from the panel so the "collapsed = no fetch"
    // assertion can pass; queryFn re-reads `hoisted.runs` on every
    // refetch so a test can drive the cache from outside.
    useListEngagementBriefingGenerationRuns: (
      id: string,
      opts?: {
        query?: {
          queryKey?: readonly unknown[];
          enabled?: boolean;
          refetchOnWindowFocus?: boolean;
        };
      },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ??
          (["listEngagementBriefingGenerationRuns", id] as const),
        queryFn: async () => {
          hoisted.runsFetchCalls += 1;
          // The route returns `runs` newest-first; the hoisted array
          // is treated as already in newest-first order so each
          // test can shift new rows onto the front.
          // Task #314 — the same envelope also carries the
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
      }),
  };
});

const EngagementDetail = (await import("../../pages/EngagementDetail")).default;

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
  // fully without async waits.
  client.setQueryData(["getEngagement", hoisted.engagement.id], {
    ...hoisted.engagement,
  });
  client.setQueryData(
    ["listEngagementSubmissions", hoisted.engagement.id],
    hoisted.submissions.map((s) => ({ ...s })),
  );
  client.setQueryData(["getSession"], { permissions: [] as string[] });
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
    name: "Seguin Residence",
    jurisdiction: "Moab, UT",
    address: "123 Main St",
    site: null,
  };
  hoisted.submissions = [];
  hoisted.runs = [];
  hoisted.runsFetchCalls = 0;
  // Task #314 — default to "no current narrative" + "no prior backup"
  // so existing tests keep rendering as they did before; the B.5
  // tests below override these via `seedPriorRow`.
  hoisted.briefing = null;
  hoisted.priorNarrative = null;
  // Task #303 B.6 — the panel now mirrors its open/filter state
  // into `?recentRunsOpen=` / `?recentRunsFilter=`, so a test that
  // flips the disclosure leaves those params behind in the JSDOM
  // URL. Reset to a clean URL between tests so each test sees the
  // panel at its true defaults (collapsed, "all" filter) rather
  // than picking up the previous test's pollution.
  if (typeof window !== "undefined") {
    window.history.replaceState(null, "", "/");
  }
});

afterEach(() => {
  cleanup();
});

describe("BriefingRecentRunsPanel — Plan Review (Task #261)", () => {
  it("starts collapsed and opens to show retained runs newest-first with state badges", async () => {
    // Three retained runs spanning the wire enum: a pending most-recent
    // attempt, a successfully-completed prior run, and an older failed
    // attempt. Newest-first ordering mirrors what the route returns.
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
    // No actual fetch should have fired against the runs route while
    // the disclosure is collapsed.
    expect(hoisted.runsFetchCalls).toBe(0);

    // Open the disclosure.
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));

    // Once enabled, the runs hook fetches and the body paints with
    // every retained row.
    const list = await screen.findByTestId("briefing-recent-runs-list");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    // Newest-first — `gen-3` (pending) first, `gen-1` (failed) last.
    expect(items[0]).toHaveAttribute("data-testid", "briefing-run-gen-3");
    expect(items[1]).toHaveAttribute("data-testid", "briefing-run-gen-2");
    expect(items[2]).toHaveAttribute("data-testid", "briefing-run-gen-1");
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
    // The completed-with-invalid-citations row surfaces the count
    // summary in the collapsed header so an auditor can spot the
    // suspicious run without expanding it.
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

    // Expand the failed row — the error string should appear in the
    // inline details panel.
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

  it("shows an empty-state message when no runs have been retained yet", async () => {
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
});

/**
 * URL helpers + filter chips — Task #303 B.6.
 *
 * Mirrors the design-tools `BriefingRecentRunsPanel` URL contract
 * (Tasks #262 / #275) onto the Plan Review surface so an auditor
 * who pastes a Plan Review link into Slack lands a teammate on the
 * same disclosure state — open vs collapsed, "All / Failed only /
 * Invalid only" filter — that the original auditor was looking at.
 *
 * Tests below pin:
 *   1. The disclosure is OPEN on first paint when
 *      `?recentRunsOpen=1` is present.
 *   2. Flipping the toggle writes `?recentRunsOpen=` (or removes it
 *      when collapsing) via `replaceState` so back-button history
 *      isn't polluted.
 *   3. The filter chip array reflects the URL on first paint and
 *      writes back on click; the visible row count is the bucket's
 *      count, not the All count.
 *   4. An invalid `recentRunsFilter` value falls back to "all".
 */
describe("BriefingRecentRunsPanel — URL helpers (Task #303 B.6)", () => {
  it("opens on first paint when ?recentRunsOpen=1 is present", async () => {
    hoisted.runs = [
      makeRun({ generationId: "gen-1", state: "completed" }),
    ];
    window.history.replaceState(null, "", "/?recentRunsOpen=1");
    renderPage();
    // Body is mounted without any toggle click — the panel honoured
    // the URL state on first paint.
    expect(
      await screen.findByTestId("briefing-recent-runs-body"),
    ).toBeInTheDocument();
  });

  it("writes ?recentRunsOpen=1 on open and clears it on close", async () => {
    hoisted.runs = [
      makeRun({ generationId: "gen-1", state: "completed" }),
    ];
    renderPage();
    expect(window.location.search).not.toContain("recentRunsOpen");
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));
    expect(window.location.search).toContain("recentRunsOpen=1");
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));
    expect(window.location.search).not.toContain("recentRunsOpen");
  });

  it("respects ?recentRunsFilter=failed on first paint and slices the list", async () => {
    hoisted.runs = [
      makeRun({
        generationId: "gen-fail",
        state: "failed",
        error: "boom",
      }),
      makeRun({ generationId: "gen-ok", state: "completed" }),
    ];
    window.history.replaceState(
      null,
      "",
      "/?recentRunsOpen=1&recentRunsFilter=failed",
    );
    renderPage();
    // Failed chip should read the URL value and be the selected one.
    const failedChip = await screen.findByTestId(
      "briefing-recent-runs-filter-failed",
    );
    expect(failedChip.getAttribute("aria-selected")).toBe("true");
    // Only the failed row is rendered under the filter.
    expect(screen.getByTestId("briefing-run-gen-fail")).toBeInTheDocument();
    expect(screen.queryByTestId("briefing-run-gen-ok")).not.toBeInTheDocument();
  });

  it("clicking a filter chip writes the chip's value to the URL", async () => {
    hoisted.runs = [
      makeRun({
        generationId: "gen-fail",
        state: "failed",
        error: "boom",
      }),
      makeRun({
        generationId: "gen-ok",
        state: "completed",
        invalidCitationCount: 0,
      }),
    ];
    renderPage();
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));
    await screen.findByTestId("briefing-recent-runs-filter");
    fireEvent.click(screen.getByTestId("briefing-recent-runs-filter-failed"));
    expect(window.location.search).toContain("recentRunsFilter=failed");
    // Returning to "all" deletes the param so the canonical URL
    // stays clean for shareable links.
    fireEvent.click(screen.getByTestId("briefing-recent-runs-filter-all"));
    expect(window.location.search).not.toContain("recentRunsFilter");
  });

  it("falls back to 'all' when ?recentRunsFilter is an unknown value", async () => {
    hoisted.runs = [
      makeRun({ generationId: "gen-1", state: "completed" }),
    ];
    window.history.replaceState(
      null,
      "",
      "/?recentRunsOpen=1&recentRunsFilter=banana",
    );
    renderPage();
    const allChip = await screen.findByTestId(
      "briefing-recent-runs-filter-all",
    );
    expect(allChip.getAttribute("aria-selected")).toBe("true");
  });

  it("renders the filtered-empty copy when the filter eats every row", async () => {
    hoisted.runs = [
      makeRun({ generationId: "gen-1", state: "completed" }),
    ];
    window.history.replaceState(
      null,
      "",
      "/?recentRunsOpen=1&recentRunsFilter=failed",
    );
    renderPage();
    expect(
      await screen.findByTestId("briefing-recent-runs-filtered-empty"),
    ).toHaveTextContent(/No runs match the Failed only filter/i);
    expect(
      screen.queryByTestId("briefing-recent-runs-list"),
    ).not.toBeInTheDocument();
  });
});

/**
 * Prior-narrative inline diff — Task #314.
 *
 * Mirrors the design-tools `BriefingRecentRunsPanel` Task #303 B.5
 * cases onto the Plan Review surface so an auditor who lands in
 * Plan Review sees the same per-A–G-section comparison the
 * architect-facing surface renders. Both surfaces share the
 * `@workspace/briefing-diff` helper this task lifted out of the
 * design-tools page; if either side stops rendering the diff (or
 * the unchanged pill) the matching mirror test will fail and
 * surface the divergence before the surfaces drift apart.
 *
 * Tests below pin:
 *   1. When prior + current bodies differ for a given section, the
 *      diff span renders with a `removed` annotation for the
 *      dropped token (and the inserted token reads in the same
 *      span).
 *   2. When a section is byte-identical between the prior and
 *      current narratives, the diff span is suppressed in favour
 *      of an `(unchanged)` pill — the unchanged-detection is
 *      per-section, not a global flag.
 */
describe("BriefingRecentRunsPanel — prior-narrative diff (Task #314)", () => {
  // Helper that pre-stages a "current ran at 10:00:05, prior ran
  // at 10:00:02" pair of runs plus a populated `priorNarrative` so
  // the panel resolves `priorGenerationId` via interval matching
  // and mounts the prior-narrative block on the prior row's
  // expanded details. Mirrors the design-tools `seedPriorRow`.
  function seedPriorRow(opts: {
    priorSectionA?: string | null;
    priorSectionG?: string | null;
    currentSectionA?: string | null;
    currentSectionG?: string | null;
    // Task #332 — the B.3 tests below need to flex the actor token
    // independently of the section bodies so the friendly label
    // rewrite (`system:briefing-engine` -> `Briefing engine (mock)`)
    // can be exercised. Default to the system actor so the existing
    // diff tests above keep their previous semantics.
    priorGeneratedBy?: string | null;
  }) {
    hoisted.briefing = {
      narrative: {
        // The real wire envelope from useGetEngagementBriefing
        // carries the section_* columns alongside generationId; this
        // fixture mirrors that so the diff renderer has both sides
        // of each A–G section to compare.
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
      },
    };
    hoisted.priorNarrative = {
      sectionA: opts.priorSectionA ?? null,
      sectionB: null,
      sectionC: null,
      sectionD: null,
      sectionE: null,
      sectionF: null,
      sectionG: opts.priorSectionG ?? null,
      // The prior backup's `generatedAt` lands inside the
      // [startedAt, completedAt] interval of the `gen-prior` run
      // below so the panel resolves that row as the Prior row.
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

  it("renders an inline word diff when prior and current sections differ", async () => {
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
    // exactly what the regeneration changed — the same
    // word-by-word story the architect-facing surface tells via
    // the shared `@workspace/briefing-diff` helper.
    expect(diff).toHaveTextContent(/4500/);
    expect(diff).toHaveTextContent(/5200/);
    expect(
      within(diff).getByTestId(
        "briefing-run-prior-section-diff-removed-a-gen-prior",
      ),
    ).toHaveTextContent("4500");
  });

  // Task #333 — mirrors design-tools Task #303 B.4. Closes the
  // parity gap left by Task #314 (which mirrored the diff but not
  // the copy button). The clipboard payload shape — `Label\n\nbody`
  // blocks separated by blank lines, with empty sections rendered
  // as "—" — must stay byte-identical with the design-tools side
  // so a future shared-lib lift is a no-op; if either side
  // diverges this mirror test will fail and surface the drift
  // before auditors paste two visibly different snapshots into
  // the same Slack thread.
  it("Copy plain text writes the concatenated A–G bodies to the clipboard", async () => {
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
    // so the pasted output has visible structure — matches the
    // design-tools payload shape exactly.
    expect(payload).toMatch(/—/);
  });

  // Task #337 — mirrors design-tools Task #303 B.3. Closes the
  // last remaining parity gap on the prior-narrative block (B.4
  // landed via Task #333, B.5 via Task #314). The meta line shape
  // — "Generated [time] by [author]", with the
  // `system:briefing-engine` actor rewritten to "Briefing engine
  // (mock)", and each half rendered conditionally so legacy rows
  // with only one half don't show "by null" or "at —" — must
  // stay byte-identical with the design-tools side so a future
  // shared-lib lift is a no-op. If either side diverges, this
  // mirror test will fail and surface the drift before auditors
  // see two surfaces telling different provenance stories.
  it("renders the prior narrative's generatedAt and generatedBy in the meta line", async () => {
    seedPriorRow({
      priorSectionA: "Same body in both runs.",
      currentSectionA: "Same body in both runs.",
    });
    renderPage();
    fireEvent.click(screen.getByTestId("briefing-recent-runs-toggle"));
    fireEvent.click(
      await screen.findByTestId("briefing-run-toggle-gen-prior"),
    );
    const meta = await screen.findByTestId(
      "briefing-run-prior-narrative-meta-gen-prior",
    );
    // The "system:briefing-engine" actor is rewritten to a
    // friendly label so the auditor sees "Briefing engine (mock)"
    // rather than the raw system actor token.
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

  it("renders only the half of the meta line that's present (legacy backups)", async () => {
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

  // Task #338 — closes the loop on the Task #333 copy button by
  // surfacing a short-lived "Copied!" confirmation when the
  // clipboard write resolves. The two surfaces (Plan Review and
  // design-tools) must stay in lock-step on:
  //   - the `briefing-run-prior-narrative-copy-confirm-${id}`
  //     testid (so a future shared-lib lift is a no-op), and
  //   - the ~2s revert window (so an auditor moving between the
  //     two surfaces sees the same timing).
  // If either side drifts this mirror test will fail and surface
  // the divergence before auditors notice the inconsistent
  // feedback.
  it("flips the Copy plain text button to 'Copied!' for ~2s on a successful write", async () => {
    seedPriorRow({
      priorSectionA: "Prior A body.",
      currentSectionA: "Current A body.",
    });
    // Resolve immediately so the .then() that flips the button
    // label fires on the next microtask flush. Real promise (not
    // a synchronous shim) so the production code's `.then(...)`
    // chain runs as it would in a browser.
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
    // Sanity check: the default label is "Copy plain text" and
    // the confirmation testid is NOT in the tree — proves the
    // flip is gated on the click + write resolving.
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
    const confirmPill = await screen.findByTestId(
      "briefing-run-prior-narrative-copy-confirm-gen-prior",
    );
    expect(confirmPill).toHaveTextContent(/copied/i);
    // Task #351 — guard the success treatment.
    expect(confirmPill).toHaveAttribute("data-copy-state", "success");
    expect(
      screen.getByTestId("briefing-run-prior-narrative-copy-gen-prior"),
    ).toHaveAttribute("data-copy-state", "success");
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
    // Task #351 — guard the revert to `idle`.
    expect(
      screen.getByTestId("briefing-run-prior-narrative-copy-gen-prior"),
    ).toHaveAttribute("data-copy-state", "idle");
  });

  // Task #338 / #345 — explicit no-false-positive coverage on the
  // failure path. When the Clipboard API isn't available (older
  // browsers, locked-down contexts, or test environments that
  // don't polyfill it) the button must NOT show the "Copied!"
  // indicator, because the copy didn't actually happen. Task #345
  // closes the symmetric loop — the same branch must surface a
  // short-lived "Couldn't copy" pill under the mirrored
  // `*-copy-error-*` testid so the auditor knows to retry or
  // hand-select the seven sections instead of silently believing
  // the copy landed.
  it("surfaces a 'Couldn't copy' indicator (not 'Copied!') when navigator.clipboard is unavailable", async () => {
    seedPriorRow({
      priorSectionA: "Prior A body.",
      currentSectionA: "Current A body.",
    });
    // Force the Clipboard API to look unavailable so the button's
    // early-return branch fires and the .then(...) never runs.
    // Clean up after this test to avoid leaking the override into
    // sibling tests (the (unchanged) pill test below was observed
    // to flake when this property was left undefined).
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
      // The error pill mounts synchronously off the
      // early-return branch (no promise to await), so it's in
      // the tree on the next microtask flush.
      const errorPill = await screen.findByTestId(
        "briefing-run-prior-narrative-copy-error-gen-prior",
      );
      expect(errorPill).toHaveTextContent(/couldn.?t copy/i);
      // Task #351 — guard the danger treatment.
      expect(errorPill).toHaveAttribute("data-copy-state", "error");
      expect(
        screen.getByTestId("briefing-run-prior-narrative-copy-gen-prior"),
      ).toHaveAttribute("data-copy-state", "error");
      // The success pill must NEVER appear on the failure path —
      // the auditor's whole signal is that the copy did NOT
      // land, so a stray "Copied!" would be a false positive.
      expect(
        screen.queryByTestId(
          "briefing-run-prior-narrative-copy-confirm-gen-prior",
        ),
      ).not.toBeInTheDocument();
      // After ~2s the indicator reverts so the disclosure
      // doesn't stay frozen on a stale "Couldn't copy" pill.
      await waitFor(
        () => {
          expect(
            screen.queryByTestId(
              "briefing-run-prior-narrative-copy-error-gen-prior",
            ),
          ).not.toBeInTheDocument();
        },
        { timeout: 2500 },
      );
      expect(
        screen.getByTestId("briefing-run-prior-narrative-copy-gen-prior"),
      ).toHaveTextContent("Copy plain text");
    } finally {
      if (originalClipboardDescriptor) {
        Object.defineProperty(
          navigator,
          "clipboard",
          originalClipboardDescriptor,
        );
      } else {
        // The property didn't exist before — best-effort delete.
        delete (navigator as unknown as { clipboard?: unknown }).clipboard;
      }
    }
  });

  // Task #345 — rejected-promise branch. Even when the Clipboard
  // API is present, `writeText` can still reject (focus loss, an
  // OS-level permission denial, a sandbox refusal). Without the
  // mirrored "Couldn't copy" indicator the auditor would click,
  // see the label flicker back to "Copy plain text", and have no
  // way to tell the copy actually failed. The mirroring
  // design-tools test pins the same testid + timing so a future
  // shared-lib lift stays a no-op.
  it("surfaces the 'Couldn't copy' indicator when navigator.clipboard.writeText rejects", async () => {
    seedPriorRow({
      priorSectionA: "Prior A body.",
      currentSectionA: "Current A body.",
    });
    // Reject with a real Error so the production `.catch(() =>
    // ...)` branch runs exactly as it would in a browser that
    // refused the write (focus loss, sandbox denial, etc.).
    const writeText = vi
      .fn()
      .mockRejectedValue(new Error("clipboard write refused"));
    // Restore the descriptor in `finally` so the override doesn't
    // leak into sibling tests — a leaked rejecting clipboard
    // would silently flip any later test that exercises the
    // copy button into the failure branch.
    const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
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
      expect(writeText).toHaveBeenCalledTimes(1);
      // The error pill mounts once the rejection settles —
      // `findByTestId` polls until React flushes the resulting
      // state update from the `.catch(...)` branch.
      const rejectedErrorPill = await screen.findByTestId(
        "briefing-run-prior-narrative-copy-error-gen-prior",
      );
      expect(rejectedErrorPill).toHaveTextContent(/couldn.?t copy/i);
      // Task #351 — guard the danger treatment.
      expect(rejectedErrorPill).toHaveAttribute(
        "data-copy-state",
        "error",
      );
      expect(
        screen.getByTestId("briefing-run-prior-narrative-copy-gen-prior"),
      ).toHaveAttribute("data-copy-state", "error");
      // Mutually-exclusive invariant — only one of {success,
      // error} can be in the tree at a time. A stray "Copied!"
      // pill on a rejected write would tell the auditor the
      // copy succeeded when it did not.
      expect(
        screen.queryByTestId(
          "briefing-run-prior-narrative-copy-confirm-gen-prior",
        ),
      ).not.toBeInTheDocument();
      await waitFor(
        () => {
          expect(
            screen.queryByTestId(
              "briefing-run-prior-narrative-copy-error-gen-prior",
            ),
          ).not.toBeInTheDocument();
        },
        { timeout: 2500 },
      );
      expect(
        screen.getByTestId("briefing-run-prior-narrative-copy-gen-prior"),
      ).toHaveTextContent("Copy plain text");
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

  it("surfaces an (unchanged) pill when a section is byte-identical", async () => {
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
    // Section A has the unchanged pill (and no diff span) — the
    // auditor isn't asked to re-read identical paragraphs.
    expect(
      await screen.findByTestId(
        "briefing-run-prior-section-unchanged-a-gen-prior",
      ),
    ).toHaveTextContent(/unchanged/i);
    expect(
      screen.queryByTestId("briefing-run-prior-section-diff-a-gen-prior"),
    ).not.toBeInTheDocument();
    // …while section G keeps the diff span (and no unchanged
    // pill). Proves the unchanged-detection is per-section, not a
    // global flag.
    expect(
      screen.getByTestId("briefing-run-prior-section-diff-g-gen-prior"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId(
        "briefing-run-prior-section-unchanged-g-gen-prior",
      ),
    ).not.toBeInTheDocument();
  });

  /**
   * Task #332 — Prior-narrative meta line.
   *
   * Mirrors the design-tools Task #303 B.3 cases onto the Plan
   * Review surface so an external auditor sees who/when produced
   * the prior snapshot in-place rather than bouncing back to
   * design-tools to investigate the producing actor. Both halves
   * are gated independently so legacy backups that only carry one
   * side never render "by null" or "Generated —".
   */
  it("B.3 — renders the prior narrative's generatedAt as relative time (with absolute tooltip) and generatedBy in the meta line", async () => {
    // Pin `Date.now()` so `relativeTime()`'s bucket boundaries
    // are deterministic — without this the test would render
    // anywhere from "Xd ago" to a locale date depending on when
    // CI ran. The seed `generatedAt` is 5 min before this
    // pinned "now", which lands in the "5 min ago" bucket.
    //
    // We stub `Date.now` directly rather than reaching for
    // `vi.useFakeTimers()` because react-query's internal
    // microtask scheduling relies on real `setTimeout` /
    // `queueMicrotask` plumbing — fake timers stall the runs
    // hook's `queryFn` and the disclosure body never paints,
    // hanging the test until the 10s timeout.
    const pinnedNow = new Date("2026-04-02T10:05:02.000Z").getTime();
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(pinnedNow);
    try {
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
      // than the raw system actor token — same wording the
      // architect-facing surface uses.
      expect(
        within(meta).getByTestId(
          "briefing-run-prior-narrative-generated-by-gen-prior",
        ),
      ).toHaveTextContent(/Briefing engine \(mock\)/);
      const generatedAtEl = within(meta).getByTestId(
        "briefing-run-prior-narrative-generated-at-gen-prior",
      );
      // Relative-time output: 5 minutes between seed and pinned
      // "now" lands in the "5 min ago" bucket. Asserting the
      // exact bucket text proves the panel is using the
      // relative-time helper (not the raw locale stamp), so a
      // future change that swaps it back to `.toLocaleString()`
      // — which would render the absolute "10:00:02 AM" instead —
      // will fail this assertion.
      expect(generatedAtEl).toHaveTextContent(/Generated 5 min ago/);
      // The absolute timestamp survives in the tooltip so a hover
      // still reveals the precise instant.
      expect(generatedAtEl.getAttribute("title")).toBeTruthy();
      expect(generatedAtEl.getAttribute("title")).toMatch(/2026/);
    } finally {
      dateNowSpy.mockRestore();
    }
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
});
