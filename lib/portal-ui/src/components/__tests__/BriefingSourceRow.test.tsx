/**
 * BriefingSourceRow (lib/portal-ui).
 *
 * Pins the lifted shared per-source row that the architect
 * (design-tools) and reviewer (plan-review) surfaces both render.
 * Coverage exercises:
 *
 *   - producer-agnostic chrome (source-kind badge, "Last refreshed
 *     by Generate Layers" attribution) for adapter and manual rows
 *     (DA-PI-4 / Task #178);
 *   - the cached-from-upstream pill the parent passes via
 *     `cacheInfo` (Task #204);
 *   - the per-row "Refresh this layer" affordance, including its
 *     adapter-key parsing and the `isRefreshing` disabled state
 *     (Task #228);
 *   - the row-level retry-on-failed-conversion mutate button;
 *   - the persisted "Filtered: …" history-tier cue + collapsed
 *     toggle hint (count + range / single date), including the
 *     subscription that clears the cue when the open panel resets
 *     the tier filter to All (Task #205);
 *   - the row's history toggle opening the empty-state panel when
 *     no prior versions exist;
 *   - the `readOnly` flag suppressing every architect-only mutate
 *     affordance (Retry, Refresh this layer) without dropping the
 *     producer-agnostic chrome reviewers depend on.
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
import type { EngagementBriefingSource } from "@workspace/api-client-react";

const hoisted = vi.hoisted(() => ({
  retryMutate: vi.fn(),
  retryIsPending: false,
  // Drives `useListEngagementBriefingSources` for the row's history
  // hint + the nested history panel the row opens on toggle. Each
  // test seeds this before render so the first paint already
  // reflects the desired history state — no async waitFor needed.
  historySources: [] as unknown[],
  historyState: { isLoading: false, isError: false },
}));

vi.mock("@workspace/api-client-react", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/api-client-react")>(
      "@workspace/api-client-react",
    );
  return {
    ...actual,
    useRetryBriefingSourceConversion: () => ({
      mutate: hoisted.retryMutate,
      isPending: hoisted.retryIsPending,
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
    getGetEngagementBriefingQueryKey: (id: string) => [
      "getEngagementBriefing",
      id,
    ],
    getListEngagementBriefingSourcesQueryKey: (
      id: string,
      params: unknown,
    ) => ["listEngagementBriefingSources", id, params],
  };
});

const { BriefingSourceRow } = await import("../BriefingSourceRow");
const {
  BRIEFING_GENERATE_LAYERS_ACTOR_LABEL,
  BRIEFING_SOURCE_HISTORY_TIER_STORAGE_PREFIX,
  briefingSourceHistoryTierStorageKey,
} = await import("../../lib/briefingSourceHelpers");

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
  conversionStatus:
    | null
    | "pending"
    | "converting"
    | "ready"
    | "failed"
    | "dxf-only";
  conversionError: string | null;
  createdAt: string;
  supersededAt: string | null;
  supersededById: string | null;
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

function renderRow(
  source: BriefingSourceFixture,
  engagementId = "eng-1",
  extraProps: Record<string, unknown> = {},
) {
  const client = makeQueryClient();
  const node: ReactNode = (
    <QueryClientProvider client={client}>
      <BriefingSourceRow
        engagementId={engagementId}
        source={source as unknown as EngagementBriefingSource}
        {...extraProps}
      />
    </QueryClientProvider>
  );
  return { ...render(node), client };
}

beforeEach(() => {
  hoisted.retryMutate.mockReset();
  hoisted.retryIsPending = false;
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
    renderRow(source, "eng-1", {
      cacheInfo: { fromCache: true, cachedAt: sixHoursAgo },
    });

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
    renderRow(source, "eng-1", {
      cacheInfo: { fromCache: true, cachedAt: justNow },
    });
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
          source={source as unknown as EngagementBriefingSource}
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

describe("BriefingSourceRow — per-row 'Refresh this layer' (Task #228)", () => {
  it("renders the affordance for federal-adapter rows and forwards the parsed adapterKey on click", () => {
    const source = mkSource({
      id: "src-fed-fema",
      layerKind: "fema-nfhl-flood-zone",
      sourceKind: "federal-adapter",
      provider: "fema:nfhl-flood-zone (FEMA NFHL)",
    });
    const onRefreshLayer = vi.fn();
    renderRow(source, "eng-1", { onRefreshLayer });

    const btn = screen.getByTestId(`briefing-source-refresh-layer-${source.id}`);
    expect(btn).toBeInTheDocument();
    expect(btn.textContent).toBe("Refresh this layer");
    expect(btn.getAttribute("data-adapter-key")).toBe("fema:nfhl-flood-zone");
    expect(btn).not.toBeDisabled();

    fireEvent.click(btn);
    expect(onRefreshLayer).toHaveBeenCalledTimes(1);
    expect(onRefreshLayer).toHaveBeenCalledWith("fema:nfhl-flood-zone");
  });

  it("shows 'Refreshing…' and disables the button when isRefreshing is true", () => {
    const source = mkSource({
      id: "src-fed-fema",
      layerKind: "fema-nfhl-flood-zone",
      sourceKind: "federal-adapter",
      provider: "fema:nfhl-flood-zone (FEMA NFHL)",
    });
    const onRefreshLayer = vi.fn();
    renderRow(source, "eng-1", { onRefreshLayer, isRefreshing: true });
    const btn = screen.getByTestId(`briefing-source-refresh-layer-${source.id}`);
    expect(btn.textContent).toBe("Refreshing…");
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onRefreshLayer).not.toHaveBeenCalled();
  });

  it("does NOT render the affordance on state-adapter, local-adapter, or manual-upload rows", () => {
    const onRefreshLayer = vi.fn();
    const stateSrc = mkSource({
      id: "src-state",
      layerKind: "ut-zoning",
      sourceKind: "state-adapter",
      provider: "utah:ugrc-parcels (UGRC)",
    });
    renderRow(stateSrc, "eng-1", { onRefreshLayer });
    expect(
      screen.queryByTestId(`briefing-source-refresh-layer-${stateSrc.id}`),
    ).not.toBeInTheDocument();
    cleanup();

    const localSrc = mkSource({
      id: "src-local",
      layerKind: "boulder-parcels",
      sourceKind: "local-adapter",
      provider: "boulder-co:parcels (Boulder GIS)",
    });
    renderRow(localSrc, "eng-1", { onRefreshLayer });
    expect(
      screen.queryByTestId(`briefing-source-refresh-layer-${localSrc.id}`),
    ).not.toBeInTheDocument();
    cleanup();

    const manualSrc = mkSource({
      id: "src-manual",
      layerKind: "qgis-overlay",
      sourceKind: "manual-upload",
      provider: "Architect-supplied DXF",
    });
    renderRow(manualSrc, "eng-1", { onRefreshLayer });
    expect(
      screen.queryByTestId(`briefing-source-refresh-layer-${manualSrc.id}`),
    ).not.toBeInTheDocument();
  });

  it("does NOT render the affordance when onRefreshLayer is not provided (default null)", () => {
    const source = mkSource({
      id: "src-fed-no-cb",
      layerKind: "fema-nfhl-flood-zone",
      sourceKind: "federal-adapter",
      provider: "fema:nfhl-flood-zone (FEMA NFHL)",
    });
    renderRow(source);
    expect(
      screen.queryByTestId(`briefing-source-refresh-layer-${source.id}`),
    ).not.toBeInTheDocument();
  });

  it("does NOT render the affordance when the provider does not follow the packed `<key> (<label>)` convention", () => {
    // E.g. an upstream that wrote a malformed/legacy provider value
    // (no parens, no namespace colon). The federal-tier check alone
    // would otherwise show a button whose adapterKey is unsafe to
    // round-trip.
    const source = mkSource({
      id: "src-fed-legacy",
      layerKind: "fema-nfhl-flood-zone",
      sourceKind: "federal-adapter",
      provider: "FEMA NFHL",
    });
    const onRefreshLayer = vi.fn();
    renderRow(source, "eng-1", { onRefreshLayer });
    expect(
      screen.queryByTestId(`briefing-source-refresh-layer-${source.id}`),
    ).not.toBeInTheDocument();
  });
});

describe("BriefingSourceRow — failed-conversion retry", () => {
  it("renders the Retry button on a failed conversion and fires the retry mutation when clicked", () => {
    const source = mkSource({
      id: "src-conv-fail",
      layerKind: "qgis-overlay",
      sourceKind: "manual-upload",
      conversionStatus: "failed",
      conversionError: "DXF unsupported",
    });
    renderRow(source);
    const btn = screen.getByTestId(
      `briefing-source-retry-conversion-${source.id}`,
    );
    fireEvent.click(btn);
    expect(hoisted.retryMutate).toHaveBeenCalledWith({
      id: "eng-1",
      sourceId: "src-conv-fail",
    });
  });
});

describe("BriefingSourceRow — collapsed history toggle hint (follow-up)", () => {
  it("advertises the prior-version count + date range on the collapsed history toggle", () => {
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

  it("collapses the toggle hint to a single date when there is exactly one prior version", () => {
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

  it("does NOT render the toggle hint when there are no prior versions", () => {
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

describe("BriefingSourceRow — persisted 'Filtered: …' history-tier cue (Task #205)", () => {
  it("renders a 'Filtered: …' cue on the collapsed row when a non-default tier filter is persisted", () => {
    // Pre-seed the persisted tier so the row's first render reads the
    // restored value synchronously, mirroring the post-refresh flow
    // an architect would hit. We pin both adapter and manual tiers so
    // the cue label / data-tier attribute are exercised.
    const adapterRow = mkSource({
      id: "src-fed-cue-adapter",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
      createdAt: new Date(Date.now() - 60 * 1000).toISOString(),
    });
    window.localStorage.setItem(
      briefingSourceHistoryTierStorageKey("eng-cue"),
      "adapter",
    );
    renderRow(adapterRow, "eng-cue");

    const adapterCue = screen.getByTestId(
      `briefing-source-history-filter-cue-${adapterRow.id}`,
    );
    expect(adapterCue).toBeInTheDocument();
    expect(adapterCue.getAttribute("data-tier")).toBe("adapter");
    expect(adapterCue.textContent).toMatch(/Generate Layers/);
    cleanup();

    // Manual tier — same fixture shape, different persisted value,
    // separate engagement key so the previous spec's setItem can't
    // bleed into this assertion.
    const manualRow = mkSource({
      id: "src-fed-cue-manual",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
      createdAt: new Date(Date.now() - 60 * 1000).toISOString(),
    });
    window.localStorage.setItem(
      briefingSourceHistoryTierStorageKey("eng-cue-manual"),
      "manual",
    );
    renderRow(manualRow, "eng-cue-manual");

    const manualCue = screen.getByTestId(
      `briefing-source-history-filter-cue-${manualRow.id}`,
    );
    expect(manualCue.getAttribute("data-tier")).toBe("manual");
    expect(manualCue.textContent).toMatch(/Manual uploads/);
  });

  it("does NOT render the 'Filtered: …' cue when the persisted tier is the default 'all'", () => {
    // No `setItem` call before render — `readBriefingSourceHistoryTier`
    // falls back to "all" and the cue must stay off so an unfiltered
    // panel doesn't read as "filtered" to the user.
    const row = mkSource({
      id: "src-fed-cue-none",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
      createdAt: new Date(Date.now() - 60 * 1000).toISOString(),
    });
    renderRow(row, "eng-cue-none");
    expect(
      screen.queryByTestId(
        `briefing-source-history-filter-cue-${row.id}`,
      ),
    ).not.toBeInTheDocument();

    // Explicit "all" written into storage — same outcome: no cue.
    cleanup();
    const row2 = mkSource({
      id: "src-fed-cue-all",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
      createdAt: new Date(Date.now() - 60 * 1000).toISOString(),
    });
    window.localStorage.setItem(
      briefingSourceHistoryTierStorageKey("eng-cue-all"),
      "all",
    );
    renderRow(row2, "eng-cue-all");
    expect(
      screen.queryByTestId(
        `briefing-source-history-filter-cue-${row2.id}`,
      ),
    ).not.toBeInTheDocument();
  });

  it("clears the row's 'Filtered: …' cue when the open panel resets the tier filter to All", () => {
    // Mount the row with a persisted non-default tier so the cue is
    // present on first render. Then open the panel via the toggle and
    // click the "All" filter button — the row's subscription to the
    // shared change event must drop the cue without a remount.
    const current = mkSource({
      id: "src-cue-reset",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
      createdAt: new Date(Date.now() - 60 * 1000).toISOString(),
    });
    hoisted.historySources = [current];
    window.localStorage.setItem(
      briefingSourceHistoryTierStorageKey("eng-cue-reset"),
      "adapter",
    );
    renderRow(current, "eng-cue-reset");
    expect(
      screen.getByTestId(
        `briefing-source-history-filter-cue-${current.id}`,
      ),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByTestId(`briefing-source-history-toggle-${current.id}`),
    );
    fireEvent.click(
      screen.getByTestId(
        `briefing-source-history-filter-all-${current.id}`,
      ),
    );

    expect(
      screen.queryByTestId(
        `briefing-source-history-filter-cue-${current.id}`,
      ),
    ).not.toBeInTheDocument();
  });
});

describe("BriefingSourceRow — readOnly mode (Task #316)", () => {
  it("hides the Retry conversion button on a failed conversion", () => {
    const source = mkSource({
      id: "src-conv-fail-ro",
      layerKind: "qgis-overlay",
      sourceKind: "manual-upload",
      conversionStatus: "failed",
      conversionError: "DXF unsupported",
    });
    renderRow(source, "eng-1", { readOnly: true });
    // The error chrome still renders so the reviewer can see the
    // conversion failed — only the mutate button is suppressed.
    expect(
      screen.getByTestId(`briefing-source-conversion-failed-${source.id}`),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId(
        `briefing-source-retry-conversion-${source.id}`,
      ),
    ).not.toBeInTheDocument();
  });

  it("hides the 'Refresh this layer' affordance even when onRefreshLayer is supplied", () => {
    const source = mkSource({
      id: "src-fed-ro",
      layerKind: "fema-nfhl-flood-zone",
      sourceKind: "federal-adapter",
      provider: "fema:nfhl-flood-zone (FEMA NFHL)",
    });
    const onRefreshLayer = vi.fn();
    renderRow(source, "eng-1", { onRefreshLayer, readOnly: true });
    expect(
      screen.queryByTestId(`briefing-source-refresh-layer-${source.id}`),
    ).not.toBeInTheDocument();
  });

  it("still renders the source-kind badge and provenance chrome reviewers depend on", () => {
    const source = mkSource({
      id: "src-fed-ro-2",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
      provider: "fema:fema-flood (FEMA NFHL)",
      createdAt: new Date(Date.now() - 60 * 1000).toISOString(),
    });
    renderRow(source, "eng-1", { readOnly: true });
    expect(
      screen.getByTestId(`briefing-source-kind-badge-${source.id}`).textContent,
    ).toBe("Federal adapter");
    expect(
      screen.getByTestId(`briefing-source-last-refreshed-${source.id}`),
    ).toBeInTheDocument();
  });
});
