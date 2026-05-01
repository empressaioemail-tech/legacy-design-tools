/**
 * EngagementDetail — regression coverage for the post-submit confirmation
 * banner introduced by Task #100 and locked in here by Task #112.
 *
 * The banner is the only post-submit affordance on the plan-review side
 * (the dialog itself closes on success), so a future change to either
 * `SubmitToJurisdictionDialog#onSubmitted` or the `EngagementDetail`
 * banner state could quietly break the reassurance reviewers rely on.
 * These tests pin three behaviors:
 *
 *   1. Submitting a package surfaces the banner with the recorded
 *      jurisdiction and a "just now" relative timestamp.
 *   2. Clicking Dismiss hides the banner but leaves the new submission
 *      row in the past-submissions list (cache invalidation must still
 *      run even when the banner is torn down).
 *   3. The banner auto-clears after the configured 8s timeout without
 *      removing the new submission row.
 *
 * We mock the generated React Query hooks the page consumes so the
 * test never touches the real network. `useGetEngagement` and
 * `useListEngagementSubmissions` are wired through real `useQuery`
 * instances pointed at hoisted state — that way the dialog's actual
 * `qc.invalidateQueries` call drives the list refetch without us
 * having to fake the cache layer. `useCreateEngagementSubmission`
 * captures its mutation options so we can fire `onSuccess` manually
 * with a deterministic receipt.
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
  waitFor,
  cleanup,
  act,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// ── Hoisted mock state ──────────────────────────────────────────────────
//
// Shared between the vi.mock factories below and the test bodies. We
// keep this in a single object so each `beforeEach` reset is one place
// to think about.
const hoisted = vi.hoisted(() => {
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
    capturedSubmitOptions: null as null | {
      mutation?: {
        onSuccess?: (
          data: unknown,
          variables: unknown,
          context: unknown,
        ) => Promise<void> | void;
        onError?: (
          err: unknown,
          variables: unknown,
          context: unknown,
        ) => void;
      };
    },
    submitMutate: vi.fn(),
    submitState: { isPending: false },
  };
});

// useParams comes from wouter inside the page; hard-pin it to the
// engagement id so we don't need a Router wrapper.
vi.mock("wouter", async () => {
  const actual = await vi.importActual<typeof import("wouter")>("wouter");
  return {
    ...actual,
    useParams: () => ({ id: hoisted.engagement.id }),
  };
});

// The 2 KB note ceiling — match the real generated constant so the
// dialog renders identically in the test environment.
vi.mock("@workspace/api-zod", () => ({
  createEngagementSubmissionBodyNoteMax: 2048,
}));

// Mock the generated React Query hooks the page (and dialog) consume.
//
// `useGetEngagement` and `useListEngagementSubmissions` are wired
// through real `useQuery` so the dialog's `invalidateQueries` call
// after a successful submit triggers a re-render against the latest
// hoisted submissions array — which is how the new row makes it into
// the past-submissions list during the dismiss test.
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
    getGetAtomHistoryQueryKey: (scope: string, id: string) => [
      "getAtomHistory",
      scope,
      id,
    ],
    getGetSessionQueryKey: () => ["getSession"],
    // Task #261 — the engagement page now embeds BriefingRecentRunsPanel,
    // which calls these two named exports. The panel fetches lazily
    // (only when its disclosure is opened), so the runs hook is wired
    // through `useQuery` with `enabled` honored — no fetch fires for
    // these submission-banner tests since nothing toggles the
    // disclosure.
    getListEngagementBriefingGenerationRunsQueryKey: (id: string) => [
      "listEngagementBriefingGenerationRuns",
      id,
    ],
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
        // Task #314 — the panel now also reads `priorNarrative` off
        // the same envelope; default the field to `null` so the
        // submission-banner tests render the same "no prior body"
        // shape they did before this task added the prior-diff
        // block.
        queryFn: async () => ({ runs: [], priorNarrative: null }),
        enabled: opts?.query?.enabled ?? true,
        refetchOnWindowFocus: opts?.query?.refetchOnWindowFocus ?? true,
      }),
    // Task #314 — BriefingRecentRunsPanel pulls the current narrative
    // so its prior-narrative block can diff each A–G section against
    // the live body on screen. The submission-banner tests never
    // open the disclosure, so a default "no briefing" payload is
    // enough; gating on `enabled` lets the panel honour its lazy
    // fetch contract.
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
        queryFn: async () => ({ briefing: null }),
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
    useCreateEngagementSubmission: (
      options: typeof hoisted.capturedSubmitOptions,
    ) => {
      hoisted.capturedSubmitOptions = options;
      return {
        mutate: hoisted.submitMutate,
        isPending: hoisted.submitState.isPending,
      };
    },
  };
});

const EngagementDetail = (await import("../EngagementDetail")).default;

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
  // Seed the React Query cache with the initial engagement, submissions
  // list, and session so the page renders fully on the first paint —
  // no async `findBy*` polling required, which keeps this test
  // compatible with `vi.useFakeTimers()` (testing-library's `waitFor`
  // uses real-time polling that hangs under faked timers).
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

beforeEach(() => {
  hoisted.engagement = {
    id: "eng-1",
    name: "Seguin Residence",
    jurisdiction: "Moab, UT",
    address: "123 Main St",
    site: null,
  };
  hoisted.submissions = [];
  hoisted.capturedSubmitOptions = null;
  hoisted.submitMutate.mockReset();
  hoisted.submitState.isPending = false;
});

afterEach(() => {
  cleanup();
});

/**
 * Drive the full happy-path: open the dialog, click confirm to record
 * a mutate, push a new submission row into the hoisted list, then
 * fire the captured `onSuccess` so the dialog runs its real
 * invalidate / onSubmitted / onClose chain. Returns the receipt the
 * banner should reflect so individual tests can assert against it.
 */
