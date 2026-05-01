/**
 * BriefingDivergencesPanel + PushToRevitAffordance — frontend
 * regression coverage for the "Architect overrides in Revit" panel
 * shipped by Task #172 on the Site Context tab of the design-tools
 * EngagementDetail page.
 *
 * The api-server side is already covered by
 * `artifacts/api-server/src/__tests__/bim-models.test.ts` (4 cases).
 * This file mirrors that shape on the UI side so the four behaviors
 * the panel owns can't regress quietly:
 *
 *   1. Empty list → renders the "No overrides recorded yet…" empty
 *      state copy.
 *   2. Multiple divergences for the same materializable element
 *      collapse into one group, with rows in newest-first order
 *      (matches the server's order; the panel must not re-sort).
 *   3. Reason badge palette: deleted → danger, unpinned and
 *      geometry-edited → warning, other → info. Asserted via the
 *      `data-divergence-reason` attribute the row exposes for tests.
 *   4. After a successful Push-to-Revit mutation the divergences
 *      query is invalidated. We capture the mutation hook's options
 *      so the test can fire `onSuccess` directly and spy on the
 *      `QueryClient.invalidateQueries` call — same pattern the
 *      Task #126 banner test uses for `useCreateEngagementSubmission`.
 *
 * The test mounts the two components directly rather than the full
 * `EngagementDetail` page so we avoid wiring 10+ unrelated query
 * hooks (briefing sources, atom history, snapshots, …) just to
 * exercise the divergences panel. The two components are
 * intentionally exported for this purpose alongside the existing
 * `BriefingSourceRow` / `BriefingSourceHistoryPanel` testing exports.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// ── Hoisted mock state ──────────────────────────────────────────────────
//
// Single-object reset target shared between the `vi.mock` factories
// and individual test bodies, mirroring the convention in
// EngagementDetail.test.tsx so the two surfaces stay easy to read
// side-by-side.
const hoisted = vi.hoisted(() => {
  return {
    bimModel: {
      id: "bim-1",
      engagementId: "eng-1",
      activeBriefingId: "brief-1",
      briefingVersion: 3,
      materializedAt: "2025-01-02T00:00:00.000Z" as string | null,
      revitDocumentPath: null as string | null,
      refreshStatus: "current" as
        | "current"
        | "stale"
        | "not-pushed",
      elements: [] as unknown[],
      createdAt: "2025-01-02T00:00:00.000Z",
      updatedAt: "2025-01-02T00:00:00.000Z",
    },
    divergences: [] as Array<{
      id: string;
      bimModelId: string;
      materializableElementId: string;
      briefingId: string;
      reason: "unpinned" | "geometry-edited" | "deleted" | "other";
      note: string | null;
      detail: Record<string, unknown>;
      createdAt: string;
      elementKind: string | null;
      elementLabel: string | null;
    }>,
    divergencesQueryState: {
      isLoading: false,
      isError: false,
    },
    refresh: {
      bimModelId: "bim-1",
      briefingId: "brief-1",
      briefingVersion: 3,
      materializedAt: "2025-01-02T00:00:00.000Z",
      refreshStatus: "current" as "current" | "stale" | "not-pushed",
      diff: {
        addedCount: 0,
        modifiedCount: 0,
        unchangedCount: 0,
        elements: [] as unknown[],
      },
    } as unknown,
    capturedPushOptions: null as null | {
      mutation?: {
        onSuccess?: (
          data: unknown,
          variables: unknown,
          context: unknown,
        ) => Promise<void> | void;
      };
    },
    pushMutate: vi.fn(),
    pushIsPending: false,
    pushIsError: false,
  };
});

// Stub `SiteMap` so leaflet's CSS + image asset side effects don't
// have to load under happy-dom. The component is never mounted by
// these tests (we render the divergences / push affordance
// directly), but the symbol is pulled in transitively by
// `EngagementDetail.tsx` when we import the panel from it.
vi.mock("@workspace/site-context/client", () => ({
  SiteMap: () => null,
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  // Import the real module and override only the four hooks the
  // panel + push affordance touch. Keeping the rest of the surface
  // intact avoids redefining the dozens of unrelated symbols
  // EngagementDetail.tsx and its components transitively pull in
  // (e.g. `RecordSubmissionResponseBodyStatus`,
  // `getGetEngagementBriefingQueryKey`, generated request helpers).
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  const { useQuery } = await import("@tanstack/react-query");
  return {
    ...actual,
    // Override the query-key helpers with stable arrays so the
    // panel's `invalidateQueries` calls match what we seed into
    // the QueryClient cache below — the real helpers prepend the
    // generated `/api/...` request URL which would force the test
    // to mirror the URL surface for no extra coverage.
    getGetEngagementBimModelQueryKey: (id: string) => [
      "getEngagementBimModel",
      id,
    ],
    getGetBimModelRefreshQueryKey: (id: string) => [
      "getBimModelRefresh",
      id,
    ],
    getListBimModelDivergencesQueryKey: (id: string) => [
      "listBimModelDivergences",
      id,
    ],
    useGetEngagementBimModel: (
      id: string,
      opts?: { query?: { queryKey?: readonly unknown[] } },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ?? (["getEngagementBimModel", id] as const),
        queryFn: async () => ({ bimModel: { ...hoisted.bimModel } }),
      }),
    useGetBimModelRefresh: (
      id: string,
      opts?: { query?: { enabled?: boolean; queryKey?: readonly unknown[] } },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ?? (["getBimModelRefresh", id] as const),
        queryFn: async () => hoisted.refresh,
        enabled: opts?.query?.enabled ?? true,
      }),
    useListBimModelDivergences: (
      id: string,
      opts?: {
        query?: {
          enabled?: boolean;
          queryKey?: readonly unknown[];
          staleTime?: number;
        };
      },
    ) => {
      // Drive the query through real `useQuery` so the panel
      // receives the same data / loading / error shape it would
      // in production.
      const q = useQuery({
        queryKey:
          opts?.query?.queryKey ?? (["listBimModelDivergences", id] as const),
        queryFn: async () => {
          if (hoisted.divergencesQueryState.isError) {
            throw new Error("simulated divergences error");
          }
          return { divergences: hoisted.divergences.map((d) => ({ ...d })) };
        },
        enabled: opts?.query?.enabled ?? true,
        staleTime: opts?.query?.staleTime,
      });
      // Honor the simulated loading flag so the loading-state
      // branch can be exercised without racing the real query.
      if (hoisted.divergencesQueryState.isLoading) {
        return { ...q, isLoading: true, data: undefined };
      }
      // Same pattern for isError: the panel pre-seeds the
      // divergences cache via `client.setQueryData`, which keeps
      // `queryFn` from ever running (and therefore from throwing).
      // A synchronous override lets the test assert the error
      // branch deterministically without racing a refetch.
      if (hoisted.divergencesQueryState.isError) {
        return {
          ...q,
          isError: true,
          isLoading: false,
          data: undefined,
          error: new Error("simulated divergences error"),
        };
      }
      return q;
    },
    usePushEngagementBimModel: (
      options: typeof hoisted.capturedPushOptions,
    ) => {
      hoisted.capturedPushOptions = options;
      return {
        mutate: hoisted.pushMutate,
        isPending: hoisted.pushIsPending,
        isError: hoisted.pushIsError,
      };
    },
  };
});

const { BriefingDivergencesPanel, PushToRevitAffordance } = await import(
  "../EngagementDetail"
);

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

/**
 * Mount the divergences panel under a real QueryClient and pre-seed
 * the bim-model + divergences caches so the panel renders fully on
 * first paint — no async `findBy*` polling required, mirroring the
 * EngagementDetail.test.tsx pattern.
 */
