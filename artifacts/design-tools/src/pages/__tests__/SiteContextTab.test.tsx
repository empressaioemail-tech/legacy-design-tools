/**
 * SiteContextTab — regression coverage for the empty-pilot-jurisdiction
 * banner introduced by Task #177.
 *
 * The Generate Layers POST returns a structured `422
 * no_applicable_adapters` envelope when the engagement's resolved
 * jurisdiction has no configured adapters (anything outside the three
 * pilot jurisdictions Bastrop TX, Moab UT, Salmon ID). Previously the
 * Site Context tab surfaced that response through the same
 * `generate-layers-error` banner as a real upstream failure, so an
 * architect on a Boulder CO project saw the raw `no_applicable_adapters`
 * slug with no hint that the cause was "this jurisdiction is not in the
 * pilot yet". The fix branches on the slug and renders a
 * `generate-layers-no-adapters-banner` with a CTA that opens the
 * existing `BriefingSourceUploadModal`.
 *
 * These tests pin three behaviors the visual design depends on:
 *
 *   1. A 422 `no_applicable_adapters` ApiError swaps the generic alert
 *      for the empty-pilot banner, surfaces the server's human-readable
 *      `message`, and keeps the upload-CTA wired to the modal toggle.
 *   2. Clicking the CTA opens the upload modal (asserted by the modal's
 *      unique `briefing-source-layer-kind` select-control id), proving
 *      the dead-end is actionable instead of confusing.
 *   3. A non-422 ApiError still falls through to the original
 *      `generate-layers-error` alert path so an upstream timeout is not
 *      silently re-styled as an empty-pilot prompt.
 *
 * The setup mirrors `EngagementDetail.test.tsx` (Task #126): hoisted
 * mocks for the generated React-Query hooks the page consumes, with
 * `useGenerateEngagementLayers` capturing the mutation options so each
 * test can manually fire `onError` with a fake `ApiError` shape (the
 * route would otherwise need a real fetch round-trip we cannot drive
 * under happy-dom). The `@workspace/site-context/client` SiteMap is
 * stubbed because the page module imports it unconditionally even
 * though the Site tab is not activated here.
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
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// ── Hoisted mock state ──────────────────────────────────────────────────
//
// `capturedGenerateOptions` is the seam every test drives through:
// the SiteContextTab passes its `mutation: { onError, onSuccess }`
// options to `useGenerateEngagementLayers`, the mock captures them,
// and each test fires `onError` with a fake ApiError to trigger the
// banner branches. The two pre-resolved query keys mirror the real
// generated ones so `invalidateQueries` calls inside the page do not
// no-op against a different key.
const hoisted = vi.hoisted(() => {
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
    capturedGenerateOptions: null as null | {
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
    generateMutate: vi.fn(),
  };
});

// useParams is consumed by the page from wouter; pin it to the seeded
// engagement id so we don't need a Router wrapper.
vi.mock("wouter", async () => {
  const actual = await vi.importActual<typeof import("wouter")>("wouter");
  return {
    ...actual,
    useParams: () => ({ id: hoisted.engagement.id }),
  };
});

// Match the real generated constant the upload modal reads from so
// the form renders identically under happy-dom.
vi.mock("@workspace/api-zod", () => ({
  createEngagementSubmissionBodyNoteMax: 2048,
  recordSubmissionResponseBodyReviewerCommentMax: 2048,
}));

// Leaflet's CSS / image side-effects don't survive happy-dom; the
// page imports SiteMap unconditionally even though the Site tab is
// never activated here.
vi.mock("@workspace/site-context/client", () => ({
  SiteMap: () => null,
}));

// Stub every generated hook the page (and the SiteContextTab subtree)
// consumes. The two hooks that drive the test —
// `useGenerateEngagementLayers` and `useGetEngagementBriefing` — are
// wired explicitly: the former captures `mutation` options so each
// test can fire `onError` with a synthetic ApiError, the latter
// returns an empty briefing through real `useQuery` so the
// briefing-sources placeholder paints.
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
    // SiteContextTab — the briefing read backs the empty-state
    // placeholder and the tier-grouped source rows. An empty
    // briefing keeps the SiteContextTab in its "no sources yet"
    // shape so the only banners visible during these tests are the
    // ones the Generate Layers mutation drives.
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
        queryFn: async () => ({ status: "idle" }),
      }),
    useGenerateEngagementBriefing: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
    // The upload-modal subtree uses this hook even though no submit
    // happens during the test — without a stub the modal blows up
    // with "No 'useCreateEngagementBriefingSource' export defined" the
    // moment the CTA opens it.
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
    // The hook under test — capture the mutation options so each
    // test can synthesize an ApiError and fire `onError` directly,
    // bypassing the real fetch round-trip.
    useGenerateEngagementLayers: (
      options: typeof hoisted.capturedGenerateOptions,
    ) => {
      hoisted.capturedGenerateOptions = options;
      return {
        mutate: hoisted.generateMutate,
        isPending: false,
      };
    },
    // PushToRevitAffordance is mounted inside SiteContextTab and
    // pulls these three hooks on every render. None of them affect
    // the empty-pilot banner under test, so we hand back inert
    // shapes that keep the affordance in its idle "no bim model"
    // state instead of asserting against it.
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

/**
 * Build the minimum-viable shape `SiteContextTab#onError` reads from.
 * The page never calls `instanceof ApiError`; it only reaches into
 * `.data.error` (the slug) and `.data.message` (the human-readable
 * copy) on the thrown error, falling back to `.message` on the Error
 * itself. Constructing a plain Error here keeps the test agnostic to
 * the real `ApiError` constructor signature (which takes a Response,
 * not a status int) so the unit test does not have to fabricate a
 * fetch Response under happy-dom just to drive the error branches.
 */
