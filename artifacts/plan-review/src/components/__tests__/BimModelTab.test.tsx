/**
 * BimModelTab — Plan Review reviewer surface for the bim-model +
 * briefing divergences feedback loop (Wave 2 Sprint B / Task #306).
 *
 * Covers the seven behaviors the reviewer relies on:
 *
 *   1. Loading state renders before the bim-model query resolves.
 *   2. Empty state renders when the engagement has no bim-model
 *      yet (the architect hasn't pushed to Revit) — the divergences
 *      panel is *not* mounted in that case.
 *   3. Divergences panel mounts once the bim-model exists and
 *      shows recorded overrides grouped by element with the
 *      reviewer-side "View details" button on each row (and no
 *      Resolve button, which is the architect-only affordance).
 *   4. Clicking "View details" opens the per-divergence drill-in
 *      dialog with the briefing-vs-Revit diff table populated from
 *      the row's `detail.before` / `detail.after` envelope.
 *   5. Closing the dialog returns focus to the panel and the
 *      drill-in unmounts.
 *   6. BIM model summary card renders the refresh status badge,
 *      briefing version, and Revit document path so the reviewer
 *      can frame the divergences against the model's freshness.
 *   7. Materializable-element list groups elements by kind in the
 *      canonical Spec 51a §2.4 order with per-row locked badges,
 *      and falls back to a hint when the briefing has not produced
 *      any elements yet.
 *
 * The bim-model + divergences endpoints are mocked at the
 * `@workspace/api-client-react` boundary so the test exercises the
 * real component composition (BimModelTab → portal-ui's
 * BriefingDivergencesPanel → BriefingDivergenceRow + drill-in
 * dialog) without crossing the network. Mocks return shape-faithful
 * values matching the OpenAPI contract.
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
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

interface FakeDivergence {
  id: string;
  bimModelId: string;
  materializableElementId: string | null;
  elementKind: string | null;
  elementLabel: string | null;
  reason: "geometry-edited" | "unpinned" | "deleted" | "other";
  detail: Record<string, unknown>;
  note: string | null;
  resolvedAt: string | null;
  resolvedByRequestor: {
    kind: "user" | "agent";
    id: string;
    displayName: string | null;
    avatarUrl: string | null;
  } | null;
  createdAt: string;
}

const hoisted = vi.hoisted(() => {
  return {
    bimModel: null as null | {
      id: string;
      engagementId: string;
      activeBriefingId: string | null;
      briefingVersion: number;
      materializedAt: string | null;
      revitDocumentPath: string | null;
      refreshStatus: "current" | "stale" | "not-pushed";
      elements: Array<unknown>;
      createdAt: string;
      updatedAt: string;
    },
    divergences: [] as FakeDivergence[],
    bimModelLoading: false,
  };
});

vi.mock("@workspace/api-client-react", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  return {
    getGetEngagementBimModelQueryKey: (id: string) => [
      "getEngagementBimModel",
      id,
    ],
    getListBimModelDivergencesQueryKey: (id: string) => [
      "listBimModelDivergences",
      id,
    ],
    useGetEngagementBimModel: (
      engagementId: string,
      opts?: { query?: { queryKey?: readonly unknown[] } },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ??
          (["getEngagementBimModel", engagementId] as const),
        queryFn: async () => {
          if (hoisted.bimModelLoading) {
            await new Promise((r) => setTimeout(r, 1000));
          }
          return { bimModel: hoisted.bimModel };
        },
      }),
    useListBimModelDivergences: (
      bimModelId: string,
      opts?: { query?: { queryKey?: readonly unknown[]; enabled?: boolean } },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ??
          (["listBimModelDivergences", bimModelId] as const),
        queryFn: async () => ({
          divergences: hoisted.divergences.map((d) => ({ ...d })),
        }),
        enabled: opts?.query?.enabled ?? true,
      }),
    // Architect-side resolve hook — mocked but should NEVER be invoked
    // from the reviewer surface, the test asserts the Resolve button
    // is absent. Guarded with a vi.fn so an accidental wire-up would
    // fail the test by throwing on the spy assertion below.
    useResolveBimModelDivergence: () => ({
      mutate: vi.fn(() => {
        throw new Error(
          "useResolveBimModelDivergence must not be called from the " +
            "reviewer-side BimModelTab — it has no Resolve button.",
        );
      }),
      isPending: false,
      isError: false,
    }),
    // Task #409 — BimModelTab now resolves the session reviewer
    // id via `useSessionUserId` to scope the BIM gesture-legend
    // graduation flag per user. The tab's existing assertions
    // don't care which user is in play, so we return an empty
    // session (no requestor) → the viewport falls back to its
    // shared anonymous bucket, matching the pre-#409 behaviour.
    getGetSessionQueryKey: () => ["getSession"] as const,
    useGetSession: (opts?: { query?: { queryKey?: readonly unknown[] } }) =>
      useQuery({
        queryKey: opts?.query?.queryKey ?? (["getSession"] as const),
        queryFn: async () => ({ audience: "reviewer", permissions: [] }),
      }),
  };
});

const { BimModelTab } = await import("../BimModelTab");

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderTab(
  engagementId = "eng-1",
  extraProps: {
    highlightToken?: { ref: string; nonce: number } | null;
  } = {},
) {
  const client = makeQueryClient();
  const node: ReactNode = (
    <QueryClientProvider client={client}>
      <BimModelTab engagementId={engagementId} {...extraProps} />
    </QueryClientProvider>
  );
  return render(node);
}

function makeDivergence(
  overrides: Partial<FakeDivergence> & { id: string },
): FakeDivergence {
  return {
    bimModelId: "bm-1",
    materializableElementId: "elem-1",
    elementKind: "terrain",
    elementLabel: "Site terrain",
    reason: "geometry-edited",
    detail: {},
    note: null,
    resolvedAt: null,
    resolvedByRequestor: null,
    createdAt: "2026-04-01T10:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  hoisted.bimModel = null;
  hoisted.divergences = [];
  hoisted.bimModelLoading = false;
});

afterEach(() => {
  cleanup();
});

describe("BimModelTab — Plan Review (Task #306)", () => {
  it("renders the loading hint while the bim-model query is in flight", async () => {
    hoisted.bimModelLoading = true;
    renderTab();
    expect(
      await screen.findByTestId("bim-model-tab-loading"),
    ).toBeInTheDocument();
  });

  it("renders the empty-state explanation when no bim-model has been pushed yet", async () => {
    hoisted.bimModel = null;
    renderTab();
    expect(
      await screen.findByTestId("bim-model-tab-empty"),
    ).toBeInTheDocument();
    // No divergences panel should mount in the empty state.
    expect(screen.queryByTestId("briefing-divergences-panel")).toBeNull();
  });

  it("mounts the divergences panel and surfaces 'View details' (no Resolve) per row", async () => {
    hoisted.bimModel = {
      id: "bm-1",
      engagementId: "eng-1",
      activeBriefingId: "br-1",
      briefingVersion: 1,
      materializedAt: "2026-04-01T09:00:00.000Z",
      revitDocumentPath: null,
      refreshStatus: "current",
      elements: [],
      createdAt: "2026-04-01T09:00:00.000Z",
      updatedAt: "2026-04-01T09:00:00.000Z",
    };
    hoisted.divergences = [
      makeDivergence({
        id: "div-1",
        detail: {
          before: { area: 100, height: 12 },
          after: { area: 110, height: 14 },
          revitElementId: 9876,
        },
      }),
    ];
    renderTab();

    // Tab shell is present.
    expect(await screen.findByTestId("bim-model-tab")).toBeInTheDocument();
    // Reviewer-side "View details" button is rendered for the open row.
    const viewBtn = await screen.findByTestId(
      "briefing-divergences-view-details-button",
    );
    expect(viewBtn).toHaveAttribute("data-divergence-id", "div-1");
    // Architect-only Resolve button must NOT appear on the reviewer
    // surface — locks in the read-only contract for Sprint B.
    expect(
      screen.queryByTestId("briefing-divergences-resolve-button"),
    ).toBeNull();
  });

  it("opens the per-divergence drill-in dialog with a populated diff table", async () => {
    hoisted.bimModel = {
      id: "bm-1",
      engagementId: "eng-1",
      activeBriefingId: "br-1",
      briefingVersion: 1,
      materializedAt: "2026-04-01T09:00:00.000Z",
      revitDocumentPath: null,
      refreshStatus: "current",
      elements: [],
      createdAt: "2026-04-01T09:00:00.000Z",
      updatedAt: "2026-04-01T09:00:00.000Z",
    };
    hoisted.divergences = [
      makeDivergence({
        id: "div-1",
        elementLabel: "North wall",
        detail: {
          before: { area: 100, height: 12 },
          after: { area: 110, height: 14 },
          revitElementId: 9876,
        },
      }),
    ];
    renderTab();

    fireEvent.click(
      await screen.findByTestId("briefing-divergences-view-details-button"),
    );

    const dialog = await screen.findByTestId(
      "briefing-divergence-detail-dialog",
    );
    expect(dialog).toBeInTheDocument();

    // Diff table renders one row per before/after field.
    const diffRows = within(dialog).getAllByTestId(
      "briefing-divergence-detail-diff-row",
    );
    const fields = diffRows.map((r) => r.getAttribute("data-field")).sort();
    expect(fields).toEqual(["area", "height"]);

    // Flat-attributes table picks up forward-compat fields the
    // recorder attaches outside the before/after envelope (e.g.
    // `revitElementId`).
    const attrRows = within(dialog).getAllByTestId(
      "briefing-divergence-detail-attribute-row",
    );
    const attrFields = attrRows.map((r) => r.getAttribute("data-field"));
    expect(attrFields).toContain("revitElementId");

    // Element label flows from the row to the dialog title block.
    expect(within(dialog).getByText("North wall")).toBeInTheDocument();
  });

  it("groups materializable elements by kind in canonical order with per-row locked badges", async () => {
    hoisted.bimModel = {
      id: "bm-1",
      engagementId: "eng-1",
      activeBriefingId: "br-1",
      briefingVersion: 1,
      materializedAt: "2026-04-01T09:00:00.000Z",
      revitDocumentPath: null,
      refreshStatus: "current",
      // Insertion order intentionally NOT canonical — the
      // component must re-sort into the Spec 51a order
      // (terrain → property-line → setback-plane → ...).
      elements: [
        {
          id: "el-floodplain",
          briefingId: "br-1",
          elementKind: "floodplain",
          briefingSourceId: null,
          label: "FEMA Zone AE",
          geometry: {},
          glbObjectPath: null,
          locked: false,
          createdAt: "2026-04-01T09:00:00.000Z",
          updatedAt: "2026-04-01T09:00:00.000Z",
        },
        {
          id: "el-terrain",
          briefingId: "br-1",
          elementKind: "terrain",
          briefingSourceId: null,
          label: "Site terrain",
          geometry: {},
          glbObjectPath: null,
          locked: true,
          createdAt: "2026-04-01T09:00:00.000Z",
          updatedAt: "2026-04-01T09:00:00.000Z",
        },
        {
          id: "el-setback-1",
          briefingId: "br-1",
          elementKind: "setback-plane",
          briefingSourceId: null,
          label: "Front setback",
          geometry: {},
          glbObjectPath: null,
          locked: true,
          createdAt: "2026-04-01T09:00:00.000Z",
          updatedAt: "2026-04-01T09:00:00.000Z",
        },
        {
          id: "el-setback-2",
          briefingId: "br-1",
          elementKind: "setback-plane",
          briefingSourceId: null,
          label: "Rear setback",
          geometry: {},
          glbObjectPath: null,
          locked: true,
          createdAt: "2026-04-01T09:00:00.000Z",
          updatedAt: "2026-04-01T09:00:00.000Z",
        },
      ] as never,
      createdAt: "2026-04-01T09:00:00.000Z",
      updatedAt: "2026-04-01T09:00:00.000Z",
    };
    hoisted.divergences = [];
    renderTab();

    const list = await screen.findByTestId("bim-model-elements-list");
    expect(list).toBeInTheDocument();

    const groups = within(list).getAllByTestId("bim-model-elements-group");
    expect(groups.map((g) => g.getAttribute("data-kind"))).toEqual([
      "terrain",
      "setback-plane",
      "floodplain",
    ]);

    // Setback group has 2 rows and shows the count chip.
    const setbackGroup = groups.find(
      (g) => g.getAttribute("data-kind") === "setback-plane",
    )!;
    expect(
      within(setbackGroup).getByTestId("bim-model-elements-group-count")
        .textContent,
    ).toBe("2 elements");
    expect(within(setbackGroup).getAllByTestId("bim-model-elements-row")).toHaveLength(2);

    // Locked terrain element surfaces the read-only Locked badge.
    const terrainGroup = groups.find(
      (g) => g.getAttribute("data-kind") === "terrain",
    )!;
    expect(
      within(terrainGroup).getByTestId("bim-model-elements-row-locked"),
    ).toBeInTheDocument();

    // Floodplain (unlocked) has no Locked badge.
    const floodGroup = groups.find(
      (g) => g.getAttribute("data-kind") === "floodplain",
    )!;
    expect(
      within(floodGroup).queryByTestId("bim-model-elements-row-locked"),
    ).toBeNull();
  });

  it("renders an empty-state hint when the briefing has not produced any elements yet", async () => {
    hoisted.bimModel = {
      id: "bm-1",
      engagementId: "eng-1",
      activeBriefingId: "br-1",
      briefingVersion: 0,
      materializedAt: null,
      revitDocumentPath: null,
      refreshStatus: "not-pushed",
      elements: [],
      createdAt: "2026-04-01T09:00:00.000Z",
      updatedAt: "2026-04-01T09:00:00.000Z",
    };
    hoisted.divergences = [];
    renderTab();

    expect(
      await screen.findByTestId("bim-model-elements-list-empty"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("bim-model-elements-group"),
    ).toBeNull();
  });

  it("renders the BIM model summary card with refresh status, briefing version, and Revit document", async () => {
    hoisted.bimModel = {
      id: "bm-1",
      engagementId: "eng-1",
      activeBriefingId: "br-1",
      briefingVersion: 4,
      materializedAt: "2026-04-01T09:00:00.000Z",
      revitDocumentPath: "C:/Projects/north-tower.rvt",
      refreshStatus: "stale",
      elements: [],
      createdAt: "2026-04-01T09:00:00.000Z",
      updatedAt: "2026-04-01T09:00:00.000Z",
    };
    hoisted.divergences = [];
    renderTab();

    const card = await screen.findByTestId("bim-model-summary-card");
    expect(card).toBeInTheDocument();

    // Refresh status badge surfaces the freshness signal so the
    // reviewer doesn't read divergences against a stale model
    // without realising it.
    const status = within(card).getByTestId(
      "bim-model-summary-refresh-status",
    );
    expect(status).toHaveAttribute("data-status", "stale");
    expect(status.textContent).toContain("Stale");

    // Briefing version pinned to the model is visible at a glance.
    expect(
      within(card).getByTestId("bim-model-summary-briefing-version").textContent,
    ).toBe("v4");

    // Revit document path renders verbatim when present.
    expect(
      within(card).getByTestId("bim-model-summary-revit-document").textContent,
    ).toBe("C:/Projects/north-tower.rvt");
  });

  // Task #343 — when a reviewer clicks "Show in 3D viewer" on a
  // finding, the SubmissionDetailModal switches to this tab and
  // threads the finding's `elementRef` down. The materializable-
  // elements list is responsible for resolving that ref to a row,
  // scrolling it into view, applying a brief visual highlight,
  // announcing the jump in an aria-live region, and signalling
  // back via `onHighlightConsumed` so a re-click on the same
  // finding re-fires the animation.
  describe("Show-in-3D-viewer cross-tab jump (Task #343)", () => {
    const baseModelWithElements = {
      id: "bm-1",
      engagementId: "eng-1",
      activeBriefingId: "br-1",
      briefingVersion: 1,
      materializedAt: "2026-04-01T09:00:00.000Z",
      revitDocumentPath: null,
      refreshStatus: "current" as const,
      elements: [
        {
          id: "el-terrain",
          briefingId: "br-1",
          elementKind: "terrain" as const,
          briefingSourceId: null,
          label: "Site terrain",
          geometry: {},
          glbObjectPath: null,
          locked: true,
          createdAt: "2026-04-01T09:00:00.000Z",
          updatedAt: "2026-04-01T09:00:00.000Z",
        },
        {
          // Server-side id intentionally ends with the hyphenated
          // tail of the AI-emitted ref `wall:north-side-l2` so the
          // trailing-segment matcher exercises the
          // `id.endsWith(tail)` branch.
          id: "el-wall-north-side-l2",
          briefingId: "br-1",
          elementKind: "setback-plane" as const,
          briefingSourceId: null,
          label: "North side L2",
          geometry: {},
          glbObjectPath: null,
          locked: false,
          createdAt: "2026-04-01T09:00:00.000Z",
          updatedAt: "2026-04-01T09:00:00.000Z",
        },
      ] as never,
      createdAt: "2026-04-01T09:00:00.000Z",
      updatedAt: "2026-04-01T09:00:00.000Z",
    };

    let scrollSpy: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      // JSDOM does not implement scrollIntoView; stub it so the
      // pulse side-effect doesn't throw and we can assert the
      // matched row was the one targeted. We DO NOT enable fake
      // timers here because react-query schedules its own
      // setTimeout-driven cache work and freezing the clock at
      // mount time wedges the bim-model query in its loading
      // state. The single test that needs a clock advance opts
      // into fake timers locally, after the data has rendered.
      scrollSpy = vi.fn();
      Object.defineProperty(Element.prototype, "scrollIntoView", {
        value: scrollSpy,
        writable: true,
        configurable: true,
      });
    });

    it("highlights the matched row, scrolls to it, and announces the jump for screen readers", async () => {
      hoisted.bimModel = baseModelWithElements;
      hoisted.divergences = [];
      const { rerender } = renderTab("eng-1", { highlightToken: null });

      // The list mounts; the announcer is empty until a jump fires.
      const announcer = await screen.findByTestId(
        "bim-model-elements-announcer",
      );
      expect(announcer.textContent).toBe("");
      expect(announcer.getAttribute("aria-live")).toBe("polite");
      expect(announcer.getAttribute("role")).toBe("status");

      // Trigger the jump with the exact server-side element id.
      rerender(
        <QueryClientProvider client={makeQueryClient()}>
          <BimModelTab
            engagementId="eng-1"
            highlightToken={{ ref: "el-wall-north-side-l2", nonce: 1 }}
          />
        </QueryClientProvider>,
      );

      const rows = await screen.findAllByTestId("bim-model-elements-row");
      const matched = rows.find(
        (r) => r.getAttribute("data-element-id") === "el-wall-north-side-l2",
      )!;
      const other = rows.find(
        (r) => r.getAttribute("data-element-id") === "el-terrain",
      )!;
      expect(matched.getAttribute("data-highlighted")).toBe("true");
      expect(other.getAttribute("data-highlighted")).toBe("false");

      // Scroll-into-view fired on the matched row only.
      expect(scrollSpy).toHaveBeenCalledTimes(1);
      expect(scrollSpy.mock.instances[0]).toBe(matched);

      // Announcer renders a sentence naming the focused element.
      expect(
        screen.getByTestId("bim-model-elements-announcer").textContent,
      ).toContain("North side L2");

      // No "no-match" warning is shown when we resolved the ref.
      expect(
        screen.queryByTestId("bim-model-elements-no-match"),
      ).toBeNull();
    });

    it("falls back to the trailing-segment matcher for AI-style refs like wall:north-side-l2", async () => {
      hoisted.bimModel = baseModelWithElements;
      hoisted.divergences = [];
      renderTab("eng-1", {
        highlightToken: { ref: "wall:north-side-l2", nonce: 1 },
      });
      const rows = await screen.findAllByTestId("bim-model-elements-row");
      const matched = rows.find(
        (r) => r.getAttribute("data-element-id") === "el-wall-north-side-l2",
      )!;
      expect(matched.getAttribute("data-highlighted")).toBe("true");
      expect(
        screen.queryByTestId("bim-model-elements-no-match"),
      ).toBeNull();
    });

    it("renders a no-match warning + SR announcement when the elementRef does not resolve", async () => {
      hoisted.bimModel = baseModelWithElements;
      hoisted.divergences = [];
      renderTab("eng-1", {
        highlightToken: { ref: "window:bedroom-2-egress", nonce: 1 },
      });
      const warn = await screen.findByTestId("bim-model-elements-no-match");
      expect(warn.textContent).toContain("window:bedroom-2-egress");
      expect(
        screen.getByTestId("bim-model-elements-announcer").textContent,
      ).toContain("not present in the current BIM model");
      // Nothing is highlighted in the no-match case.
      const rows = screen.getAllByTestId("bim-model-elements-row");
      for (const r of rows) {
        expect(r.getAttribute("data-highlighted")).toBe("false");
      }
    });

    // Task #371 — a re-click of the SAME finding bumps the token's
    // nonce while leaving the ref unchanged. The highlight effect
    // must observe that and re-fire (re-scrolling the matched row
    // into view) rather than treating the prop as unchanged. This
    // replaces the previous `onHighlightConsumed` + 2.5s-timer
    // dance: there is no clear-and-refire phase, the nonce alone
    // re-triggers the effect deterministically.
    it("re-runs the highlight effect when the nonce changes even if the ref is unchanged", async () => {
      hoisted.bimModel = baseModelWithElements;
      hoisted.divergences = [];
      const { rerender } = renderTab("eng-1", {
        highlightToken: { ref: "el-wall-north-side-l2", nonce: 1 },
      });

      // First render: the matched row is highlighted and scrolled
      // into view exactly once.
      await screen.findAllByTestId("bim-model-elements-row");
      expect(scrollSpy).toHaveBeenCalledTimes(1);

      // Re-render with the SAME ref but a NEW nonce — the effect
      // must observe the new token object and re-fire scrollIntoView
      // (the equivalent of the reviewer clicking "Show in 3D viewer"
      // on the same finding a second time).
      rerender(
        <QueryClientProvider client={makeQueryClient()}>
          <BimModelTab
            engagementId="eng-1"
            highlightToken={{ ref: "el-wall-north-side-l2", nonce: 2 }}
          />
        </QueryClientProvider>,
      );
      await waitFor(() => {
        expect(scrollSpy).toHaveBeenCalledTimes(2);
      });

      // Row remains highlighted across the re-fire — the highlight
      // outline isn't a wall-clock pulse, it stays applied as long
      // as the modal holds the token.
      const rows = await screen.findAllByTestId("bim-model-elements-row");
      const matched = rows.find(
        (r) => r.getAttribute("data-element-id") === "el-wall-north-side-l2",
      )!;
      expect(matched.getAttribute("data-highlighted")).toBe("true");
    });
  });

  it("closes the drill-in dialog when the Close button is clicked", async () => {
    hoisted.bimModel = {
      id: "bm-1",
      engagementId: "eng-1",
      activeBriefingId: "br-1",
      briefingVersion: 1,
      materializedAt: "2026-04-01T09:00:00.000Z",
      revitDocumentPath: null,
      refreshStatus: "current",
      elements: [],
      createdAt: "2026-04-01T09:00:00.000Z",
      updatedAt: "2026-04-01T09:00:00.000Z",
    };
    hoisted.divergences = [makeDivergence({ id: "div-1" })];
    renderTab();

    fireEvent.click(
      await screen.findByTestId("briefing-divergences-view-details-button"),
    );
    expect(
      await screen.findByTestId("briefing-divergence-detail-dialog"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("briefing-divergence-detail-close"));
    expect(
      screen.queryByTestId("briefing-divergence-detail-dialog"),
    ).toBeNull();
  });
});
