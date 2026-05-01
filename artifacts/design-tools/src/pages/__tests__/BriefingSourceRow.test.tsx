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
  BRIEFING_SOURCE_HISTORY_TIER_STORAGE_PREFIX,
  briefingSourceHistoryTierStorageKey,
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
  // Structured producer payload — adapter rows write the raw
  // `AdapterResult.payload` (a `{ kind, ... }` blob whose shape
  // depends on the adapter), manual-upload rows default to `{}`.
  // Tests that exercise the federal-payload diff (Task #211) seed
  // this with a `flood-zone` / `elevation-point` / etc. shape.
  payload: Record<string, unknown>;
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
    payload: over.payload ?? {},
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
  // Each test starts with a clean persistence layer so a value
  // written by one spec can't leak into the next via the shared
  // happy-dom `localStorage`.
  try {
    for (let i = window.localStorage.length - 1; i >= 0; i -= 1) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(BRIEFING_SOURCE_HISTORY_TIER_STORAGE_PREFIX)) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    /* ignore */
  }
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

  it("renders a 'cached <n>h ago' pill when the parent passes cacheInfo.fromCache=true (Task #204)", () => {
    const source = mkSource({
      id: "src-fed-cached",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
      provider: "fema:fema-flood (FEMA NFHL)",
    });
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const client = makeQueryClient();
    render(
      <QueryClientProvider client={client}>
        <BriefingSourceRow
          engagementId="eng-1"
          source={source as never}
          cacheInfo={{ fromCache: true, cachedAt: sixHoursAgo }}
        />
      </QueryClientProvider>,
    );

    const pill = screen.getByTestId(
      `briefing-source-cache-pill-${source.id}`,
    );
    expect(pill).toBeInTheDocument();
    // Six hours ago should render as exactly "cached 6h ago" — pins
    // the formatter against silent regressions in unit selection.
    expect(pill.textContent).toBe("cached 6h ago");
    // The full ISO timestamp must be in the tooltip so an architect
    // can hover for the precise capture time.
    expect(pill.getAttribute("title")).toContain(
      new Date(sixHoursAgo).toLocaleString(),
    );
  });

  it("renders 'cached just now' for sub-minute cachedAt (Task #204)", () => {
    const source = mkSource({
      id: "src-fed-fresh-cache",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
    });
    const justNow = new Date(Date.now() - 10 * 1000).toISOString();
    const client = makeQueryClient();
    render(
      <QueryClientProvider client={client}>
        <BriefingSourceRow
          engagementId="eng-1"
          source={source as never}
          cacheInfo={{ fromCache: true, cachedAt: justNow }}
        />
      </QueryClientProvider>,
    );
    expect(
      screen.getByTestId(`briefing-source-cache-pill-${source.id}`).textContent,
    ).toBe("cached just now");
  });

  it("does NOT render the cache pill when cacheInfo is null or fromCache=false (Task #204)", () => {
    const source = mkSource({
      id: "src-fed-live",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
    });
    // No cacheInfo prop → no pill.
    const { rerender, client } = renderRow(source);
    expect(
      screen.queryByTestId(`briefing-source-cache-pill-${source.id}`),
    ).not.toBeInTheDocument();

    // Explicit cacheInfo with fromCache=false → still no pill, even
    // if a cachedAt happens to be present (defensive: the runner
    // should not send this combo, but we don't want a stray pill).
    rerender(
      <QueryClientProvider client={client}>
        <BriefingSourceRow
          engagementId="eng-1"
          source={source as never}
          cacheInfo={{
            fromCache: false,
            cachedAt: new Date().toISOString(),
          }}
        />
      </QueryClientProvider>,
    );
    expect(
      screen.queryByTestId(`briefing-source-cache-pill-${source.id}`),
    ).not.toBeInTheDocument();
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

  it("filters the prior-version list to a single tier and adjusts the empty-state copy when the filter matches nothing (Task #184)", () => {
    const current = mkSource({
      id: "src-current",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
    });
    const priorAdapter = mkSource({
      id: "src-prior-adapter",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
      provider: "fema:fema-flood (FEMA NFHL)",
      createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      supersededAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    });
    const priorManual = mkSource({
      id: "src-prior-manual",
      layerKind: "fema-flood",
      sourceKind: "manual-upload",
      uploadOriginalFilename: "manual-override.dxf",
      uploadByteSize: 4_321,
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      supersededAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });
    hoisted.historySources = [current, priorAdapter, priorManual];

    renderPanel({
      currentSourceId: current.id,
      layerKind: current.layerKind,
    });

    // Default "all" tier shows both prior rows.
    expect(
      screen.getByTestId(`briefing-source-history-row-${priorAdapter.id}`),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId(`briefing-source-history-row-${priorManual.id}`),
    ).toBeInTheDocument();

    // Switch to Generate Layers — only adapter rows remain.
    fireEvent.click(
      screen.getByTestId(
        `briefing-source-history-filter-adapter-${current.id}`,
      ),
    );
    expect(
      screen.getByTestId(`briefing-source-history-row-${priorAdapter.id}`),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId(`briefing-source-history-row-${priorManual.id}`),
    ).not.toBeInTheDocument();

    // Switch to Manual uploads — only manual rows remain.
    fireEvent.click(
      screen.getByTestId(
        `briefing-source-history-filter-manual-${current.id}`,
      ),
    );
    expect(
      screen.queryByTestId(`briefing-source-history-row-${priorAdapter.id}`),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId(`briefing-source-history-row-${priorManual.id}`),
    ).toBeInTheDocument();

    // With only manual + adapter prior rows in the fixture above,
    // dropping the manual row from history and re-filtering to manual
    // surfaces the tier-specific empty-state copy so a filtered-empty
    // result isn't confused with a layer that has never been re-run.
    hoisted.historySources = [current, priorAdapter];
    cleanup();
    renderPanel({
      currentSourceId: current.id,
      layerKind: current.layerKind,
    });
    fireEvent.click(
      screen.getByTestId(
        `briefing-source-history-filter-manual-${current.id}`,
      ),
    );
    expect(
      screen.getByText(/No prior manual uploads of this layer\./),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/No prior versions of this layer\./),
    ).not.toBeInTheDocument();
  });

  it("renders a 'Changed: …' hint on an adapter prior row whose snapshotDate differs from the current row (Task #185)", () => {
    // Two adapter rows of the same layer, different snapshot dates —
    // the rerun moved the snapshot forward but kept provider/note/
    // sourceKind. The hint should call out exactly which field moved.
    const current = mkSource({
      id: "src-current",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
      provider: "fema:fema-flood (FEMA NFHL)",
      note: "Auto-fetched by Generate Layers.",
      snapshotDate: "2026-04-15T00:00:00.000Z",
    });
    const prior = mkSource({
      id: "src-prior-snap",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
      provider: "fema:fema-flood (FEMA NFHL)",
      note: "Auto-fetched by Generate Layers.",
      snapshotDate: "2026-01-01T00:00:00.000Z",
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      supersededAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    });
    hoisted.historySources = [current, prior];

    renderPanel({
      currentSourceId: current.id,
      layerKind: current.layerKind,
    });

    const hint = screen.getByTestId(
      `briefing-source-history-row-changed-${prior.id}`,
    );
    // The hint button carries a chevron affordance (Task #200) so we
    // anchor on the meaningful copy rather than the leading glyph.
    expect(hint.textContent).toMatch(/Changed:\s*snapshotDate\s*$/);
    // Sanity: nothing else moved, so other field names must not leak
    // into the hint.
    expect(hint.textContent).not.toMatch(/provider/);
    expect(hint.textContent).not.toMatch(/note/);
    expect(hint.textContent).not.toMatch(/sourceKind/);
  });

  it("reveals the prior + current values for snapshotDate when the 'Changed: …' hint is clicked (Task #200)", () => {
    // Same fixture shape as the snapshotDate diff test above — the
    // rerun moved snapshotDate forward but kept everything else
    // intact, so the reveal must surface the before → after pair
    // for snapshotDate (and only snapshotDate).
    const current = mkSource({
      id: "src-current",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
      provider: "fema:fema-flood (FEMA NFHL)",
      note: "Auto-fetched by Generate Layers.",
      snapshotDate: "2026-04-15T00:00:00.000Z",
    });
    const prior = mkSource({
      id: "src-prior-snap",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
      provider: "fema:fema-flood (FEMA NFHL)",
      note: "Auto-fetched by Generate Layers.",
      snapshotDate: "2026-01-01T00:00:00.000Z",
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      supersededAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    });
    hoisted.historySources = [current, prior];

    renderPanel({
      currentSourceId: current.id,
      layerKind: current.layerKind,
    });

    // Reveal is collapsed by default — the table is not in the DOM
    // until the hint is clicked, so an architect with many prior
    // rows isn't drowned in expanded diffs.
    expect(
      screen.queryByTestId(
        `briefing-source-history-row-changed-detail-${prior.id}`,
      ),
    ).not.toBeInTheDocument();

    const hint = screen.getByTestId(
      `briefing-source-history-row-changed-${prior.id}`,
    );
    expect(hint).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(hint);

    expect(hint).toHaveAttribute("aria-expanded", "true");

    // The reveal lists the prior + current values for snapshotDate,
    // sliced to YYYY-MM-DD so the assertion stays locale-stable.
    const before = screen.getByTestId(
      `briefing-source-history-row-changed-before-snapshotDate-${prior.id}`,
    );
    const after = screen.getByTestId(
      `briefing-source-history-row-changed-after-snapshotDate-${prior.id}`,
    );
    expect(before.textContent).toBe("2026-01-01");
    expect(after.textContent).toBe("2026-04-15");

    // Only snapshotDate moved, so no other field rows should appear
    // in the reveal.
    expect(
      screen.queryByTestId(
        `briefing-source-history-row-changed-before-provider-${prior.id}`,
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(
        `briefing-source-history-row-changed-before-note-${prior.id}`,
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(
        `briefing-source-history-row-changed-before-sourceKind-${prior.id}`,
      ),
    ).not.toBeInTheDocument();

    // Clicking the hint again collapses the reveal — state is local
    // to the panel so no extra fetch is made.
    fireEvent.click(hint);
    expect(hint).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByTestId(
        `briefing-source-history-row-changed-detail-${prior.id}`,
      ),
    ).not.toBeInTheDocument();
  });

  it("does NOT render the 'Changed: …' hint when an adapter prior row is byte-identical to the current row (Task #185)", () => {
    // Same provider, snapshotDate, note, sourceKind — only the row
    // id and createdAt differ (which the diff intentionally ignores).
    // The hint must not render so the architect isn't told something
    // moved when nothing meaningful did.
    const current = mkSource({
      id: "src-current",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
      provider: "fema:fema-flood (FEMA NFHL)",
      note: "Auto-fetched by Generate Layers.",
      snapshotDate: "2026-04-15T00:00:00.000Z",
    });
    const prior = mkSource({
      id: "src-prior-identical",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
      provider: "fema:fema-flood (FEMA NFHL)",
      note: "Auto-fetched by Generate Layers.",
      snapshotDate: "2026-04-15T00:00:00.000Z",
      createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      supersededAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    });
    hoisted.historySources = [current, prior];

    renderPanel({
      currentSourceId: current.id,
      layerKind: current.layerKind,
    });

    // Sanity: the prior row is rendered (so the assertion below isn't
    // vacuously true because the panel skipped this row entirely).
    expect(
      screen.getByTestId(`briefing-source-history-row-${prior.id}`),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId(`briefing-source-history-row-changed-${prior.id}`),
    ).not.toBeInTheDocument();
  });

  it("stamps a per-tier count next to each filter pill so the architect can prioritise which slice to open (Task #195)", () => {
    // Mixed history: 2 adapter prior rows + 1 manual prior row, plus
    // the current row (which the panel filters out and which must
    // therefore not be reflected in any of the three counts).
    const current = mkSource({
      id: "src-current",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
    });
    const priorAdapter1 = mkSource({
      id: "src-prior-adapter-1",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
      provider: "fema:fema-flood (FEMA NFHL)",
      createdAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      supersededAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    });
    const priorAdapter2 = mkSource({
      id: "src-prior-adapter-2",
      layerKind: "fema-flood",
      sourceKind: "state-adapter",
      provider: "ut:fema-flood",
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      supersededAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    const priorManual = mkSource({
      id: "src-prior-manual",
      layerKind: "fema-flood",
      sourceKind: "manual-upload",
      uploadOriginalFilename: "manual-override.dxf",
      uploadByteSize: 4_321,
      createdAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
      supersededAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    });
    hoisted.historySources = [
      current,
      priorAdapter1,
      priorAdapter2,
      priorManual,
    ];

    renderPanel({
      currentSourceId: current.id,
      layerKind: current.layerKind,
    });

    expect(
      screen.getByTestId(
        `briefing-source-history-filter-all-count-${current.id}`,
      ).textContent,
    ).toBe("(3)");
    expect(
      screen.getByTestId(
        `briefing-source-history-filter-adapter-count-${current.id}`,
      ).textContent,
    ).toBe("(2)");
    expect(
      screen.getByTestId(
        `briefing-source-history-filter-manual-count-${current.id}`,
      ).textContent,
    ).toBe("(1)");
  });

  it("reveals a 'Payload changes' subsection that lists per-key federal-payload deltas (Task #211)", () => {
    // FEMA flood-zone rerun: the metadata snapshotDate moved AND the
    // structured payload's `floodZone` flipped from "AE" → "X". The
    // existing reveal already covers snapshotDate; the subsection
    // under it must surface the payload-level delta so the architect
    // doesn't have to crack open "View layer details" on both rows.
    const current = mkSource({
      id: "src-current",
      layerKind: "fema-nfhl-flood-zone",
      sourceKind: "federal-adapter",
      provider: "fema:fema-nfhl (FEMA NFHL)",
      note: "Auto-fetched by Generate Layers.",
      snapshotDate: "2026-04-15T00:00:00.000Z",
      payload: {
        kind: "flood-zone",
        floodZone: "X",
        inSpecialFloodHazardArea: false,
        baseFloodElevation: null,
      },
    });
    const prior = mkSource({
      id: "src-prior-flood",
      layerKind: "fema-nfhl-flood-zone",
      sourceKind: "federal-adapter",
      provider: "fema:fema-nfhl (FEMA NFHL)",
      note: "Auto-fetched by Generate Layers.",
      snapshotDate: "2026-01-01T00:00:00.000Z",
      payload: {
        kind: "flood-zone",
        floodZone: "AE",
        inSpecialFloodHazardArea: true,
        baseFloodElevation: 425.5,
      },
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      supersededAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    });
    hoisted.historySources = [current, prior];

    renderPanel({
      currentSourceId: current.id,
      layerKind: current.layerKind,
    });

    // Hint pulls in both the metadata field name and the payload
    // labels — collapsed by default so the subsection isn't yet in
    // the DOM.
    const hint = screen.getByTestId(
      `briefing-source-history-row-changed-${prior.id}`,
    );
    expect(hint.textContent).toContain("snapshotDate");
    expect(hint.textContent).toContain("Flood Zone");
    expect(hint.textContent).toContain("In SFHA");
    expect(hint.textContent).toContain("BFE");
    expect(
      screen.queryByTestId(
        `briefing-source-history-row-payload-changes-${prior.id}`,
      ),
    ).not.toBeInTheDocument();

    fireEvent.click(hint);

    const subsection = screen.getByTestId(
      `briefing-source-history-row-payload-changes-${prior.id}`,
    );
    expect(within(subsection).getByText(/Payload changes/i)).toBeInTheDocument();

    expect(
      screen.getByTestId(
        `briefing-source-history-row-payload-before-floodZone-${prior.id}`,
      ).textContent,
    ).toBe("AE");
    expect(
      screen.getByTestId(
        `briefing-source-history-row-payload-after-floodZone-${prior.id}`,
      ).textContent,
    ).toBe("X");
    expect(
      screen.getByTestId(
        `briefing-source-history-row-payload-before-baseFloodElevation-${prior.id}`,
      ).textContent,
    ).toBe("425.5 ft");
    expect(
      screen.getByTestId(
        `briefing-source-history-row-payload-after-baseFloodElevation-${prior.id}`,
      ).textContent,
    ).toBe("(none)");
    expect(
      screen.getByTestId(
        `briefing-source-history-row-payload-before-inSpecialFloodHazardArea-${prior.id}`,
      ).textContent,
    ).toBe("Yes");
    expect(
      screen.getByTestId(
        `briefing-source-history-row-payload-after-inSpecialFloodHazardArea-${prior.id}`,
      ).textContent,
    ).toBe("No");

    // The metadata table is still rendered above the subsection so
    // the snapshotDate move stays visible at the same glance.
    expect(
      screen.getByTestId(
        `briefing-source-history-row-changed-before-snapshotDate-${prior.id}`,
      ).textContent,
    ).toBe("2026-01-01");
  });

  it("does NOT render the 'Payload changes' subsection when the federal payload is identical between reruns (Task #211)", () => {
    // snapshotDate moved (so the reveal still opens via the existing
    // metadata diff) but every payload key formats identically — the
    // subsection must stay out of the DOM and the hint must not list
    // any payload labels.
    const payload = {
      kind: "flood-zone",
      floodZone: "AE",
      inSpecialFloodHazardArea: true,
      baseFloodElevation: 425.5,
    };
    const current = mkSource({
      id: "src-current",
      layerKind: "fema-nfhl-flood-zone",
      sourceKind: "federal-adapter",
      provider: "fema:fema-nfhl (FEMA NFHL)",
      note: "Auto-fetched by Generate Layers.",
      snapshotDate: "2026-04-15T00:00:00.000Z",
      payload,
    });
    const prior = mkSource({
      id: "src-prior-noop-payload",
      layerKind: "fema-nfhl-flood-zone",
      sourceKind: "federal-adapter",
      provider: "fema:fema-nfhl (FEMA NFHL)",
      note: "Auto-fetched by Generate Layers.",
      snapshotDate: "2026-01-01T00:00:00.000Z",
      payload: { ...payload },
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      supersededAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    });
    hoisted.historySources = [current, prior];

    renderPanel({
      currentSourceId: current.id,
      layerKind: current.layerKind,
    });

    const hint = screen.getByTestId(
      `briefing-source-history-row-changed-${prior.id}`,
    );
    // Hint only lists snapshotDate — none of the payload labels
    // leaked in even though the federal-payload diff was attempted.
    expect(hint.textContent).toMatch(/Changed:\s*snapshotDate\s*$/);
    expect(hint.textContent).not.toContain("Flood Zone");
    expect(hint.textContent).not.toContain("BFE");
    expect(hint.textContent).not.toContain("In SFHA");

    fireEvent.click(hint);

    // Reveal opens (snapshotDate moved) but the payload subsection
    // is suppressed so the architect isn't shown an empty heading.
    expect(
      screen.getByTestId(
        `briefing-source-history-row-changed-detail-${prior.id}`,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId(
        `briefing-source-history-row-payload-changes-${prior.id}`,
      ),
    ).not.toBeInTheDocument();
  });

  it("persists the active tier filter across remounts via localStorage so collapsing the panel or refreshing the page restores the choice (Task #196)", () => {
    const engagementId = "eng-persist";
    const current = mkSource({
      id: "src-current",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
    });
    const priorAdapter = mkSource({
      id: "src-prior-adapter",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
      provider: "fema:fema-flood (FEMA NFHL)",
      createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      supersededAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    });
    const priorManual = mkSource({
      id: "src-prior-manual",
      layerKind: "fema-flood",
      sourceKind: "manual-upload",
      uploadOriginalFilename: "manual-override.dxf",
      uploadByteSize: 4_321,
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      supersededAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });
    hoisted.historySources = [current, priorAdapter, priorManual];

    // First mount: pick "Generate Layers" so only adapter rows show.
    renderPanel({
      engagementId,
      currentSourceId: current.id,
      layerKind: current.layerKind,
    });
    fireEvent.click(
      screen.getByTestId(
        `briefing-source-history-filter-adapter-${current.id}`,
      ),
    );

    // The selection is mirrored to localStorage under the
    // engagement-scoped key so the next mount can pick it up.
    expect(
      window.localStorage.getItem(
        briefingSourceHistoryTierStorageKey(engagementId),
      ),
    ).toBe("adapter");

    // Simulate a panel collapse / page reload: tear the tree down and
    // re-render the panel from scratch. The first render must already
    // reflect the restored filter — no flicker through the default
    // "all" value, no waitFor needed.
    cleanup();
    renderPanel({
      engagementId,
      currentSourceId: current.id,
      layerKind: current.layerKind,
    });

    expect(
      screen
        .getByTestId(`briefing-source-history-filter-adapter-${current.id}`)
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByTestId(`briefing-source-history-filter-all-${current.id}`)
        .getAttribute("aria-checked"),
    ).toBe("false");
    // And the filter is actually applied on the restored render —
    // adapter rows visible, manual rows hidden.
    expect(
      screen.getByTestId(`briefing-source-history-row-${priorAdapter.id}`),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId(`briefing-source-history-row-${priorManual.id}`),
    ).not.toBeInTheDocument();
  });

  it("scopes the persisted tier filter per engagement so a different engagement starts at the default 'all' (Task #196)", () => {
    const current = mkSource({
      id: "src-current",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
    });
    const priorAdapter = mkSource({
      id: "src-prior-adapter",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
      provider: "fema:fema-flood (FEMA NFHL)",
      createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      supersededAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    });
    const priorManual = mkSource({
      id: "src-prior-manual",
      layerKind: "fema-flood",
      sourceKind: "manual-upload",
      uploadOriginalFilename: "manual-override.dxf",
      uploadByteSize: 4_321,
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      supersededAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });
    hoisted.historySources = [current, priorAdapter, priorManual];

    // Pre-seed a stored choice for engagement A only.
    window.localStorage.setItem(
      briefingSourceHistoryTierStorageKey("eng-A"),
      "manual",
    );

    // Engagement B has no stored value — must fall back to "all".
    renderPanel({
      engagementId: "eng-B",
      currentSourceId: current.id,
      layerKind: current.layerKind,
    });
    expect(
      screen
        .getByTestId(`briefing-source-history-filter-all-${current.id}`)
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByTestId(`briefing-source-history-row-${priorAdapter.id}`),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId(`briefing-source-history-row-${priorManual.id}`),
    ).toBeInTheDocument();
  });

  it("reveals the prior + current values for a USGS elevation rerun (Task #224)", () => {
    // USGS NED rerun: snapshotDate stays put but the elevation
    // reading moved by one foot. The payload-only path must still
    // produce a hint and a populated "Payload changes" subsection
    // so a panel-level wiring regression (wrong test-id key, missing
    // label, dropped chip text) is caught here even though the
    // metadata table above the subsection is empty.
    const current = mkSource({
      id: "src-current",
      layerKind: "usgs-ned-elevation",
      sourceKind: "federal-adapter",
      provider: "usgs:epqs (USGS EPQS)",
      note: "Auto-fetched by Generate Layers.",
      snapshotDate: "2026-04-15T00:00:00.000Z",
      payload: {
        kind: "elevation-point",
        elevationFeet: 4034,
        units: "Feet",
      },
    });
    const prior = mkSource({
      id: "src-prior-usgs",
      layerKind: "usgs-ned-elevation",
      sourceKind: "federal-adapter",
      provider: "usgs:epqs (USGS EPQS)",
      note: "Auto-fetched by Generate Layers.",
      snapshotDate: "2026-04-15T00:00:00.000Z",
      payload: {
        kind: "elevation-point",
        elevationFeet: 4033,
        units: "Feet",
      },
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      supersededAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    });
    hoisted.historySources = [current, prior];

    renderPanel({
      currentSourceId: current.id,
      layerKind: current.layerKind,
    });

    // snapshotDate matches → only the payload label appears in the
    // hint. This pins the hintParts wiring for a payload-only diff
    // (no metadata field leaked in, no other USGS labels appeared).
    const hint = screen.getByTestId(
      `briefing-source-history-row-changed-${prior.id}`,
    );
    expect(hint.textContent).toMatch(/Changed:\s*Elevation\s*$/);
    expect(hint.textContent).not.toContain("snapshotDate");

    fireEvent.click(hint);

    const subsection = screen.getByTestId(
      `briefing-source-history-row-payload-changes-${prior.id}`,
    );
    expect(within(subsection).getByText(/Payload changes/i)).toBeInTheDocument();
    // Per-key test-id uses the payload key (`elevationFeet`) and the
    // before/after values mirror the inline summary chip's units +
    // thousands grouping so the auditor sees the same formatting
    // they read on the row above.
    expect(
      screen.getByTestId(
        `briefing-source-history-row-payload-before-elevationFeet-${prior.id}`,
      ).textContent,
    ).toBe("4,033 ft");
    expect(
      screen.getByTestId(
        `briefing-source-history-row-payload-after-elevationFeet-${prior.id}`,
      ).textContent,
    ).toBe("4,034 ft");
  });

  it("reveals the prior + current values for an EJScreen percentile rerun (Task #224)", () => {
    // EPA EJScreen rerun: the demographic-index percentile moved
    // from the 65th to the 71st pctile while PM2.5 stayed put. The
    // reveal must surface only the moved key and format both sides
    // with the chip's ordinal suffix.
    const current = mkSource({
      id: "src-current",
      layerKind: "epa-ejscreen-blockgroup",
      sourceKind: "federal-adapter",
      provider: "epa:ejscreen (EPA EJScreen)",
      note: "Auto-fetched by Generate Layers.",
      snapshotDate: "2026-04-15T00:00:00.000Z",
      payload: {
        kind: "ejscreen-blockgroup",
        demographicIndexPercentile: 71,
        pm25Percentile: 72,
      },
    });
    const prior = mkSource({
      id: "src-prior-ejscreen",
      layerKind: "epa-ejscreen-blockgroup",
      sourceKind: "federal-adapter",
      provider: "epa:ejscreen (EPA EJScreen)",
      note: "Auto-fetched by Generate Layers.",
      snapshotDate: "2026-04-15T00:00:00.000Z",
      payload: {
        kind: "ejscreen-blockgroup",
        demographicIndexPercentile: 65,
        pm25Percentile: 72,
      },
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      supersededAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    });
    hoisted.historySources = [current, prior];

    renderPanel({
      currentSourceId: current.id,
      layerKind: current.layerKind,
    });

    const hint = screen.getByTestId(
      `briefing-source-history-row-changed-${prior.id}`,
    );
    // Only EJ Index moved — PM2.5 must not leak into the hint copy.
    expect(hint.textContent).toMatch(/Changed:\s*EJ Index\s*$/);
    expect(hint.textContent).not.toContain("PM2.5");
    expect(hint.textContent).not.toContain("snapshotDate");

    fireEvent.click(hint);

    expect(
      screen.getByTestId(
        `briefing-source-history-row-payload-before-demographicIndexPercentile-${prior.id}`,
      ).textContent,
    ).toBe("65th pctile");
    expect(
      screen.getByTestId(
        `briefing-source-history-row-payload-after-demographicIndexPercentile-${prior.id}`,
      ).textContent,
    ).toBe("71st pctile");
    // PM2.5 didn't move, so its row must be absent from the reveal —
    // a regression that emitted unchanged keys would surface here.
    expect(
      screen.queryByTestId(
        `briefing-source-history-row-payload-before-pm25Percentile-${prior.id}`,
      ),
    ).not.toBeInTheDocument();
  });

  it("reveals the prior + current values for an FCC broadband tier rerun (Task #224)", () => {
    // FCC broadband rerun: provider count went from 1 → 2 and the
    // fastest tier crossed the gigabit boundary (100 Mbps → 1 Gbps).
    // Both keys moved, so the reveal must list both rows in the
    // adapter's declared order (providerCount before
    // fastestDownstreamMbps) and format each side the same way the
    // inline chip does (Mbps for sub-gigabit, Gbps at/above 1000).
    const current = mkSource({
      id: "src-current",
      layerKind: "fcc-broadband-availability",
      sourceKind: "federal-adapter",
      provider: "fcc:broadband (FCC Broadband)",
      note: "Auto-fetched by Generate Layers.",
      snapshotDate: "2026-04-15T00:00:00.000Z",
      payload: {
        kind: "broadband-availability",
        providerCount: 2,
        fastestDownstreamMbps: 1000,
      },
    });
    const prior = mkSource({
      id: "src-prior-fcc",
      layerKind: "fcc-broadband-availability",
      sourceKind: "federal-adapter",
      provider: "fcc:broadband (FCC Broadband)",
      note: "Auto-fetched by Generate Layers.",
      snapshotDate: "2026-04-15T00:00:00.000Z",
      payload: {
        kind: "broadband-availability",
        providerCount: 1,
        fastestDownstreamMbps: 100,
      },
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      supersededAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    });
    hoisted.historySources = [current, prior];

    renderPanel({
      currentSourceId: current.id,
      layerKind: current.layerKind,
    });

    const hint = screen.getByTestId(
      `briefing-source-history-row-changed-${prior.id}`,
    );
    // Both labels are present, joined by ", " in the adapter's order.
    expect(hint.textContent).toMatch(/Changed:\s*Providers, Fastest\s*$/);
    expect(hint.textContent).not.toContain("snapshotDate");

    fireEvent.click(hint);

    expect(
      screen.getByTestId(
        `briefing-source-history-row-payload-before-providerCount-${prior.id}`,
      ).textContent,
    ).toBe("1");
    expect(
      screen.getByTestId(
        `briefing-source-history-row-payload-after-providerCount-${prior.id}`,
      ).textContent,
    ).toBe("2");
    expect(
      screen.getByTestId(
        `briefing-source-history-row-payload-before-fastestDownstreamMbps-${prior.id}`,
      ).textContent,
    ).toBe("100 Mbps");
    expect(
      screen.getByTestId(
        `briefing-source-history-row-payload-after-fastestDownstreamMbps-${prior.id}`,
      ).textContent,
    ).toBe("1 Gbps");
  });

  it("syncs the active tier across two simultaneously-mounted panels for the same engagement so flipping the filter on one re-renders the other on the same tick (Task #206)", () => {
    const engagementId = "eng-sync";
    const currentA = mkSource({
      id: "src-current-A",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
    });
    const currentB = mkSource({
      id: "src-current-B",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
    });
    const priorAdapter = mkSource({
      id: "src-prior-adapter",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
      provider: "fema:fema-flood (FEMA NFHL)",
      createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      supersededAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    });
    const priorManual = mkSource({
      id: "src-prior-manual",
      layerKind: "fema-flood",
      sourceKind: "manual-upload",
      uploadOriginalFilename: "manual-override.dxf",
      uploadByteSize: 4_321,
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      supersededAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });
    hoisted.historySources = [currentA, currentB, priorAdapter, priorManual];

    // Mount both panels for the same engagement, simulating an
    // architect who has expanded two per-layer history panels at
    // once (one per current source row on the same page).
    renderPanel({
      engagementId,
      currentSourceId: currentA.id,
      layerKind: currentA.layerKind,
    });
    renderPanel({
      engagementId,
      currentSourceId: currentB.id,
      layerKind: currentB.layerKind,
    });

    // Both panels start at the default "all" tier and show the
    // manual prior row alongside the adapter prior row.
    expect(
      screen
        .getByTestId(`briefing-source-history-filter-all-${currentA.id}`)
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByTestId(`briefing-source-history-filter-all-${currentB.id}`)
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getAllByTestId(
        `briefing-source-history-row-${priorManual.id}`,
      ).length,
    ).toBe(2);

    // Click "Generate Layers" on panel A. Panel B must pick up the
    // new tier in the same tick — no remount, no waitFor, no manual
    // collapse/reopen on the sibling.
    fireEvent.click(
      screen.getByTestId(
        `briefing-source-history-filter-adapter-${currentA.id}`,
      ),
    );

    // Panel B's pill swapped to "adapter" active and its "all" pill
    // dropped its checked state.
    expect(
      screen
        .getByTestId(`briefing-source-history-filter-adapter-${currentB.id}`)
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByTestId(`briefing-source-history-filter-all-${currentB.id}`)
        .getAttribute("aria-checked"),
    ).toBe("false");

    // Filter is actually applied on panel B's row list, not just on
    // its pill state — the manual prior row vanishes from both
    // panels and the adapter prior row remains visible in both.
    expect(
      screen.queryAllByTestId(
        `briefing-source-history-row-${priorManual.id}`,
      ).length,
    ).toBe(0);
    expect(
      screen.getAllByTestId(
        `briefing-source-history-row-${priorAdapter.id}`,
      ).length,
    ).toBe(2);

    // localStorage is still the persistence layer — the click on A
    // must have round-tripped the new value through the engagement
    // -scoped key so a future remount would still restore it.
    expect(
      window.localStorage.getItem(
        briefingSourceHistoryTierStorageKey(engagementId),
      ),
    ).toBe("adapter");
  });

  it("scopes the cross-panel sync per engagement so a write on engagement A does NOT touch a panel mounted for engagement B (Task #206)", () => {
    const currentA = mkSource({
      id: "src-current-A",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
    });
    const currentB = mkSource({
      id: "src-current-B",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
    });
    const priorManual = mkSource({
      id: "src-prior-manual",
      layerKind: "fema-flood",
      sourceKind: "manual-upload",
      uploadOriginalFilename: "manual-override.dxf",
      uploadByteSize: 4_321,
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      supersededAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });
    hoisted.historySources = [currentA, currentB, priorManual];

    renderPanel({
      engagementId: "eng-A",
      currentSourceId: currentA.id,
      layerKind: currentA.layerKind,
    });
    renderPanel({
      engagementId: "eng-B",
      currentSourceId: currentB.id,
      layerKind: currentB.layerKind,
    });

    // Click "Generate Layers" on the panel for engagement A.
    fireEvent.click(
      screen.getByTestId(
        `briefing-source-history-filter-adapter-${currentA.id}`,
      ),
    );

    // The panel for engagement B must stay on its default "all" pill
    // — the subscriber registry is keyed by storage key (which
    // already encodes the engagement id), so engagement A's write
    // never reaches engagement B's subscribers.
    expect(
      screen
        .getByTestId(`briefing-source-history-filter-all-${currentB.id}`)
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByTestId(`briefing-source-history-filter-adapter-${currentB.id}`)
        .getAttribute("aria-checked"),
    ).toBe("false");
    // And the manual prior row is still visible inside engagement
    // B's panel — its "all" filter wasn't flipped to "adapter".
    expect(
      screen.getByTestId(
        `briefing-source-history-row-${priorManual.id}`,
      ),
    ).toBeInTheDocument();
  });

  it("stamps the oldest→newest createdAt range next to each filter pill so an architect can prioritise stale-vs-fresh tabs (Task #202)", () => {
    // Mixed history with two adapter prior rows of clearly different
    // createdAt days plus one manual prior row sandwiched between
    // them. The "All" pill range must span the outermost two days
    // across both tiers; the per-tier pills must collapse to the
    // dates that actually belong to that tier — the adapter range
    // must NOT be widened by the manual row's date and vice versa.
    const current = mkSource({
      id: "src-current",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
    });
    const priorAdapterOldest = mkSource({
      id: "src-prior-adapter-oldest",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
      provider: "fema:fema-flood (FEMA NFHL)",
      createdAt: "2026-04-03T12:00:00.000Z",
      supersededAt: "2026-04-04T00:00:00.000Z",
    });
    const priorAdapterNewest = mkSource({
      id: "src-prior-adapter-newest",
      layerKind: "fema-flood",
      sourceKind: "state-adapter",
      provider: "ut:fema-flood",
      createdAt: "2026-04-28T12:00:00.000Z",
      supersededAt: "2026-04-29T00:00:00.000Z",
    });
    const priorManual = mkSource({
      id: "src-prior-manual",
      layerKind: "fema-flood",
      sourceKind: "manual-upload",
      uploadOriginalFilename: "manual-override.dxf",
      uploadByteSize: 4_321,
      createdAt: "2026-05-01T12:00:00.000Z",
      supersededAt: "2026-05-02T00:00:00.000Z",
    });
    hoisted.historySources = [
      current,
      priorAdapterOldest,
      priorAdapterNewest,
      priorManual,
    ];

    renderPanel({
      currentSourceId: current.id,
      layerKind: current.layerKind,
    });

    const allRange = screen.getByTestId(
      `briefing-source-history-filter-all-range-${current.id}`,
    );
    expect(allRange.textContent).toBe("· Apr 3 → May 1");

    const adapterRange = screen.getByTestId(
      `briefing-source-history-filter-adapter-range-${current.id}`,
    );
    // Adapter range only covers the two adapter rows (Apr 3 → Apr 28),
    // not the manual row's May 1 — that would mean the per-tier
    // range was being computed off the wrong row set.
    expect(adapterRange.textContent).toBe("· Apr 3 → Apr 28");

    const manualRange = screen.getByTestId(
      `briefing-source-history-filter-manual-range-${current.id}`,
    );
    // A single-row tier collapses to one date — no "May 1 → May 1".
    expect(manualRange.textContent).toBe("· May 1");

    // Hover/title carries the long-form phrasing from the task copy
    // so screen-reader / hover users get the full signal too.
    const allPill = screen.getByTestId(
      `briefing-source-history-filter-all-${current.id}`,
    );
    expect(allPill.getAttribute("title")).toBe(
      "oldest April 3, 2026 → newest May 1, 2026",
    );
  });

  it("skips the date range on a tier pill that has zero prior versions (Task #202)", () => {
    // Only an adapter prior row in history — the Manual uploads pill
    // is empty (count 0) so the range caption must not render at all
    // (no stray "·" separator, no "Invalid Date" placeholder).
    const current = mkSource({
      id: "src-current",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
    });
    const priorAdapter = mkSource({
      id: "src-prior-adapter-only",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
      provider: "fema:fema-flood (FEMA NFHL)",
      createdAt: "2026-04-03T12:00:00.000Z",
      supersededAt: "2026-04-04T00:00:00.000Z",
    });
    hoisted.historySources = [current, priorAdapter];

    renderPanel({
      currentSourceId: current.id,
      layerKind: current.layerKind,
    });

    expect(
      screen.getByTestId(
        `briefing-source-history-filter-adapter-range-${current.id}`,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId(
        `briefing-source-history-filter-manual-range-${current.id}`,
      ),
    ).not.toBeInTheDocument();
    // The empty pill must also NOT carry a `title` attribute — there
    // is no range to describe on hover either.
    const manualPill = screen.getByTestId(
      `briefing-source-history-filter-manual-${current.id}`,
    );
    expect(manualPill.getAttribute("title")).toBeNull();
  });

  it("flags a filter pill as stale when its newest prior version is older than the threshold (follow-up)", () => {
    // Two adapter prior rows whose newest createdAt is ~60 days old
    // — well beyond the 30-day stale threshold — and one manual prior
    // row from yesterday. The Generate Layers + All pills should be
    // marked stale; the Manual uploads pill must stay neutral so a
    // recently re-uploaded manual layer isn't misflagged.
    const dayMs = 24 * 60 * 60 * 1000;
    const current = mkSource({
      id: "src-current",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
    });
    const oldAdapter = mkSource({
      id: "src-prior-old-adapter",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
      createdAt: new Date(Date.now() - 90 * dayMs).toISOString(),
      supersededAt: new Date(Date.now() - 65 * dayMs).toISOString(),
    });
    const stillOldAdapter = mkSource({
      id: "src-prior-still-old-adapter",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
      createdAt: new Date(Date.now() - 60 * dayMs).toISOString(),
      supersededAt: new Date(Date.now() - 59 * dayMs).toISOString(),
    });
    const freshManual = mkSource({
      id: "src-prior-fresh-manual",
      layerKind: "fema-flood",
      sourceKind: "manual-upload",
      uploadOriginalFilename: "manual-override.dxf",
      uploadByteSize: 4_321,
      createdAt: new Date(Date.now() - 1 * dayMs).toISOString(),
      supersededAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });
    hoisted.historySources = [
      current,
      oldAdapter,
      stillOldAdapter,
      freshManual,
    ];

    renderPanel({
      currentSourceId: current.id,
      layerKind: current.layerKind,
    });

    const adapterPill = screen.getByTestId(
      `briefing-source-history-filter-adapter-${current.id}`,
    );
    expect(adapterPill.getAttribute("data-stale")).toBe("true");
    // Long-form title carries the explanation so users who notice
    // the amber styling can read the "why" without hunting in code.
    expect(adapterPill.getAttribute("title")).toMatch(/stale/);
    expect(
      screen.getByTestId(
        `briefing-source-history-filter-adapter-stale-dot-${current.id}`,
      ),
    ).toBeInTheDocument();

    // Manual pill is fresh — must NOT be flagged.
    const manualPill = screen.getByTestId(
      `briefing-source-history-filter-manual-${current.id}`,
    );
    expect(manualPill.getAttribute("data-stale")).toBeNull();
    expect(manualPill.getAttribute("title")).not.toMatch(/stale/);
    expect(
      screen.queryByTestId(
        `briefing-source-history-filter-manual-stale-dot-${current.id}`,
      ),
    ).not.toBeInTheDocument();
  });

  it("does NOT flag an empty filter pill as stale (follow-up)", () => {
    // Only an adapter prior row — the Manual uploads pill is empty
    // (count 0) and must therefore stay neutral. A pill that has no
    // prior versions has nothing to be "overdue" about.
    const current = mkSource({
      id: "src-current",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
    });
    const oldAdapter = mkSource({
      id: "src-prior-old-adapter",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
      createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
      supersededAt: new Date(Date.now() - 65 * 24 * 60 * 60 * 1000).toISOString(),
    });
    hoisted.historySources = [current, oldAdapter];

    renderPanel({
      currentSourceId: current.id,
      layerKind: current.layerKind,
    });

    const manualPill = screen.getByTestId(
      `briefing-source-history-filter-manual-${current.id}`,
    );
    expect(manualPill.getAttribute("data-stale")).toBeNull();
    expect(
      screen.queryByTestId(
        `briefing-source-history-filter-manual-stale-dot-${current.id}`,
      ),
    ).not.toBeInTheDocument();
  });

  it("advertises the prior-version count + date range on the collapsed history toggle (follow-up)", () => {
    // Three prior rows of mixed dates — when the row is rendered
    // collapsed, the toggle button should read "View history (3 prior
    // · Apr 3 → May 1)" so an architect can triage without expanding.
    const current = mkSource({
      id: "src-current",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
      createdAt: new Date(Date.now() - 30 * 1000).toISOString(),
    });
    const priorOldest = mkSource({
      id: "src-prior-oldest",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
      createdAt: "2026-04-03T12:00:00.000Z",
      supersededAt: "2026-04-04T00:00:00.000Z",
    });
    const priorMid = mkSource({
      id: "src-prior-mid",
      layerKind: "fema-flood",
      sourceKind: "state-adapter",
      createdAt: "2026-04-15T12:00:00.000Z",
      supersededAt: "2026-04-16T00:00:00.000Z",
    });
    const priorNewest = mkSource({
      id: "src-prior-newest",
      layerKind: "fema-flood",
      sourceKind: "manual-upload",
      uploadOriginalFilename: "manual-override.dxf",
      uploadByteSize: 4_321,
      createdAt: "2026-05-01T12:00:00.000Z",
      supersededAt: "2026-05-02T00:00:00.000Z",
    });
    hoisted.historySources = [current, priorOldest, priorMid, priorNewest];

    renderRow(current);

    const hint = screen.getByTestId(
      `briefing-source-history-toggle-hint-${current.id}`,
    );
    expect(hint.textContent).toBe("(3 prior · Apr 3 → May 1)");

    // Toggling the panel open hides the hint — the same information
    // is now visible on the filter pills below, so duplicating it on
    // the toggle would just be visual noise.
    fireEvent.click(
      screen.getByTestId(`briefing-source-history-toggle-${current.id}`),
    );
    expect(
      screen.queryByTestId(
        `briefing-source-history-toggle-hint-${current.id}`,
      ),
    ).not.toBeInTheDocument();
  });

  it("collapses the toggle hint to a single date when there is exactly one prior version (follow-up)", () => {
    // One prior row only — the hint must read "(1 prior · Apr 3)"
    // rather than "(1 prior · Apr 3 → Apr 3)". Mirrors the same
    // collapse behaviour the filter-pill range uses.
    const current = mkSource({
      id: "src-current",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
      createdAt: new Date(Date.now() - 30 * 1000).toISOString(),
    });
    const prior = mkSource({
      id: "src-prior-only",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
      createdAt: "2026-04-03T12:00:00.000Z",
      supersededAt: "2026-04-04T00:00:00.000Z",
    });
    hoisted.historySources = [current, prior];

    renderRow(current);

    const hint = screen.getByTestId(
      `briefing-source-history-toggle-hint-${current.id}`,
    );
    expect(hint.textContent).toBe("(1 prior · Apr 3)");
  });

  it("does NOT render the toggle hint when there are no prior versions (follow-up)", () => {
    // Only the current row in history — the toggle stays clean so
    // a layer with no rerun trail doesn't pretend to have one.
    const current = mkSource({
      id: "src-only",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
      createdAt: new Date(Date.now() - 30 * 1000).toISOString(),
    });
    hoisted.historySources = [current];

    renderRow(current);

    expect(
      screen.queryByTestId(
        `briefing-source-history-toggle-hint-${current.id}`,
      ),
    ).not.toBeInTheDocument();
    // The toggle text itself collapses back to the bare label.
    expect(
      screen
        .getByTestId(`briefing-source-history-toggle-${current.id}`)
        .textContent,
    ).toBe("View history");
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