function makeApiErrorLike(
  status: number,
  data: { error: string; message: string },
): Error & { status: number; data: { error: string; message: string } } {
  const err = new Error(data.message) as Error & {
    status: number;
    data: { error: string; message: string };
  };
  err.status = status;
  err.data = data;
  return err;
}

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
  // fully rendered before we drive the Site Context tab.
  client.setQueryData(["getEngagement", hoisted.engagement.id], {
    ...hoisted.engagement,
  });
  client.setQueryData(["listEngagements"], [{ ...hoisted.engagement }]);
  client.setQueryData(["getSession"], { permissions: [] as string[] });
  // The page reads the active tab from `?tab=…` once on mount, so
  // landing directly on the Site Context tab keeps these tests focused
  // on the SiteContextTab subtree.
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
  hoisted.capturedGenerateOptions = null;
  hoisted.generateMutate.mockReset();
});

afterEach(() => {
  cleanup();
  // Restore the URL so a leftover `?tab=site-context` from one test
  // does not bleed into subsequent describe blocks.
  window.history.replaceState(null, "", "/");
});

describe("SiteContextTab Generate Layers fallback (Task #177)", () => {
  it("renders the empty-pilot-jurisdiction banner when the server returns 422 no_applicable_adapters", async () => {
    renderPage();

    // The Generate Layers button is only mounted on the Site Context
    // tab; if it isn't visible the page didn't honor the `?tab=` deep
    // link and the rest of the assertions would be confusingly false.
    expect(screen.getByTestId("generate-layers-button")).toBeVisible();

    // Sanity: nothing has fired yet, both banners are absent.
    expect(
      screen.queryByTestId("generate-layers-no-adapters-banner"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("generate-layers-error"),
    ).not.toBeInTheDocument();

    // Drive the failure path through the captured mutation options.
    // Mirroring the real `customFetch` shape: an ApiError carrying the
    // `{ error, message }` envelope on `.data`, with a status of 422.
    expect(hoisted.capturedGenerateOptions?.mutation?.onError).toBeDefined();
    const serverMessage =
      'No adapters configured for jurisdiction "CO" / "Boulder".';
    act(() => {
      hoisted.capturedGenerateOptions!.mutation!.onError!(
        makeApiErrorLike(422, {
          error: "no_applicable_adapters",
          message: serverMessage,
        }),
        { id: hoisted.engagement.id },
        undefined,
      );
    });

    // The empty-pilot banner replaces the generic alert.
    const banner = screen.getByTestId("generate-layers-no-adapters-banner");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveAttribute("role", "status");
    expect(
      screen.getByTestId("generate-layers-no-adapters-message"),
    ).toHaveTextContent(serverMessage);
    // Headline + manual-upload guidance copy must be present so the
    // architect can act on the banner without reading the details.
    expect(
      screen.getByText(/No adapters configured for this jurisdiction yet/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Upload a QGIS overlay below to seed the briefing manually\./i,
      ),
    ).toBeInTheDocument();
    // The generic error alert must NOT also be rendered — a future
    // regression that left both banners up would double-clutter the
    // tab.
    expect(
      screen.queryByTestId("generate-layers-error"),
    ).not.toBeInTheDocument();
  });

  it("opens the BriefingSourceUploadModal when the banner CTA is clicked", () => {
    renderPage();

    // The upload modal has no top-level testid, but the layer-kind
    // select control is uniquely owned by the modal — its absence
    // before the CTA click and presence after is the cleanest proof
    // that the modal mounted.
    expect(
      document.getElementById("briefing-source-layer-kind"),
    ).toBeNull();

    act(() => {
      hoisted.capturedGenerateOptions!.mutation!.onError!(
        makeApiErrorLike(422, {
          error: "no_applicable_adapters",
          message:
            "Could not resolve a pilot jurisdiction from this engagement's site context.",
        }),
        { id: hoisted.engagement.id },
        undefined,
      );
    });

    const cta = screen.getByTestId("generate-layers-no-adapters-upload");
    fireEvent.click(cta);

    // Modal is now mounted — the layer-kind select is its anchor.
    expect(
      document.getElementById("briefing-source-layer-kind"),
    ).not.toBeNull();
  });

  it("does not pick the empty-pilot banner when the slug appears at a non-422 status", () => {
    // Defense-in-depth check: the route's contract pairs the
    // `no_applicable_adapters` slug with a 422 specifically. A
    // hypothetical future failure that happens to wrap the same
    // slug at a different status (e.g. a 500 with the same string
    // surfaced from an inner exception path) must not accidentally
    // re-style as the actionable empty-pilot prompt — that would
    // hide a real outage behind upload CTAs. The render branch
    // requires both keys to match, so this case must land on the
    // generic alert instead.
    renderPage();

    act(() => {
      hoisted.capturedGenerateOptions!.mutation!.onError!(
        makeApiErrorLike(500, {
          error: "no_applicable_adapters",
          message: "Internal failure that happened to share the slug",
        }),
        { id: hoisted.engagement.id },
        undefined,
      );
    });

    expect(
      screen.queryByTestId("generate-layers-no-adapters-banner"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("generate-layers-error")).toHaveTextContent(
      "Internal failure that happened to share the slug",
    );
  });

  it("falls through to the generic generate-layers-error alert for non-422 failures", () => {
    renderPage();

    // A 500 with an `internal_error` envelope is the canonical
    // "upstream actually failed" shape; it must keep landing in the
    // existing alert banner so an architect can tell a real outage
    // apart from an out-of-pilot dead-end.
    act(() => {
      hoisted.capturedGenerateOptions!.mutation!.onError!(
        makeApiErrorLike(500, {
          error: "internal_error",
          message: "Failed to run adapters",
        }),
        { id: hoisted.engagement.id },
        undefined,
      );
    });

    const alert = screen.getByTestId("generate-layers-error");
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent("Failed to run adapters");
    expect(
      screen.queryByTestId("generate-layers-no-adapters-banner"),
    ).not.toBeInTheDocument();
  });
});
