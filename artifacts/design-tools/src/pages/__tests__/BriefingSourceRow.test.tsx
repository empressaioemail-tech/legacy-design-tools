/**
 * BriefingSourceRow + BriefingSourceHistoryPanel — Task #178 coverage.
 *
 * Pins the per-layer Generate Layers history surface introduced in
 * DA-PI-4: adapter-driven briefing source rows must render the
 * "Last refreshed N … by Generate Layers" attribution line and the
 * lazy history panel must render adapter-driven prior versions
 * correctly (their per-layer key + provider, the source-kind badge,
 * and the same Generate Layers actor stamp on the meta line).
 *
 * The component file (`pages/EngagementDetail.tsx`) is large and the
 * `BriefingSourceRow` / `BriefingSourceHistoryPanel` exports were
 * widened by this task so we can mount them in isolation rather than
 * driving the entire engagement page through the upload + tab switch.
 *
 * Mock surface mirrors `BriefingSourceUploadModal.test.tsx`:
 *   - mock the generated React Query hooks the row + panel consume
 *     (`useRetryBriefingSourceConversion`,
 *     `useListEngagementBriefingSources`,
 *     `useRestoreEngagementBriefingSource`) so we can return our
 *     fixture history without spinning a real fetch
 *   - keep a real QueryClient so the panel's `useMemo` filter and the
 *     row's `expanded` state run as production would
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
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const hoisted = vi.hoisted(() => ({
  // Drives `useListEngagementBriefingSources` for the history panel.
  // Each test seeds this before render so the panel's first render
  // already reflects the desired history state — no async waitFor is
  // required. Typed as `unknown[]` so the fixture builder can shove
  // its strongly-typed objects in without an index-signature widen.
  historySources: [] as unknown[],
  historyState: {
    isLoading: false,
    isError: false,
  },
}));

// Stub the SiteMap so leaflet's CSS + image asset side-effects don't
// have to load under happy-dom (matches the EngagementDetail test).
// The map is never mounted by these tests, but the page module
// `EngagementDetail.tsx` imports the symbol unconditionally, so a
// non-stubbed import of the source file would fail to transform.
vi.mock("@workspace/site-context/client", () => ({
  SiteMap: () => null,
}));

// Mock the generated React Query hooks the row + panel consume.
// `EngagementDetail.tsx` also imports a handful of unrelated hooks /
// query-key helpers / wire types from this same module — none of
// them are exercised by the tests here, but they must still resolve
// to *something* or the source file fails to load. We stub them as
// no-ops below.
vi.mock("@workspace/api-client-react", async () => {
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
  const noopHook = () => ({
    data: undefined as unknown,
    isLoading: false,
    isError: false,
    error: null,
  });
  const noopMutation = () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    variables: undefined,
  });
  return {
    ApiError: MockApiError,
    RecordSubmissionResponseBodyStatus: {
      approved: "approved",
      corrections_requested: "corrections_requested",
      rejected: "rejected",
    },
    // Hooks the row + panel actually consume.
    useRetryBriefingSourceConversion: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
    useListEngagementBriefingSources: () => ({
      data: { sources: hoisted.historySources },
      isLoading: hoisted.historyState.isLoading,
      isError: hoisted.historyState.isError,
    }),
    useRestoreEngagementBriefingSource: () => ({
      mutate: vi.fn(),
      isPending: false,
      isError: false,
      variables: undefined,
    }),
    // Query-key helpers used in invalidate calls.
    getGetEngagementBriefingQueryKey: (id: string) => [
      "getEngagementBriefing",
      id,
    ],
    getListEngagementBriefingSourcesQueryKey: (
      id: string,
      params: unknown,
    ) => ["listEngagementBriefingSources", id, params],
    // Everything below is pulled in by the page module's import list
    // but never called along the BriefingSourceRow code paths these
    // tests exercise. No-op stubs keep the import resolution happy.
    useGenerateEngagementLayers: noopMutation,
    useGenerateEngagementBriefing: noopMutation,
    useGetEngagement: noopHook,
    useGetEngagementBriefing: noopHook,
    useGetEngagementBriefingGenerationStatus: noopHook,
    useGetSnapshot: noopHook,
    useListEngagementSubmissions: noopHook,
    useListEngagements: noopHook,
    useUpdateEngagement: noopMutation,
    useGetSession: noopHook,
    useGetAtomHistory: noopHook,
    useGetAtomSummary: noopHook,
    useRecordSubmissionResponse: noopMutation,
    useCreateEngagementSubmission: noopMutation,
    useCreateEngagementBriefingSource: noopMutation,
    getGetEngagementBriefingGenerationStatusQueryKey: (id: string) => [
      "getEngagementBriefingGenerationStatus",
      id,
    ],
    getGetEngagementQueryKey: (id: string) => ["getEngagement", id],
    getGetSnapshotQueryKey: (id: string) => ["getSnapshot", id],
    getListEngagementsQueryKey: () => ["listEngagements"],
    getListEngagementSubmissionsQueryKey: (id: string) => [
      "listEngagementSubmissions",
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
  };
});

const {
  BriefingSourceRow,
  BriefingSourceHistoryPanel,
  BRIEFING_GENERATE_LAYERS_ACTOR_LABEL,
} = await import("../EngagementDetail");

interface BriefingSourceFixture {
  id: string;
  layerKind: string;
  sourceKind:
    | "manual-upload"
    | "federal-adapter"
    | "state-adapter"
    | "local-adapter";
  provider: string | null;
  snapshotDate: string;
  note: string | null;
  uploadObjectPath: string | null;
  uploadOriginalFilename: string | null;
  uploadContentType: string | null;
  uploadByteSize: number | null;
  dxfObjectPath: string | null;
  glbObjectPath: string | null;
  conversionStatus: null | "pending" | "converting" | "ready" | "failed" | "dxf-only";
  conversionError: string | null;
  createdAt: string;
  supersededAt: string | null;
  supersededById: string | null;
}

function mkSource(
  over: Partial<BriefingSourceFixture> &
    Pick<BriefingSourceFixture, "id" | "layerKind">,
): BriefingSourceFixture {
  return {
    id: over.id,
    layerKind: over.layerKind,
    sourceKind: over.sourceKind ?? "manual-upload",
    provider: over.provider ?? null,
    snapshotDate: over.snapshotDate ?? "2026-01-01T12:00:00.000Z",
    note: over.note ?? null,
    uploadObjectPath: over.uploadObjectPath ?? null,
    uploadOriginalFilename: over.uploadOriginalFilename ?? null,
    uploadContentType: over.uploadContentType ?? null,
    uploadByteSize: over.uploadByteSize ?? null,
    dxfObjectPath: over.dxfObjectPath ?? null,
    glbObjectPath: over.glbObjectPath ?? null,
    conversionStatus: over.conversionStatus ?? null,
    conversionError: over.conversionError ?? null,
    createdAt: over.createdAt ?? new Date().toISOString(),
    supersededAt: over.supersededAt ?? null,
    supersededById: over.supersededById ?? null,
  };
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderRow(source: BriefingSourceFixture, engagementId = "eng-1") {
  const client = makeQueryClient();
  const node: ReactNode = (
    <QueryClientProvider client={client}>
      <BriefingSourceRow engagementId={engagementId} source={source as never} />
    </QueryClientProvider>
  );
  return { ...render(node), client };
}

function renderPanel(opts: {
  engagementId?: string;
  layerKind?: string;
  currentSourceId?: string;
}) {
  const client = makeQueryClient();
  const node: ReactNode = (
    <QueryClientProvider client={client}>
      <BriefingSourceHistoryPanel
        engagementId={opts.engagementId ?? "eng-1"}
        layerKind={opts.layerKind ?? "fema-flood"}
        currentSourceId={opts.currentSourceId ?? "src-current"}
        panelId="briefing-source-history-src-current"
      />
    </QueryClientProvider>
  );
  return { ...render(node), client };
}

beforeEach(() => {
  hoisted.historySources = [];
  hoisted.historyState.isLoading = false;
  hoisted.historyState.isError = false;
});

afterEach(() => {
  cleanup();
});

describe("BriefingSourceRow — Generate Layers attribution (Task #178)", () => {
  it("stamps a 'Last refreshed N … by Generate Layers' line under each adapter-driven row", () => {
    const source = mkSource({
      id: "src-fed-1",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
      provider: "fema:fema-flood (FEMA NFHL)",
      // 2 minutes ago — `relativeTime` will read this as "2 min ago".
      createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    });
    renderRow(source);

    const stamp = screen.getByTestId(
      `briefing-source-last-refreshed-${source.id}`,
    );
    expect(stamp).toBeInTheDocument();
    expect(stamp.textContent).toMatch(/Last refreshed/);
    expect(stamp.textContent).toContain(BRIEFING_GENERATE_LAYERS_ACTOR_LABEL);
    // Sanity: the badge says the right tier label, not the previous
    // hard-coded "Federal adapter" fallback.
    const badge = screen.getByTestId(`briefing-source-kind-badge-${source.id}`);
    expect(badge.textContent).toBe("Federal adapter");
  });

  it("renders a tier-specific badge for state and local adapter rows", () => {
    const stateSrc = mkSource({
      id: "src-state-1",
      layerKind: "ut-zoning",
      sourceKind: "state-adapter",
      createdAt: new Date(Date.now() - 60 * 1000).toISOString(),
    });
    renderRow(stateSrc);
    expect(
      screen.getByTestId(`briefing-source-kind-badge-${stateSrc.id}`).textContent,
    ).toBe("State adapter");
    cleanup();

    const localSrc = mkSource({
      id: "src-local-1",
      layerKind: "boulder-parcels",
      sourceKind: "local-adapter",
      createdAt: new Date(Date.now() - 60 * 1000).toISOString(),
    });
    renderRow(localSrc);
    expect(
      screen.getByTestId(`briefing-source-kind-badge-${localSrc.id}`).textContent,
    ).toBe("Local adapter");
  });

  it("does NOT render the Generate Layers attribution line for manual-upload rows", () => {
    const manual = mkSource({
      id: "src-manual-1",
      layerKind: "qgis-overlay",
      sourceKind: "manual-upload",
      uploadOriginalFilename: "boulder-parcels.dxf",
      uploadByteSize: 12_345,
    });
    renderRow(manual);
    expect(
      screen.queryByTestId(`briefing-source-last-refreshed-${manual.id}`),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId(`briefing-source-kind-badge-${manual.id}`).textContent,
    ).toBe("Manual upload");
  });
});

describe("BriefingSourceHistoryPanel — adapter-driven history rows (Task #178)", () => {
  it("renders adapter-driven prior versions with the layerKind, source-kind badge, and 'by Generate Layers' actor stamp", () => {
    const current = mkSource({
      id: "src-current",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
    });
    const prior = mkSource({
      id: "src-prior",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
      provider: "fema:fema-flood (FEMA NFHL)",
      createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      supersededAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    });
    // The panel filters out the row whose id matches `currentSourceId`,
    // so the fixture must include both the current row (so the filter
    // has something to drop) and the prior row we expect to render.
    hoisted.historySources = [current, prior];

    renderPanel({
      currentSourceId: current.id,
      layerKind: current.layerKind,
    });

    const row = screen.getByTestId(`briefing-source-history-row-${prior.id}`);
    expect(row).toBeInTheDocument();
    // The current row's id must be filtered out of the prior list.
    expect(
      screen.queryByTestId(`briefing-source-history-row-${current.id}`),
    ).not.toBeInTheDocument();

    // Adapter rows have no upload filename — the headline must use
    // the per-layer key instead of the prior "(no filename)" string.
    expect(within(row).getByText(prior.layerKind)).toBeInTheDocument();
    expect(within(row).queryByText(/no filename/)).not.toBeInTheDocument();

    // Source-kind badge reads the new tier-specific label.
    expect(
      screen.getByTestId(`briefing-source-history-row-kind-${prior.id}`)
        .textContent,
    ).toBe("Federal adapter");

    // Provider is surfaced so the auditor can tell which adapter run
    // produced this row.
    expect(within(row).getByText(/Provider:/)).toBeInTheDocument();
    expect(within(row).getByText(/FEMA NFHL/)).toBeInTheDocument();

    // Meta line stamps the actor and the supersession marker.
    const meta = screen.getByTestId(
      `briefing-source-history-row-meta-${prior.id}`,
    );
    expect(meta.textContent).toMatch(/superseded/);
    expect(meta.textContent).toContain(BRIEFING_GENERATE_LAYERS_ACTOR_LABEL);
  });

  it("does NOT stamp the Generate Layers actor on manual-upload prior rows", () => {
    const current = mkSource({
      id: "src-current",
      layerKind: "qgis-overlay",
      sourceKind: "manual-upload",
    });
    const prior = mkSource({
      id: "src-prior-manual",
      layerKind: "qgis-overlay",
      sourceKind: "manual-upload",
      uploadOriginalFilename: "boulder-parcels-old.dxf",
      uploadByteSize: 9_999,
      createdAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
      supersededAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    });
    hoisted.historySources = [current, prior];

    renderPanel({
      currentSourceId: current.id,
      layerKind: current.layerKind,
    });

    const row = screen.getByTestId(`briefing-source-history-row-${prior.id}`);
    // Manual rows still show the upload filename in the headline.
    expect(
      within(row).getByText(/boulder-parcels-old\.dxf/),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId(`briefing-source-history-row-kind-${prior.id}`)
        .textContent,
    ).toBe("Manual upload");
    const meta = screen.getByTestId(
      `briefing-source-history-row-meta-${prior.id}`,
    );
    expect(meta.textContent).not.toContain(BRIEFING_GENERATE_LAYERS_ACTOR_LABEL);
  });

  it("opens via the row's history toggle and renders the empty state when there are no prior versions", () => {
    const current = mkSource({
      id: "src-only",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
      createdAt: new Date(Date.now() - 30 * 1000).toISOString(),
    });
    // Only the current row is in history — the panel filters it out
    // and falls back to the "No prior versions of this layer." copy.
    hoisted.historySources = [current];

    renderRow(current);

    fireEvent.click(
      screen.getByTestId(`briefing-source-history-toggle-${current.id}`),
    );

    const panel = screen.getByTestId(`briefing-source-history-${current.id}`);
    expect(panel).toBeInTheDocument();
    expect(
      within(panel).getByText(/No prior versions of this layer\./),
    ).toBeInTheDocument();
  });
});