function renderPanel() {
  const client = makeQueryClient();
  client.setQueryData(["getEngagementBimModel", hoisted.bimModel.engagementId], {
    bimModel: { ...hoisted.bimModel },
  });
  client.setQueryData(
    ["listBimModelDivergences", hoisted.bimModel.id],
    { divergences: hoisted.divergences.map((d) => ({ ...d })) },
  );
  const node: ReactNode = (
    <QueryClientProvider client={client}>
      <BriefingDivergencesPanel engagementId={hoisted.bimModel.engagementId} />
    </QueryClientProvider>
  );
  const utils = render(node);
  return { ...utils, client };
}

/**
 * Mount the Push-to-Revit affordance alongside a real QueryClient
 * so the captured `onSuccess` can be fired against an
 * `invalidateQueries` spy — same shape as the Task #126 banner test
 * does for `useCreateEngagementSubmission`.
 */
function renderPushAffordance(opts: { hasBriefing?: boolean } = {}) {
  const hasBriefing = opts.hasBriefing ?? true;
  const client = makeQueryClient();
  client.setQueryData(["getEngagementBimModel", hoisted.bimModel.engagementId], {
    bimModel: { ...hoisted.bimModel },
  });
  client.setQueryData(
    ["getBimModelRefresh", hoisted.bimModel.id],
    hoisted.refresh,
  );
  client.setQueryData(
    ["listBimModelDivergences", hoisted.bimModel.id],
    { divergences: [] },
  );
  const invalidateSpy = vi.spyOn(client, "invalidateQueries");
  const node: ReactNode = (
    <QueryClientProvider client={client}>
      <PushToRevitAffordance
        engagementId={hoisted.bimModel.engagementId}
        hasBriefing={hasBriefing}
      />
    </QueryClientProvider>
  );
  const utils = render(node);
  return { ...utils, client, invalidateSpy };
}

