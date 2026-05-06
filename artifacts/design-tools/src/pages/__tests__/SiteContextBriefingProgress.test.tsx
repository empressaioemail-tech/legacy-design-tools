/**
 * SiteContextTab briefing-generation progress affordance (Task #451).
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
  cleanup,
  act,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  createMutationCapture,
  createQueryKeyStubs,
  makeCapturingMutationHook,
  makeEngagementPageMockHooks,
  noopMutationHook,
} from "@workspace/portal-ui/test-utils";

const hoisted = vi.hoisted(() => {
  return {
    engagement: {
      id: "eng-1",
      name: "Moab Pilot",
      jurisdiction: "Moab, UT",
      address: "100 Main St, Moab, UT",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      snapshotCount: 0,
      latestSnapshot: null,
      snapshots: [] as unknown[],
      site: {
        address: "100 Main St, Moab, UT",
        geocode: {
          latitude: 38.573,
          longitude: -109.5494,
          jurisdictionCity: "Moab",
          jurisdictionState: "UT",
          jurisdictionFips: "49019",
          source: "manual",
          geocodedAt: "2026-01-01T00:00:00.000Z",
        },
        projectType: null,
        zoningCode: null,
        lotAreaSqft: null,
      } as unknown,
      revitCentralGuid: null as string | null,
      revitDocumentPath: null as string | null,
    },
    // Mutable status response; tests flip this between renders and
    // invalidate the status query to drive transitions.
    status: null as null | {
      generationId: string | null;
      state: "idle" | "pending" | "completed" | "failed";
      startedAt: string | null;
      completedAt: string | null;
      error: string | null;
      invalidCitationCount: number | null;
      invalidCitations: string[] | null;
    },
    // Tracks how many times the briefing query was fetched so the
    // pending → completed test can prove the page invalidated it on
    // transition (rather than waiting for stale-time to lapse).
    briefingFetches: 0,
    // When set, the status queryFn awaits this promise before
    // returning — used by the initial-load test to keep the status
    // request in-flight (`isLoading: true`) and assert the idle
    // button does not flash before the first response lands.
    statusGate: null as Promise<void> | null,
  };
});

const generate = createMutationCapture();
const regenerateBriefing = createMutationCapture();

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

vi.mock("@workspace/site-context/client", async () => {
  const { extractBriefingSourceOverlays } = await import(
    "@workspace/site-context/client/overlays"
  );
  return {
    extractBriefingSourceOverlays,
    SiteMap: () => null,
  };
});

vi.mock("@workspace/api-client-react", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  return {
    ...(await makeEngagementPageMockHooks({
      engagement: () => hoisted.engagement,
    })),
    // AppShell stubs (not the surface under test).
    useListMyNotifications: () =>
      useQuery({
        queryKey: ["listMyNotifications"] as const,
        queryFn: async () => ({ items: [] }),
        enabled: false,
      }),
    getListMyNotificationsQueryKey: () => ["listMyNotifications"] as const,
    useMarkMyNotificationsRead: noopMutationHook,
    ...createQueryKeyStubs([
      "getGetEngagementBriefingQueryKey",
      "getListEngagementBriefingSourcesQueryKey",
      "getListBimModelDivergencesQueryKey",
      "getGetEngagementBriefingGenerationStatusQueryKey",
      "getGetBimModelRefreshQueryKey",
      "getGetEngagementBimModelQueryKey",
      "getListEngagementBriefingGenerationRunsQueryKey",
    ] as const),
    useGetEngagementBriefing: (
      id: string,
      opts?: { query?: { queryKey?: readonly unknown[] } },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ?? (["getEngagementBriefing", id] as const),
        queryFn: async () => {
          hoisted.briefingFetches += 1;
          return { briefing: null };
        },
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
        queryFn: async () => {
          if (hoisted.statusGate) await hoisted.statusGate;
          return hoisted.status;
        },
      }),
    useGenerateEngagementBriefing: makeCapturingMutationHook(regenerateBriefing),
    useListEngagementBriefingGenerationRuns: (
      id: string,
      opts?: { query?: { queryKey?: readonly unknown[]; enabled?: boolean } },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ??
          (["listEngagementBriefingGenerationRuns", id] as const),
        queryFn: async () => ({ runs: [] }),
        enabled: opts?.query?.enabled ?? true,
      }),
    useCreateEngagementBriefingSource: noopMutationHook,
    useRestoreEngagementBriefingSource: noopMutationHook,
    useRetryBriefingSourceConversion: noopMutationHook,
    useGenerateEngagementLayers: makeCapturingMutationHook(generate),
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
    usePushEngagementBimModel: noopMutationHook,
    useListBimModelDivergences: (
      id: string,
      opts?: { query?: { enabled?: boolean; queryKey?: readonly unknown[] } },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ?? (["listBimModelDivergences", id] as const),
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
  client.setQueryData(["getEngagement", hoisted.engagement.id], {
    ...hoisted.engagement,
  });
  client.setQueryData(["listEngagements"], [{ ...hoisted.engagement }]);
  client.setQueryData(["getSession"], { permissions: [] as string[] });
  window.history.replaceState(null, "", "/?tab=site-context");
  const node: ReactNode = (
    <QueryClientProvider client={client}>
      <EngagementDetail />
    </QueryClientProvider>
  );
  const utils = render(node);
  return { ...utils, client };
}

beforeEach(() => {
  hoisted.status = null;
  hoisted.briefingFetches = 0;
  hoisted.statusGate = null;
  generate.reset();
  regenerateBriefing.reset();
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("SiteContextTab briefing-generation progress (Task #451)", () => {
  it("shows the progress affordance and replaces the Generate Layers button while a job is pending", async () => {
    hoisted.status = {
      generationId: "gen-1",
      state: "pending",
      startedAt: "2026-05-01T00:00:00.000Z",
      completedAt: null,
      error: null,
      invalidCitationCount: null,
      invalidCitations: null,
    };

    renderPage();

    const progress = await screen.findByTestId("briefing-generation-progress");
    expect(progress).toHaveTextContent(/Site Context loading/i);
    expect(
      screen.getByTestId("briefing-generation-progress-spinner"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("generate-layers-button"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("briefing-generation-error"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("generate-layers-force-refresh-button"),
    ).toBeDisabled();
  });

  it("invalidates the briefing read and brings the Generate Layers button back when the job completes", async () => {
    hoisted.status = {
      generationId: "gen-1",
      state: "pending",
      startedAt: "2026-05-01T00:00:00.000Z",
      completedAt: null,
      error: null,
      invalidCitationCount: null,
      invalidCitations: null,
    };

    const { client } = renderPage();

    await screen.findByTestId("briefing-generation-progress");
    // The progress affordance also stands in for the brief
    // initial-load window (status === null && isLoading), so wait
    // for the status query to actually settle on `pending` before
    // flipping it — otherwise the polling effect never observes a
    // pending → completed transition and never invalidates the
    // briefing read.
    await waitFor(() => {
      const cached = client.getQueryData([
        "getEngagementBriefingGenerationStatus",
        "eng-1",
      ]) as { state?: string } | undefined;
      expect(cached?.state).toBe("pending");
    });
    const fetchesBefore = hoisted.briefingFetches;

    hoisted.status = {
      generationId: "gen-1",
      state: "completed",
      startedAt: "2026-05-01T00:00:00.000Z",
      completedAt: "2026-05-01T00:01:00.000Z",
      error: null,
      invalidCitationCount: 0,
      invalidCitations: [],
    };
    await act(async () => {
      await client.refetchQueries({
        queryKey: ["getEngagementBriefingGenerationStatus", "eng-1"],
      });
    });

    await waitFor(() => {
      expect(
        screen.queryByTestId("briefing-generation-progress"),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("generate-layers-button")).toBeVisible();
    // pending→completed must invalidate the briefing read. The
    // refetch is fire-and-forget from the polling effect, so wait
    // for the fetch counter to tick rather than racing against it.
    await waitFor(() => {
      expect(hoisted.briefingFetches).toBeGreaterThan(fetchesBefore);
    });
  });

  it("surfaces a retryable inline error when the briefing-generation job fails", async () => {
    hoisted.status = {
      generationId: "gen-1",
      state: "failed",
      startedAt: "2026-05-01T00:00:00.000Z",
      completedAt: "2026-05-01T00:01:00.000Z",
      error: "engine_unreachable",
      invalidCitationCount: null,
      invalidCitations: null,
    };

    renderPage();

    // SiteContextTab and BriefingNarrativePanel both render
    // briefing-generation-error; scope via the unique -message child.
    const errMessage = await screen.findByTestId(
      "briefing-generation-error-message",
    );
    expect(errMessage).toHaveTextContent(/engine_unreachable/);
    const errBanner = errMessage.closest(
      "[data-testid='briefing-generation-error']",
    );
    expect(errBanner).not.toBeNull();
    expect(errBanner).toHaveAttribute("role", "alert");
    const retry = screen.getByTestId("briefing-generation-error-retry");
    expect(retry).toBeEnabled();
    act(() => {
      retry.click();
    });
    // Retry must kick the briefing-generation job itself (not the
    // unrelated layers run) so the failed briefing actually re-runs.
    expect(regenerateBriefing.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "eng-1",
        data: expect.objectContaining({ regenerate: true }),
      }),
    );
    expect(generate.mutate).not.toHaveBeenCalled();
  });

  it("keeps the progress affordance live across failed → retry → pending → completed", async () => {
    hoisted.status = {
      generationId: "gen-1",
      state: "failed",
      startedAt: "2026-05-01T00:00:00.000Z",
      completedAt: "2026-05-01T00:01:00.000Z",
      error: "engine_unreachable",
      invalidCitationCount: null,
      invalidCitations: null,
    };

    const { client } = renderPage();

    const errMessage = await screen.findByTestId(
      "briefing-generation-error-message",
    );
    expect(errMessage).toBeInTheDocument();

    hoisted.status = {
      generationId: "gen-2",
      state: "pending",
      startedAt: "2026-05-01T00:02:00.000Z",
      completedAt: null,
      error: null,
      invalidCitationCount: null,
      invalidCitations: null,
    };
    await act(async () => {
      screen.getByTestId("briefing-generation-error-retry").click();
    });
    await act(async () => {
      await client.refetchQueries({
        queryKey: ["getEngagementBriefingGenerationStatus", "eng-1"],
      });
    });

    // Stale terminal value must not disarm the watcher.
    await waitFor(() => {
      expect(
        screen.getByTestId("briefing-generation-progress"),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId("briefing-generation-error"),
    ).not.toBeInTheDocument();

    hoisted.status = {
      generationId: "gen-2",
      state: "completed",
      startedAt: "2026-05-01T00:02:00.000Z",
      completedAt: "2026-05-01T00:03:00.000Z",
      error: null,
      invalidCitationCount: 0,
      invalidCitations: [],
    };
    await act(async () => {
      await client.refetchQueries({
        queryKey: ["getEngagementBriefingGenerationStatus", "eng-1"],
      });
    });

    await waitFor(() => {
      expect(
        screen.queryByTestId("briefing-generation-progress"),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("generate-layers-button")).toBeVisible();
  });

  it("suppresses the idle Generate Layers button while the first /briefing/status response is in flight", async () => {
    // Hold the status query in flight so isLoading stays true on first
    // paint. Without the suppression the idle CTA would flash before
    // the auto-triggered job's pending state lands.
    let release!: () => void;
    hoisted.statusGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    hoisted.status = {
      generationId: "gen-1",
      state: "pending",
      startedAt: "2026-05-01T00:00:00.000Z",
      completedAt: null,
      error: null,
      invalidCitationCount: null,
      invalidCitations: null,
    };

    renderPage();

    // Status request is still in flight — idle button must not appear.
    expect(
      screen.queryByTestId("generate-layers-button"),
    ).not.toBeInTheDocument();
    // Loading affordance stands in while the status is unknown.
    expect(
      screen.getByTestId("briefing-generation-progress"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("generate-layers-force-refresh-button"),
    ).toBeDisabled();

    // Let the status resolve to pending — affordance stays, idle CTA
    // still hidden.
    await act(async () => {
      release();
      await hoisted.statusGate;
    });
    await waitFor(() => {
      expect(
        screen.getByTestId("briefing-generation-progress"),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId("generate-layers-button"),
    ).not.toBeInTheDocument();
  });
});