async function submitOnce(opts?: {
  receipt?: { submissionId: string; engagementId: string; submittedAt: string };
  newRow?: (typeof hoisted.submissions)[number];
}) {
  // The query cache is pre-seeded so the trigger is rendered and
  // enabled on the very first paint — no async polling required.
  const trigger = screen.getByTestId("submit-jurisdiction-trigger");
  expect(trigger).not.toBeDisabled();
  fireEvent.click(trigger);

  // The dialog is now mounted; click confirm to record the mutate
  // call (the mutate spy is a no-op so the promise never resolves on
  // its own — we manually fire onSuccess below).
  fireEvent.click(screen.getByTestId("submit-jurisdiction-confirm"));
  expect(hoisted.submitMutate).toHaveBeenCalledTimes(1);
  expect(hoisted.capturedSubmitOptions?.mutation?.onSuccess).toBeDefined();

  const submittedAtIso = new Date().toISOString();
  const receipt = opts?.receipt ?? {
    submissionId: "sub-new",
    engagementId: hoisted.engagement.id,
    submittedAt: submittedAtIso,
  };
  const row =
    opts?.newRow ?? {
      id: receipt.submissionId,
      submittedAt: receipt.submittedAt,
      jurisdiction: hoisted.engagement.jurisdiction,
      note: null,
      status: "pending" as const,
      reviewerComment: null,
      respondedAt: null,
    };
  // Push the new row first so the invalidateQueries refetch sees it.
  hoisted.submissions = [row, ...hoisted.submissions];
  await act(async () => {
    await hoisted.capturedSubmitOptions!.mutation!.onSuccess!(
      receipt,
      { id: hoisted.engagement.id, data: {} },
      undefined,
    );
  });
  return { receipt, row };
}

describe("EngagementDetail submission banner (Task #112)", () => {
  it("surfaces a 'just now' confirmation banner with the recorded jurisdiction after a successful submit", async () => {
    renderPage();
    await submitOnce();

    const banner = screen.getByTestId("submit-jurisdiction-success-banner");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveAttribute("role", "status");
    // Jurisdiction snapshot is captured at submit-time, so the banner
    // copy must read the engagement's current jurisdiction string.
    expect(within(banner).getByText("Moab, UT")).toBeInTheDocument();
    // The relative-time helper returns "just now" for any timestamp
    // within the last 5 seconds, which the new receipt always is.
    expect(within(banner).getByText("just now")).toBeInTheDocument();
    // The dialog itself should have closed on success.
    expect(
      screen.queryByTestId("submit-jurisdiction-dialog"),
    ).not.toBeInTheDocument();
  });

  it("hides the banner when Dismiss is clicked but keeps the new submission row in the list", async () => {
    renderPage();
    const { row } = await submitOnce();

    // Banner is visible to start; new row is in the past-submissions list.
    expect(
      screen.getByTestId("submit-jurisdiction-success-banner"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId(`submission-row-${row.id}`),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("submit-jurisdiction-success-dismiss"));

    // Banner is gone, but the row the cache invalidation surfaced
    // must remain — the two pieces of state are independent.
    expect(
      screen.queryByTestId("submit-jurisdiction-success-banner"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId(`submission-row-${row.id}`),
    ).toBeInTheDocument();
  });

  it("auto-clears the banner after the 8s timeout and leaves the submission row intact", async () => {
    // Fake only `setTimeout`/`clearTimeout` so we can fast-forward the
    // parent's auto-dismiss schedule without touching the timers
    // testing-library / react-query rely on internally (a full
    // `vi.useFakeTimers()` would hang their internal polling). The
    // page's `useEffect` calls `window.setTimeout` / `window.clearTimeout`
    // directly, so this targeted fake catches the auto-dismiss schedule
    // while leaving everything else on real time.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      renderPage();
      const { row } = await submitOnce();
      expect(
        screen.getByTestId("submit-jurisdiction-success-banner"),
      ).toBeInTheDocument();

      // Just before the threshold the banner is still up.
      act(() => {
        vi.advanceTimersByTime(7_999);
      });
      expect(
        screen.queryByTestId("submit-jurisdiction-success-banner"),
      ).toBeInTheDocument();

      // Crossing 8s tears the banner down…
      act(() => {
        vi.advanceTimersByTime(2);
      });
      expect(
        screen.queryByTestId("submit-jurisdiction-success-banner"),
      ).not.toBeInTheDocument();
      // …but the new submission row is still visible in the list.
      expect(
        screen.getByTestId(`submission-row-${row.id}`),
      ).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