beforeEach(() => {
  hoisted.bimModel = {
    id: "bim-1",
    engagementId: "eng-1",
    activeBriefingId: "brief-1",
    briefingVersion: 3,
    materializedAt: "2025-01-02T00:00:00.000Z",
    revitDocumentPath: null,
    refreshStatus: "current",
    elements: [],
    createdAt: "2025-01-02T00:00:00.000Z",
    updatedAt: "2025-01-02T00:00:00.000Z",
  };
  hoisted.divergences = [];
  hoisted.divergencesQueryState = { isLoading: false, isError: false };
  hoisted.refresh = {
    bimModelId: "bim-1",
    briefingId: "brief-1",
    briefingVersion: 3,
    materializedAt: "2025-01-02T00:00:00.000Z",
    refreshStatus: "current",
    diff: {
      addedCount: 0,
      modifiedCount: 0,
      unchangedCount: 0,
      elements: [],
    },
  };
  hoisted.capturedPushOptions = null;
  hoisted.pushMutate.mockReset();
  hoisted.pushIsPending = false;
  hoisted.pushIsError = false;
});

afterEach(() => {
  cleanup();
});

describe("BriefingDivergencesPanel (Task #172)", () => {
  it("renders the empty-state copy when no divergences have been recorded", () => {
    // Default beforeEach state: bim-model exists, zero divergences.
    renderPanel();

    const empty = screen.getByTestId("briefing-divergences-empty");
    expect(empty).toBeInTheDocument();
    expect(empty).toHaveTextContent(
      "No overrides recorded yet — the briefing matches what's in Revit.",
    );
    // Sanity: no group / row markers should be in the DOM at all.
    expect(
      screen.queryByTestId("briefing-divergences-list"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryAllByTestId("briefing-divergences-group"),
    ).toHaveLength(0);
  });

  it("collapses multiple divergences for the same element into one group, newest-first", () => {
    // Two rows for the same element, plus one for a different
    // element — the panel must merge the same-element rows into a
    // single group while preserving the server's newest-first order
    // and leave the other-element row in its own group.
    hoisted.divergences = [
      {
        id: "div-newer",
        bimModelId: "bim-1",
        materializableElementId: "elem-A",
        briefingId: "brief-1",
        reason: "geometry-edited",
        note: "Pulled the envelope south by 2ft",
        detail: {},
        createdAt: "2025-01-05T12:00:00.000Z",
        elementKind: "buildable-envelope",
        elementLabel: "Envelope (lot 12)",
      },
      {
        id: "div-older",
        bimModelId: "bim-1",
        materializableElementId: "elem-A",
        briefingId: "brief-1",
        reason: "unpinned",
        note: null,
        detail: {},
        createdAt: "2025-01-04T08:00:00.000Z",
        elementKind: "buildable-envelope",
        elementLabel: "Envelope (lot 12)",
      },
      {
        id: "div-other",
        bimModelId: "bim-1",
        materializableElementId: "elem-B",
        briefingId: "brief-1",
        reason: "deleted",
        note: null,
        detail: {},
        createdAt: "2025-01-03T08:00:00.000Z",
        elementKind: "property-line",
        elementLabel: "North property line",
      },
    ];
    renderPanel();

    // Two distinct elements ⇒ two groups.
    const groups = screen.getAllByTestId("briefing-divergences-group");
    expect(groups).toHaveLength(2);

    // The same-element group contains both rows, in the original
    // (newest-first) order.
    const groupA = groups.find(
      (g) => g.getAttribute("data-element-id") === "elem-A",
    );
    expect(groupA).toBeDefined();
    const groupARows = within(groupA!).getAllByTestId(
      "briefing-divergences-row",
    );
    expect(groupARows.map((r) => r.getAttribute("data-divergence-id"))).toEqual(
      ["div-newer", "div-older"],
    );

    // The other-element group has just the one deleted row.
    const groupB = groups.find(
      (g) => g.getAttribute("data-element-id") === "elem-B",
    );
    expect(groupB).toBeDefined();
    const groupBRows = within(groupB!).getAllByTestId(
      "briefing-divergences-row",
    );
    expect(groupBRows.map((r) => r.getAttribute("data-divergence-id"))).toEqual(
      ["div-other"],
    );

    // The empty-state branch must be torn down once any divergence
    // is present.
    expect(
      screen.queryByTestId("briefing-divergences-empty"),
    ).not.toBeInTheDocument();
  });

  it("renders the correct reason badge palette for each reason bucket", () => {
    // One row per reason so we can assert all four palette branches
    // in a single mount. Each row exposes its reason via the
    // `data-divergence-reason` attribute — the badge color choice
    // is keyed off the same value, so a regression in the palette
    // map would have to come with a renamed reason or a swapped
    // lookup branch (both of which we'd notice).
    hoisted.divergences = [
      {
        id: "div-deleted",
        bimModelId: "bim-1",
        materializableElementId: "elem-deleted",
        briefingId: "brief-1",
        reason: "deleted",
        note: null,
        detail: {},
        createdAt: "2025-01-05T12:00:00.000Z",
        elementKind: null,
        elementLabel: null,
      },
      {
        id: "div-unpinned",
        bimModelId: "bim-1",
        materializableElementId: "elem-unpinned",
        briefingId: "brief-1",
        reason: "unpinned",
        note: null,
        detail: {},
        createdAt: "2025-01-05T11:00:00.000Z",
        elementKind: "terrain",
        elementLabel: null,
      },
      {
        id: "div-geometry",
        bimModelId: "bim-1",
        materializableElementId: "elem-geometry",
        briefingId: "brief-1",
        reason: "geometry-edited",
        note: null,
        detail: {},
        createdAt: "2025-01-05T10:00:00.000Z",
        elementKind: "setback-plane",
        elementLabel: null,
      },
      {
        id: "div-other",
        bimModelId: "bim-1",
        materializableElementId: "elem-other",
        briefingId: "brief-1",
        reason: "other",
        note: null,
        detail: {},
        createdAt: "2025-01-05T09:00:00.000Z",
        elementKind: "neighbor-mass",
        elementLabel: null,
      },
    ];
    renderPanel();

    function rowFor(reason: string): HTMLElement {
      const rows = screen
        .getAllByTestId("briefing-divergences-row")
        .filter((r) => r.getAttribute("data-divergence-reason") === reason);
      expect(rows).toHaveLength(1);
      return rows[0];
    }
    function badgeBg(row: HTMLElement): string {
      const badge = within(row).getByTestId("briefing-divergences-reason-badge");
      // happy-dom serializes inline `style.background` as the CSS
      // var token we wrote — that's exactly what we want to assert
      // because it pins the *intended* palette without coupling
      // the test to resolved colors.
      return (badge as HTMLElement).style.background;
    }
    function badgeFg(row: HTMLElement): string {
      const badge = within(row).getByTestId("briefing-divergences-reason-badge");
      return (badge as HTMLElement).style.color;
    }

    // deleted → danger palette (loudest signal — the operator most
    // needs to chase a deleted locked element).
    const deletedRow = rowFor("deleted");
    expect(badgeBg(deletedRow)).toBe("var(--danger-dim)");
    expect(badgeFg(deletedRow)).toBe("var(--danger-text)");
    expect(
      within(deletedRow).getByTestId("briefing-divergences-reason-badge"),
    ).toHaveTextContent("Deleted");

    // unpinned → warning.
    const unpinnedRow = rowFor("unpinned");
    expect(badgeBg(unpinnedRow)).toBe("var(--warning-dim)");
    expect(badgeFg(unpinnedRow)).toBe("var(--warning-text)");
    expect(
      within(unpinnedRow).getByTestId("briefing-divergences-reason-badge"),
    ).toHaveTextContent("Unpinned");

    // geometry-edited → warning (same palette as unpinned; both are
    // "noticed, not blocking").
    const geomRow = rowFor("geometry-edited");
    expect(badgeBg(geomRow)).toBe("var(--warning-dim)");
    expect(badgeFg(geomRow)).toBe("var(--warning-text)");
    expect(
      within(geomRow).getByTestId("briefing-divergences-reason-badge"),
    ).toHaveTextContent("Geometry edited");

    // other → info.
    const otherRow = rowFor("other");
    expect(badgeBg(otherRow)).toBe("var(--info-dim)");
    expect(badgeFg(otherRow)).toBe("var(--info-text)");
    expect(
      within(otherRow).getByTestId("briefing-divergences-reason-badge"),
    ).toHaveTextContent("Other override");
  });

  it("falls back to the raw reason string and the 'other' palette for an unknown reason", () => {
    // The unknown-reason fallback the `BriefingDivergenceRow`
    // comment calls out: when the OpenAPI `BriefingDivergenceReason`
    // union grows or renames a bucket on the schema side, the row
    // must keep rendering rather than crashing — the label drops
    // back to `row.reason` verbatim and the palette drops back to
    // `BRIEFING_DIVERGENCE_REASON_COLORS.other`. A regression that
    // swapped `?? row.reason` for `?? ""` (empty pill) or that
    // dropped the `?? COLORS.other` palette default would slip past
    // the four-known-reason test above; this case pins both
    // fallback branches for a renamed-on-server reason.
    hoisted.divergences = [
      {
        id: "div-renamed",
        bimModelId: "bim-1",
        materializableElementId: "elem-renamed",
        briefingId: "brief-1",
        // Cast is required because the hoisted-state type narrows
        // `reason` to the four known buckets — the whole point of
        // this case is to exercise a value the union doesn't list.
        reason: "renamed-on-server" as unknown as "other",
        note: null,
        detail: {},
        createdAt: "2025-01-05T09:00:00.000Z",
        elementKind: "neighbor-mass",
        elementLabel: null,
      },
    ];
    renderPanel();

    const rows = screen
      .getAllByTestId("briefing-divergences-row")
      .filter(
        (r) =>
          r.getAttribute("data-divergence-reason") === "renamed-on-server",
      );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    const badge = within(row).getByTestId("briefing-divergences-reason-badge");
    // Label fallback: the raw reason string surfaces verbatim
    // because the labels map has no entry for it.
    expect(badge).toHaveTextContent("renamed-on-server");
    // Palette fallback: the `other` info palette is reused so the
    // pill stays legible against the SmartCity theme.
    expect((badge as HTMLElement).style.background).toBe("var(--info-dim)");
    expect((badge as HTMLElement).style.color).toBe("var(--info-text)");
  });

  it("renders the 'Element no longer in briefing' header when every row in a group has null kind/label", () => {
    // The deleted-element scenario: the architect deleted a locked
    // briefing element in Revit, so the row the C# add-in records
    // has no `elementKind` / `elementLabel` to draw from. The group
    // header must fall back to "Element no longer in briefing"
    // rather than rendering an empty heading. This is the loudest
    // signal the panel surfaces, so a regression that swapped the
    // fallback string would silently strip the only context the
    // operator gets for chasing a deleted element down.
    hoisted.divergences = [
      {
        id: "div-deleted-1",
        bimModelId: "bim-1",
        materializableElementId: "elem-gone",
        briefingId: "brief-1",
        reason: "deleted",
        note: "Locked element removed in Revit",
        detail: {},
        createdAt: "2025-01-05T12:00:00.000Z",
        elementKind: null,
        elementLabel: null,
      },
      {
        id: "div-deleted-2",
        bimModelId: "bim-1",
        materializableElementId: "elem-gone",
        briefingId: "brief-1",
        reason: "deleted",
        note: null,
        detail: {},
        createdAt: "2025-01-04T12:00:00.000Z",
        elementKind: null,
        elementLabel: null,
      },
    ];
    renderPanel();

    const groups = screen.getAllByTestId("briefing-divergences-group");
    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group.getAttribute("data-element-id")).toBe("elem-gone");
    expect(group).toHaveTextContent("Element no longer in briefing");
    // The element-label sub-line is keyed off `group.elementLabel`
    // and must collapse to nothing when both rows lack one — there
    // is no human-readable label to show.
    expect(
      within(group).queryByText("(lot 12)", { exact: false }),
    ).not.toBeInTheDocument();
  });

  it("keeps the populated kind/label header when only one row in a group carries them", () => {
    // The fallback merge in `groupDivergencesByElement`: the first
    // row the reducer sees for an element seeds the group's
    // `elementKind` / `elementLabel`, and a later row whose own
    // values are null must NOT blank them out. This guards the
    // realistic mix where the C# add-in recorded a populated
    // override first, then a deleted-fallback row landed in the
    // same group on a later push. The header should still read the
    // human-readable kind ("Buildable envelope") rather than
    // collapsing to "Element no longer in briefing".
    hoisted.divergences = [
      {
        id: "div-populated",
        bimModelId: "bim-1",
        materializableElementId: "elem-mixed",
        briefingId: "brief-1",
        reason: "geometry-edited",
        note: "Pulled the envelope south by 2ft",
        detail: {},
        createdAt: "2025-01-05T12:00:00.000Z",
        elementKind: "buildable-envelope",
        elementLabel: "Envelope (lot 12)",
      },
      {
        id: "div-null",
        bimModelId: "bim-1",
        materializableElementId: "elem-mixed",
        briefingId: "brief-1",
        reason: "deleted",
        note: null,
        detail: {},
        createdAt: "2025-01-04T12:00:00.000Z",
        elementKind: null,
        elementLabel: null,
      },
    ];
    renderPanel();

    const groups = screen.getAllByTestId("briefing-divergences-group");
    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group.getAttribute("data-element-id")).toBe("elem-mixed");
    // The merged group keeps the populated kind ("buildable-envelope"
    // → "Buildable envelope") and the populated label.
    expect(group).toHaveTextContent("Buildable envelope");
    expect(group).toHaveTextContent("Envelope (lot 12)");
    // And it must NOT fall back to the deleted-element header just
    // because one of the two rows has null kind/label.
    expect(group).not.toHaveTextContent("Element no longer in briefing");
    // Both rows still render under the merged header — the merge
    // affects the group's metadata, not its row count.
    const rows = within(group).getAllByTestId("briefing-divergences-row");
    expect(rows.map((r) => r.getAttribute("data-divergence-id"))).toEqual([
      "div-populated",
      "div-null",
    ]);
  });

  it("renders the loading-state copy while the divergences query is loading", () => {
    // Force the divergences query into the loading branch via the
    // hoisted state hook the mock honors synchronously. The
    // bim-model query still resolves (so the panel mounts past its
    // "no bim-model yet → render nothing" guard) and we land on
    // the in-panel loading row.
    hoisted.divergencesQueryState = { isLoading: true, isError: false };
    renderPanel();

    const loading = screen.getByTestId("briefing-divergences-loading");
    expect(loading).toBeInTheDocument();
    expect(loading).toHaveTextContent("Loading recent overrides…");
    // The other two state branches must stay hidden — the loading
    // copy is exclusive with both empty and error.
    expect(
      screen.queryByTestId("briefing-divergences-empty"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("briefing-divergences-error"),
    ).not.toBeInTheDocument();
  });

  it("renders the error-state copy when the divergences query fails", () => {
    // Same hoisted-state hook, error branch. The panel renders the
    // error row in `role="alert"` so screen readers announce it,
    // and the empty state must stay hidden so the operator
    // doesn't read "no overrides recorded yet" when the panel
    // actually couldn't load any.
    hoisted.divergencesQueryState = { isLoading: false, isError: true };
    renderPanel();

    const error = screen.getByTestId("briefing-divergences-error");
    expect(error).toBeInTheDocument();
    expect(error).toHaveAttribute("role", "alert");
    expect(error).toHaveTextContent(
      "Couldn't load recent overrides. Try refreshing in a moment.",
    );
    expect(
      screen.queryByTestId("briefing-divergences-empty"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("briefing-divergences-loading"),
    ).not.toBeInTheDocument();
  });
});

describe("PushToRevitAffordance → divergences invalidation (Task #172)", () => {
  it("invalidates the divergences query after a successful Push-to-Revit", async () => {
    const { invalidateSpy } = renderPushAffordance();

    // Click the affordance's CTA so the page records a `mutate`
    // call. The mutate spy is a no-op (so the promise never
    // resolves on its own) — we manually fire `onSuccess` below to
    // exercise the page-level invalidation chain, mirroring the
    // Task #126 banner test pattern.
    fireEvent.click(screen.getByTestId("push-to-revit-button"));
    expect(hoisted.pushMutate).toHaveBeenCalledTimes(1);
    expect(hoisted.capturedPushOptions?.mutation?.onSuccess).toBeDefined();

    invalidateSpy.mockClear();
    await act(async () => {
      await hoisted.capturedPushOptions!.mutation!.onSuccess!(
        { bimModel: { ...hoisted.bimModel } },
        { id: hoisted.bimModel.engagementId, data: {} },
        undefined,
      );
    });

    // Three independent invalidations must run after a successful
    // push: the bim-model row (status pill flips), the refresh
    // payload (diff counters reset), and the divergences list (the
    // panel directly above us). The third one is the new behavior
    // Task #172 introduced and the bug this test guards against.
    const calledKeys = invalidateSpy.mock.calls.map(
      (call) => (call[0] as { queryKey?: unknown[] } | undefined)?.queryKey,
    );
    expect(calledKeys).toEqual(
      expect.arrayContaining([
        ["getEngagementBimModel", hoisted.bimModel.engagementId],
        ["getBimModelRefresh", hoisted.bimModel.id],
        ["listBimModelDivergences", hoisted.bimModel.id],
      ]),
    );
  });
});

/**
 * PushToRevitAffordance status-pill / CTA / explainer mapping
 * (Task #207).
 *
 * Task #192 pinned the post-push divergences invalidation above, but
 * the affordance's three visible states (`refreshStatus` →
 * palette / CTA-label / explainer) and its disabled-without-briefing
 * guard had no coverage. A regression in any of those branches would
 * let the wrong reassurance ship to architects — e.g. a "Current"
 * pill on top of a stale model, a "Push to Revit" CTA after a
 * successful push, or a clickable button on an engagement that has
 * no briefing — so each branch is locked in here.
 *
 * The five cases mirror the bullets in the task brief:
 *   1. not-pushed → info palette + "Push to Revit" + generic copy.
 *   2. current    → success palette + "Push again to Revit" +
 *                   "Materialized at … against briefing v<n>".
 *   3. stale      → warning palette + "Re-push to Revit" + the
 *                   "(N added, M modified)" diff tail.
 *   4. hasBriefing=false → button disabled + "Upload a briefing
 *      source first…" hint regardless of refreshStatus.
 *   5. pushMutation.isError → push-to-revit-error alert renders.
 */
describe("PushToRevitAffordance status / CTA / explainer mapping (Task #207)", () => {
  function badgeFor() {
    return screen.getByTestId("push-to-revit-status-badge");
  }
  function explainerText() {
    return screen.getByTestId("push-to-revit-explainer").textContent ?? "";
  }
  function ctaText() {
    return screen.getByTestId("push-to-revit-button").textContent ?? "";
  }

  it("renders the info palette + generic CTA + generic explainer when refreshStatus is not-pushed", () => {
    // First-render shape: no prior materialization, no diff. Both
    // the bim-model row and the /refresh payload report
    // `not-pushed`, mirroring what the api-server returns before
    // any architect has run a sync.
    hoisted.bimModel.refreshStatus = "not-pushed";
    hoisted.bimModel.materializedAt = null;
    hoisted.refresh = {
      bimModelId: "bim-1",
      briefingId: "brief-1",
      briefingVersion: 3,
      materializedAt: null,
      refreshStatus: "not-pushed",
      diff: {
        addedCount: 0,
        modifiedCount: 0,
        unchangedCount: 0,
        elements: [],
      },
    };

    renderPushAffordance();

    const badge = badgeFor();
    expect(badge).toHaveAttribute("data-status", "not-pushed");
    expect(badge).toHaveTextContent("Not pushed");
    expect(badge.style.background).toBe("var(--info-dim)");
    expect(badge.style.color).toBe("var(--info-text)");

    expect(ctaText()).toBe("Push to Revit");
    // Generic explainer copy — no version / diff tail because nothing
    // has been materialized yet.
    expect(explainerText()).toBe(
      "Materializes the engagement's briefing into the architect's active Revit model.",
    );
    expect(screen.getByTestId("push-to-revit-button")).not.toBeDisabled();
  });

  it("renders the success palette + 'Push again' CTA + 'Materialized at … against briefing v<n>' explainer when refreshStatus is current", () => {
    // The default beforeEach state already models a freshly-pushed
    // engagement (refreshStatus=current, materializedAt set,
    // briefingVersion=3) — exactly the shape this branch fires on.
    renderPushAffordance();

    const badge = badgeFor();
    expect(badge).toHaveAttribute("data-status", "current");
    expect(badge).toHaveTextContent("Current");
    expect(badge.style.background).toBe("var(--success-dim)");
    expect(badge.style.color).toBe("var(--success-text)");

    expect(ctaText()).toBe("Push again to Revit");
    // The relative-time prefix ("just now" / "N min ago" / "N h
    // ago" / "N d ago") depends on Date.now() so we assert the
    // surrounding scaffolding rather than a brittle exact string.
    // The version tail is the wording Task #172's code review
    // pinned and is what an operator scans for to cross-reference
    // with the C# add-in.
    const explainer = explainerText();
    expect(explainer).toMatch(/^Materialized at .+ against briefing v3\.$/);
  });

  it("renders the warning palette + 'Re-push' CTA + '(N added, M modified)' explainer when refreshStatus is stale", () => {
    // Stale shape: bim-model + /refresh agree the model is behind,
    // and /refresh exposes a non-zero diff so the explainer can
    // surface the per-element delta the operator is about to push.
    hoisted.bimModel.refreshStatus = "stale";
    hoisted.refresh = {
      bimModelId: "bim-1",
      briefingId: "brief-1",
      briefingVersion: 4,
      materializedAt: "2025-01-02T00:00:00.000Z",
      refreshStatus: "stale",
      diff: {
        addedCount: 2,
        modifiedCount: 3,
        unchangedCount: 7,
        elements: [],
      },
    };

    renderPushAffordance();

    const badge = badgeFor();
    expect(badge).toHaveAttribute("data-status", "stale");
    expect(badge).toHaveTextContent("Stale");
    expect(badge.style.background).toBe("var(--warning-dim)");
    expect(badge.style.color).toBe("var(--warning-text)");

    expect(ctaText()).toBe("Re-push to Revit");
    const explainer = explainerText();
    // The diff tail is the bug this case guards against — the
    // operator decides whether to re-push based on those numbers,
    // so a swap of added↔modified would be a real regression.
    expect(explainer).toContain("(2 added, 3 modified)");
    expect(explainer).toContain(
      "The briefing has changed since the last push",
    );
    expect(explainer).toContain("Re-push to refresh the architect's Revit model.");
    // The "Last materialized at … against briefing v<n>." tail must
    // also be present whenever both materializedAt and version are
    // known, so the operator can still see what the model is
    // currently aligned to.
    expect(explainer).toMatch(/Last materialized at .+ against briefing v4\./);
  });

  it("disables the button and surfaces the 'Upload a briefing source first…' hint when hasBriefing is false, regardless of refreshStatus", () => {
    // The hint must win over the refreshStatus-driven copy so an
    // operator on an engagement with no briefing isn't told to
    // "Re-push" something that doesn't exist. Pin that by setting
    // refreshStatus to `stale` (the loudest non-disabled branch)
    // and confirming the disabled-without-briefing copy still wins.
    hoisted.bimModel.refreshStatus = "stale";
    hoisted.refresh = {
      bimModelId: "bim-1",
      briefingId: "brief-1",
      briefingVersion: 4,
      materializedAt: "2025-01-02T00:00:00.000Z",
      refreshStatus: "stale",
      diff: {
        addedCount: 5,
        modifiedCount: 1,
        unchangedCount: 0,
        elements: [],
      },
    };

    renderPushAffordance({ hasBriefing: false });

    expect(screen.getByTestId("push-to-revit-button")).toBeDisabled();
    expect(explainerText()).toBe(
      "Upload a briefing source first — the briefing is what gets materialized.",
    );
    // Make sure no diff tail or "Re-push" copy bled through.
    expect(explainerText()).not.toContain("(");
    expect(explainerText()).not.toContain("Re-push");
  });

  it("renders the push-to-revit-error alert when pushMutation.isError flips true", () => {
    // The alert is the operator's only signal that the previous
    // click failed — a regression that hides it (e.g. a refactor
    // that drops the `pushMutation.isError &&` branch) would leave
    // them clicking a "Push" button that silently does nothing.
    hoisted.pushIsError = true;

    renderPushAffordance();

    const alert = screen.getByTestId("push-to-revit-error");
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent(
      "Failed to push to Revit. Try again in a moment.",
    );
  });
});
