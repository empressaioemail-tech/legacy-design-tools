/**
 * BriefingSourceHistoryPanel (lib/portal-ui).
 *
 * Pins the lifted shared per-layer history disclosure that the
 * architect (design-tools) and reviewer (plan-review) surfaces both
 * render. Coverage exercises:
 *
 *   - the empty + populated branches and the layerKind / source-kind
 *     badge / "by Generate Layers" actor stamp on each prior card
 *     (Task #178);
 *   - per-tier filter pills with counts, date ranges, and the
 *     stale-flag amber treatment (Tasks #184, #195, #202, follow-up
 *     stale-pill);
 *   - the "Changed: …" hint + reveal that lists per-field metadata
 *     diffs and per-key federal / state / local payload deltas
 *     (Tasks #185, #200, #211, #223, #224);
 *   - the per-engagement persisted tier filter + cross-panel sync
 *     via the localStorage / CustomEvent bridge (Tasks #196, #206);
 *   - the `readOnly` flag suppressing the "Restore this version"
 *     mutate affordance on every prior card without dropping the
 *     prior cards themselves (Task #316).
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

const { BriefingSourceHistoryPanel } = await import(
  "../BriefingSourceHistoryPanel"
);
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
  // Structured producer payload — adapter rows write the raw
  // `AdapterResult.payload` (a `{ kind, ... }` blob whose shape
  // depends on the adapter), manual-upload rows default to `{}`.
  // Tests that exercise the per-tier payload diff seed this with a
  // `flood-zone` / `elevation-point` / `parcel` / etc. shape.
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

function renderPanel(opts: {
  engagementId?: string;
  layerKind?: string;
  currentSourceId?: string;
  readOnly?: boolean;
}) {
  const client = makeQueryClient();
  const node: ReactNode = (
    <QueryClientProvider client={client}>
      <BriefingSourceHistoryPanel
        engagementId={opts.engagementId ?? "eng-1"}
        layerKind={opts.layerKind ?? "fema-flood"}
        currentSourceId={opts.currentSourceId ?? "src-current"}
        panelId="briefing-source-history-src-current"
        readOnly={opts.readOnly}
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

describe("BriefingSourceHistoryPanel — empty + populated rows (Task #178)", () => {
  it("renders the empty-history copy when only the current source exists", () => {
    hoisted.historySources = [
      mkSource({
        id: "src-current",
        layerKind: "fema-flood",
        sourceKind: "federal-adapter",
      }),
    ];
    renderPanel({});
    expect(
      screen.getByText(/No prior versions of this layer/i),
    ).toBeInTheDocument();
  });

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
});

describe("BriefingSourceHistoryPanel — per-tier filter (Tasks #184, #195, #202)", () => {
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
});

describe("BriefingSourceHistoryPanel — 'Changed: …' hint + reveal (Tasks #185, #200, #211, #223, #224)", () => {
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
      id: "src-prior-payload",
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

    const hint = screen.getByTestId(
      `briefing-source-history-row-changed-${prior.id}`,
    );
    fireEvent.click(hint);

    const subsection = screen.getByTestId(
      `briefing-source-history-row-payload-changes-${prior.id}`,
    );
    expect(within(subsection).getByText(/Payload changes/i)).toBeInTheDocument();

    // Per-key before/after pins: every moved key should produce a row
    // with the same labels the inline summary chip uses.
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

  it("reveals a 'Payload changes' subsection for a state-adapter (UGRC parcels) rerun (Task #223)", () => {
    // UGRC parcel rerun: the parcel polygon was redrawn so PARCEL_ID
    // stayed put but ACRES moved (county re-survey). Both rows are
    // tagged `state-adapter` so the diff routes through
    // `diffStatePayload` rather than the federal helper.
    const current = mkSource({
      id: "src-current",
      layerKind: "ugrc-parcels",
      sourceKind: "state-adapter",
      provider: "Utah Geospatial Resource Center (UGRC)",
      note: "Auto-fetched by Generate Layers.",
      snapshotDate: "2026-04-15T00:00:00.000Z",
      payload: {
        kind: "parcel",
        parcel: { attributes: { PARCEL_ID: "01-12345", ACRES: 0.5 } },
      },
    });
    const prior = mkSource({
      id: "src-prior-ugrc",
      layerKind: "ugrc-parcels",
      sourceKind: "state-adapter",
      provider: "Utah Geospatial Resource Center (UGRC)",
      note: "Auto-fetched by Generate Layers.",
      snapshotDate: "2026-01-01T00:00:00.000Z",
      payload: {
        kind: "parcel",
        parcel: { attributes: { PARCEL_ID: "01-12345", ACRES: 0.42 } },
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
    // Hint pulls in the snapshotDate metadata move + the Acres
    // payload label so a payload-only rerun (snapshotDate unchanged
    // but the polygon shifted) would still surface in the chip.
    expect(hint.textContent).toContain("snapshotDate");
    expect(hint.textContent).toContain("Acres");
    // PARCEL_ID didn't move so its label shouldn't leak in.
    expect(hint.textContent).not.toContain("Parcel ID");

    fireEvent.click(hint);

    const subsection = screen.getByTestId(
      `briefing-source-history-row-payload-changes-${prior.id}`,
    );
    expect(within(subsection).getByText(/Payload changes/i)).toBeInTheDocument();

    // Acres moved with the same chip-formatting (formatAcres) as the
    // inline summary chip — 0.42 stays "0.42 ac", 0.5 collapses to
    // "0.5 ac".
    expect(
      screen.getByTestId(
        `briefing-source-history-row-payload-before-parcelAcres-${prior.id}`,
      ).textContent,
    ).toBe("0.42 ac");
    expect(
      screen.getByTestId(
        `briefing-source-history-row-payload-after-parcelAcres-${prior.id}`,
      ).textContent,
    ).toBe("0.5 ac");

    // PARCEL_ID stayed identical — its row must not be in the reveal
    // (otherwise an architect would have to re-read the same value
    // on both sides for no benefit).
    expect(
      screen.queryByTestId(
        `briefing-source-history-row-payload-before-parcelId-${prior.id}`,
      ),
    ).not.toBeInTheDocument();
  });

  it("reveals a 'Payload changes' subsection for a local-adapter (Bastrop floodplain) rerun (Task #223)", () => {
    // Bastrop floodplain rerun: the parcel was redesignated into a
    // mapped FEMA floodplain (Zone AE) between runs. Both rows are
    // tagged `local-adapter` so the diff routes through
    // `diffLocalPayload`. snapshotDate stays put — this is a
    // payload-only move, exercising the case where the metadata
    // diff alone wouldn't open the reveal.
    const sharedSnapshot = "2026-04-15T00:00:00.000Z";
    const current = mkSource({
      id: "src-current",
      layerKind: "bastrop-tx-floodplain",
      sourceKind: "local-adapter",
      provider: "Bastrop County, TX GIS (FEMA-derived floodplain)",
      note: "Auto-fetched by Generate Layers.",
      snapshotDate: sharedSnapshot,
      payload: {
        kind: "floodplain",
        inMappedFloodplain: true,
        features: [{ attributes: { FLD_ZONE: "AE" } }],
      },
    });
    const prior = mkSource({
      id: "src-prior-bastrop",
      layerKind: "bastrop-tx-floodplain",
      sourceKind: "local-adapter",
      provider: "Bastrop County, TX GIS (FEMA-derived floodplain)",
      note: "Auto-fetched by Generate Layers.",
      snapshotDate: sharedSnapshot,
      payload: {
        kind: "floodplain",
        inMappedFloodplain: false,
        features: [],
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
    // Metadata didn't move — the hint must still appear because the
    // payload diff surfaced two real changes.
    expect(hint.textContent).not.toContain("snapshotDate");
    expect(hint.textContent).toContain("In floodplain");
    expect(hint.textContent).toContain("Flood zone");

    fireEvent.click(hint);

    expect(
      screen.getByTestId(
        `briefing-source-history-row-payload-before-inMappedFloodplain-${prior.id}`,
      ).textContent,
    ).toBe("No");
    expect(
      screen.getByTestId(
        `briefing-source-history-row-payload-after-inMappedFloodplain-${prior.id}`,
      ).textContent,
    ).toBe("Yes");
    expect(
      screen.getByTestId(
        `briefing-source-history-row-payload-before-floodZone-${prior.id}`,
      ).textContent,
    ).toBe("(none)");
    expect(
      screen.getByTestId(
        `briefing-source-history-row-payload-after-floodZone-${prior.id}`,
      ).textContent,
    ).toBe("AE");
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
});

describe("BriefingSourceHistoryPanel — persisted tier filter + cross-panel sync (Tasks #196, #206)", () => {
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
});

describe("BriefingSourceHistoryPanel — readOnly mode (Task #316)", () => {
  it("hides the 'Restore this version' affordance on each prior-version card", () => {
    hoisted.historySources = [
      mkSource({
        id: "src-current",
        layerKind: "fema-flood",
        sourceKind: "federal-adapter",
        createdAt: "2026-02-01T00:00:00.000Z",
      }),
      mkSource({
        id: "src-prior-1",
        layerKind: "fema-flood",
        sourceKind: "federal-adapter",
        createdAt: "2026-01-15T00:00:00.000Z",
        supersededAt: "2026-02-01T00:00:00.000Z",
        supersededById: "src-current",
      }),
    ];
    renderPanel({ readOnly: true });
    // The prior card itself still mounts so reviewers see the
    // version + divergence chrome.
    expect(
      screen.getByTestId("briefing-source-history-row-src-prior-1"),
    ).toBeInTheDocument();
    // …but the mutate button is suppressed.
    expect(
      screen.queryByTestId("briefing-source-restore-src-prior-1"),
    ).not.toBeInTheDocument();
  });

  it("still renders the 'Restore this version' affordance when readOnly is omitted (architect default)", () => {
    hoisted.historySources = [
      mkSource({
        id: "src-current",
        layerKind: "fema-flood",
        sourceKind: "federal-adapter",
        createdAt: "2026-02-01T00:00:00.000Z",
      }),
      mkSource({
        id: "src-prior-1",
        layerKind: "fema-flood",
        sourceKind: "federal-adapter",
        createdAt: "2026-01-15T00:00:00.000Z",
        supersededAt: "2026-02-01T00:00:00.000Z",
        supersededById: "src-current",
      }),
    ];
    renderPanel({});
    expect(
      screen.getByTestId("briefing-source-restore-src-prior-1"),
    ).toBeInTheDocument();
  });
});
