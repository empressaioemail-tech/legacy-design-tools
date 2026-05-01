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
      // Resolved-row fields (Task #191 / #212 / #269). Default
      // omitted so existing fixtures stay untouched; the inline
      // attribution + avatar tests populate them explicitly.
      resolvedAt?: string | null;
      resolvedByRequestor?:
        | {
            kind: "user" | "agent";
            id: string;
            displayName?: string;
            avatarUrl?: string;
          }
        | null;
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
    // Resolve-mutation capture for the Task #268 resolve-action-flow
    // test. The hook's `mutate` is a spy so the test can assert the
    // call shape, and `capturedResolveOptions` exposes the
    // `onSuccess` the row registers so the test can fire the
    // post-mutation invalidation chain by hand — same pattern the
    // push-affordance test uses for `useCreateEngagementSubmission`
    // and `usePushEngagementBimModel` above.
    capturedResolveOptions: null as null | {
      mutation?: {
        onSuccess?: (
          data: unknown,
          variables: unknown,
          context: unknown,
        ) => Promise<void> | void;
      };
    },
    resolveMutate: vi.fn(),
    resolveIsPending: false,
    resolveIsError: false,
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
    useResolveBimModelDivergence: (
      options: typeof hoisted.capturedResolveOptions,
    ) => {
      hoisted.capturedResolveOptions = options;
      return {
        mutate: hoisted.resolveMutate,
        isPending: hoisted.resolveIsPending,
        isError: hoisted.resolveIsError,
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
  hoisted.capturedResolveOptions = null;
  hoisted.resolveMutate.mockReset();
  hoisted.resolveIsPending = false;
  hoisted.resolveIsError = false;
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

  it("renders the inline 'Resolved {time} by {who}' attribution on each Resolved row (Task #212)", () => {
    // Three Resolved rows so we exercise the three attribution
    // shapes the FE has to render side-by-side:
    //   - hydrated user → friendly displayName
    //   - un-hydrated user → falls back to the raw id
    //   - null requestor → renders "by system"
    // All three must show their relative time inline (not just on
    // hover) so the operator can scan attribution without mousing
    // over each badge.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    hoisted.divergences = [
      {
        id: "div-friendly",
        bimModelId: "bim-1",
        materializableElementId: "elem-A",
        briefingId: "brief-1",
        reason: "geometry-edited",
        note: null,
        detail: {},
        createdAt: "2025-01-05T12:00:00.000Z",
        elementKind: "buildable-envelope",
        elementLabel: "Envelope (lot 12)",
        resolvedAt: oneHourAgo,
        resolvedByRequestor: {
          kind: "user",
          id: "user-7",
          displayName: "Alex Architect",
        },
      },
      {
        id: "div-raw-id",
        bimModelId: "bim-1",
        materializableElementId: "elem-B",
        briefingId: "brief-1",
        reason: "unpinned",
        note: null,
        detail: {},
        createdAt: "2025-01-05T11:00:00.000Z",
        elementKind: "property-line",
        elementLabel: "South property line",
        resolvedAt: oneHourAgo,
        resolvedByRequestor: { kind: "user", id: "user-22" },
      },
      {
        id: "div-system",
        bimModelId: "bim-1",
        materializableElementId: "elem-C",
        briefingId: "brief-1",
        reason: "deleted",
        note: null,
        detail: {},
        createdAt: "2025-01-05T10:00:00.000Z",
        elementKind: "terrain",
        elementLabel: "Site terrain",
        resolvedAt: oneHourAgo,
        resolvedByRequestor: null,
      },
      {
        // Task #270: a `kind === "agent"` resolver whose id is in
        // the friendly-label map should render the polished label
        // ("Site-context automation") rather than leaking the raw
        // `snapshot-ingest` id into the audit row.
        id: "div-agent-known",
        bimModelId: "bim-1",
        materializableElementId: "elem-D",
        briefingId: "brief-1",
        reason: "geometry-edited",
        note: null,
        detail: {},
        createdAt: "2025-01-05T09:30:00.000Z",
        elementKind: "buildable-envelope",
        elementLabel: "Envelope (lot 13)",
        resolvedAt: oneHourAgo,
        resolvedByRequestor: { kind: "agent", id: "snapshot-ingest" },
      },
      {
        // Task #270 fallback case: an agent id we don't have a
        // friendly label for must still attribute itself with the
        // raw id rather than collapse to an anonymous string, so a
        // newly-introduced producer keeps showing up in the audit
        // trail.
        id: "div-agent-unknown",
        bimModelId: "bim-1",
        materializableElementId: "elem-E",
        briefingId: "brief-1",
        reason: "unpinned",
        note: null,
        detail: {},
        createdAt: "2025-01-05T09:00:00.000Z",
        elementKind: "property-line",
        elementLabel: "North property line",
        resolvedAt: oneHourAgo,
        resolvedByRequestor: { kind: "agent", id: "future-agent" },
      },
    ];
    renderPanel();

    // The Resolved section is collapsed by default — toggle it open
    // so the attribution rows are in the document tree.
    fireEvent.click(
      screen.getByTestId("briefing-divergences-resolved-toggle"),
    );

    const friendlyRow = screen
      .getAllByTestId("briefing-divergences-row")
      .find((r) => r.getAttribute("data-divergence-id") === "div-friendly");
    expect(friendlyRow).toBeDefined();
    const friendlyAttr = within(friendlyRow!).getByTestId(
      "briefing-divergences-resolved-attribution",
    );
    // Inline copy carries both the relative time and the friendly
    // display name — no need to hover the badge to learn either.
    // The chip nested inside the attribution also renders the
    // avatar's initials fallback (e.g. "AA") between "by" and the
    // name, so we assert against the relative-time prefix and the
    // chip's own text content separately rather than as one
    // contiguous substring.
    expect(friendlyAttr).toHaveTextContent(/^1 h ago by/);
    expect(
      within(friendlyAttr).getByTestId("briefing-divergences-resolver-chip"),
    ).toHaveTextContent("Alex Architect");

    const rawRow = screen
      .getAllByTestId("briefing-divergences-row")
      .find((r) => r.getAttribute("data-divergence-id") === "div-raw-id");
    expect(rawRow).toBeDefined();
    const rawAttr = within(rawRow!).getByTestId(
      "briefing-divergences-resolved-attribution",
    );
    expect(rawAttr).toHaveTextContent(/^1 h ago by/);
    expect(
      within(rawAttr).getByTestId("briefing-divergences-resolver-chip"),
    ).toHaveTextContent("user-22");

    const systemRow = screen
      .getAllByTestId("briefing-divergences-row")
      .find((r) => r.getAttribute("data-divergence-id") === "div-system");
    expect(systemRow).toBeDefined();
    const systemAttr = within(systemRow!).getByTestId(
      "briefing-divergences-resolved-attribution",
    );
    expect(systemAttr).toHaveTextContent(/^1 h ago by/);
    expect(
      within(systemAttr).getByTestId("briefing-divergences-resolver-chip"),
    ).toHaveTextContent("system");

    // Task #270: a known agent id renders the friendly label
    // sourced from the shared FRIENDLY_AGENT_LABELS map rather
    // than the raw `snapshot-ingest` identifier.
    const agentKnownRow = screen
      .getAllByTestId("briefing-divergences-row")
      .find(
        (r) => r.getAttribute("data-divergence-id") === "div-agent-known",
      );
    expect(agentKnownRow).toBeDefined();
    const agentKnownAttr = within(agentKnownRow!).getByTestId(
      "briefing-divergences-resolved-attribution",
    );
    // Avatar initials live inside the chip (Task #269) so we assert
    // the time prefix on the row and the friendly label on the chip
    // separately rather than as one contiguous substring.
    expect(agentKnownAttr).toHaveTextContent(/^1 h ago by/);
    expect(
      within(agentKnownAttr).getByTestId("briefing-divergences-resolver-chip"),
    ).toHaveTextContent("Site-context automation");
    // Defensive: the raw id must NOT leak into the audit row when
    // the friendly label is available.
    expect(agentKnownAttr).not.toHaveTextContent("snapshot-ingest");

    // Task #270 fallback: an agent id we don't have a friendly
    // label for still attributes itself with the raw id rather
    // than collapsing to an anonymous string.
    const agentUnknownRow = screen
      .getAllByTestId("briefing-divergences-row")
      .find(
        (r) => r.getAttribute("data-divergence-id") === "div-agent-unknown",
      );
    expect(agentUnknownRow).toBeDefined();
    const agentUnknownAttr = within(agentUnknownRow!).getByTestId(
      "briefing-divergences-resolved-attribution",
    );
    expect(agentUnknownAttr).toHaveTextContent(/^1 h ago by/);
    expect(
      within(agentUnknownAttr).getByTestId(
        "briefing-divergences-resolver-chip",
      ),
    ).toHaveTextContent("future-agent");

    // The absolute ISO timestamp is still tucked into the title
    // attribute so an operator can hover for second-precision when
    // they need it. The relative copy in the body covers the at-a-
    // glance need; the title covers the audit-precision need.
    expect(friendlyAttr).toHaveAttribute("title", oneHourAgo);
  });

  it("renders an avatar / initials / system glyph beside the resolver name (Task #269)", () => {
    // Four resolved rows so we exercise every branch the
    // ResolvedByChip has to render:
    //   - hydrated user with avatarUrl  → image avatar
    //   - hydrated user, no avatarUrl   → initials from displayName
    //   - un-hydrated user (raw id)     → initials from raw id
    //   - null requestor (system)       → neutral "·" glyph
    // Each branch must surface in the chip's data attributes /
    // fallback text so the test can assert without relying on
    // computed styles.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    hoisted.divergences = [
      {
        id: "div-with-avatar",
        bimModelId: "bim-1",
        materializableElementId: "elem-A",
        briefingId: "brief-1",
        reason: "geometry-edited",
        note: null,
        detail: {},
        createdAt: "2025-01-05T12:00:00.000Z",
        elementKind: "buildable-envelope",
        elementLabel: "Envelope (lot 12)",
        resolvedAt: oneHourAgo,
        resolvedByRequestor: {
          kind: "user",
          id: "user-7",
          displayName: "Alex Architect",
          avatarUrl: "https://cdn.example.test/avatars/user-7.png",
        },
      },
      {
        id: "div-initials",
        bimModelId: "bim-1",
        materializableElementId: "elem-B",
        briefingId: "brief-1",
        reason: "unpinned",
        note: null,
        detail: {},
        createdAt: "2025-01-05T11:00:00.000Z",
        elementKind: "property-line",
        elementLabel: "South property line",
        resolvedAt: oneHourAgo,
        resolvedByRequestor: {
          kind: "user",
          id: "user-9",
          displayName: "Morgan Mason",
        },
      },
      {
        id: "div-raw-id",
        bimModelId: "bim-1",
        materializableElementId: "elem-C",
        briefingId: "brief-1",
        reason: "unpinned",
        note: null,
        detail: {},
        createdAt: "2025-01-05T10:30:00.000Z",
        elementKind: "property-line",
        elementLabel: "West property line",
        resolvedAt: oneHourAgo,
        resolvedByRequestor: { kind: "user", id: "user-22" },
      },
      {
        id: "div-system",
        bimModelId: "bim-1",
        materializableElementId: "elem-D",
        briefingId: "brief-1",
        reason: "deleted",
        note: null,
        detail: {},
        createdAt: "2025-01-05T10:00:00.000Z",
        elementKind: "terrain",
        elementLabel: "Site terrain",
        resolvedAt: oneHourAgo,
        resolvedByRequestor: null,
      },
    ];
    renderPanel();
    fireEvent.click(
      screen.getByTestId("briefing-divergences-resolved-toggle"),
    );

    const findRow = (id: string) =>
      screen
        .getAllByTestId("briefing-divergences-row")
        .find((r) => r.getAttribute("data-divergence-id") === id);

    // ── 1. Hydrated user with avatarUrl ──────────────────────────
    // Radix's `AvatarImage` only mounts an `<img>` after a real
    // browser fires a `load` event, which never happens in
    // happy-dom — so we mirror the avatar URL onto the chip itself
    // (see `data-resolver-avatar-url`) and assert that here.
    const avatarRow = findRow("div-with-avatar");
    expect(avatarRow).toBeDefined();
    const avatarChip = within(avatarRow!).getByTestId(
      "briefing-divergences-resolver-chip",
    );
    expect(avatarChip).toHaveAttribute("data-resolver-kind", "user");
    expect(avatarChip).toHaveTextContent("Alex Architect");
    expect(avatarChip).toHaveAttribute(
      "data-resolver-avatar-url",
      "https://cdn.example.test/avatars/user-7.png",
    );

    // ── 2. Hydrated user without avatarUrl → initials ────────────
    const initialsRow = findRow("div-initials");
    expect(initialsRow).toBeDefined();
    const initialsChip = within(initialsRow!).getByTestId(
      "briefing-divergences-resolver-chip",
    );
    expect(initialsChip).not.toHaveAttribute("data-resolver-avatar-url");
    const initialsFallback = within(initialsRow!).getByTestId(
      "briefing-divergences-resolver-avatar-fallback",
    );
    expect(initialsFallback).toHaveTextContent("MM");

    // ── 3. Un-hydrated user → initials derived from raw id ───────
    // The chip still renders a label + initials so the row is
    // never blank, even when the API couldn't hydrate the profile.
    const rawRow = findRow("div-raw-id");
    expect(rawRow).toBeDefined();
    const rawFallback = within(rawRow!).getByTestId(
      "briefing-divergences-resolver-avatar-fallback",
    );
    // "user-22" → first letter "U", no second word, so the chip
    // collapses to a single-letter fallback rather than padding.
    expect(rawFallback).toHaveTextContent("U");
    expect(
      within(rawRow!).getByTestId("briefing-divergences-resolver-chip"),
    ).toHaveTextContent("user-22");

    // ── 4. Null requestor → neutral system glyph ─────────────────
    // We render "·" instead of an initials chip so a system /
    // unattributed resolve can't be confused with a real user
    // whose initials happen to be "S".
    const systemRow = findRow("div-system");
    expect(systemRow).toBeDefined();
    const systemChip = within(systemRow!).getByTestId(
      "briefing-divergences-resolver-chip",
    );
    expect(systemChip).toHaveAttribute("data-resolver-kind", "system");
    expect(systemChip).toHaveTextContent("system");
    const systemFallback = within(systemRow!).getByTestId(
      "briefing-divergences-resolver-avatar-fallback",
    );
    expect(systemFallback).toHaveTextContent("·");
    expect(
      within(systemRow!).queryByRole("img", { hidden: true }),
    ).toBeNull();
  });

  it("renders an '<operator> acknowledged the override' timeline entry for each Resolved divergence (Task #268)", () => {
    // Task #268: the design-tools panel must surface the
    // `briefing-divergence.resolved` atom event Task #213 added
    // server-side as a distinct timeline entry — separate from the
    // inline "Resolved {time} by {who}" badge — so the two-sided
    // audit trail (recorded override + acknowledgement) reads
    // top-to-bottom on the row card.
    //
    // Three resolved rows pin the three attribution shapes the
    // server can hand the FE: hydrated user (friendly displayName),
    // un-hydrated user (raw id fallback), and a system-attributed
    // resolve (null requestor → "system"). Each acknowledgement
    // entry must carry the same `data-divergence-id` the recorded
    // row exposes so it links into the divergence detail panel
    // exactly the way the existing `briefing-divergence.recorded`
    // row does.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    hoisted.divergences = [
      {
        id: "div-friendly",
        bimModelId: "bim-1",
        materializableElementId: "elem-A",
        briefingId: "brief-1",
        reason: "geometry-edited",
        note: null,
        detail: {},
        createdAt: "2025-01-05T12:00:00.000Z",
        elementKind: "buildable-envelope",
        elementLabel: "Envelope (lot 12)",
        resolvedAt: oneHourAgo,
        resolvedByRequestor: {
          kind: "user",
          id: "user-7",
          displayName: "Alex Architect",
        },
      },
      {
        id: "div-raw-id",
        bimModelId: "bim-1",
        materializableElementId: "elem-B",
        briefingId: "brief-1",
        reason: "unpinned",
        note: null,
        detail: {},
        createdAt: "2025-01-05T11:00:00.000Z",
        elementKind: "property-line",
        elementLabel: "South property line",
        resolvedAt: oneHourAgo,
        resolvedByRequestor: { kind: "user", id: "user-22" },
      },
      {
        id: "div-system",
        bimModelId: "bim-1",
        materializableElementId: "elem-C",
        briefingId: "brief-1",
        reason: "deleted",
        note: null,
        detail: {},
        createdAt: "2025-01-05T10:00:00.000Z",
        elementKind: "terrain",
        elementLabel: "Site terrain",
        resolvedAt: oneHourAgo,
        resolvedByRequestor: null,
      },
    ];
    renderPanel();

    // The Resolved section is collapsed by default — toggle it open
    // so the acknowledgement entries are in the document tree.
    fireEvent.click(
      screen.getByTestId("briefing-divergences-resolved-toggle"),
    );

    const entries = screen.getAllByTestId(
      "briefing-divergences-acknowledged-entry",
    );
    // One entry per resolved row — matches the
    // `briefing-divergence.resolved` event the server emits per
    // resolve. Open rows must NOT carry the entry; only resolved
    // ones do (the conditional renders inside `isResolved`).
    expect(entries).toHaveLength(3);

    // Each entry must mirror its row's `data-divergence-id` so the
    // acknowledgement entry links into the same divergence detail
    // panel target the recorded row does.
    const friendlyEntry = entries.find(
      (e) => e.getAttribute("data-divergence-id") === "div-friendly",
    );
    expect(friendlyEntry).toBeDefined();
    // Attribution copy: the friendly displayName takes precedence
    // over the raw id when the API hydrated the requestor profile.
    expect(
      within(friendlyEntry!).getByTestId(
        "briefing-divergences-acknowledged-text",
      ),
    ).toHaveTextContent("Alex Architect acknowledged the override");
    // Real `<a href="#…">` link target — the entry deep-links to the
    // parent divergence row card via the same DOM id the row carries
    // (Task #268, "links into the divergence detail panel mirroring
    // the existing `briefing-divergence.recorded` row's link
    // target"). The recorded row is the divergence detail surface
    // today, so the anchor focuses / scrolls to it without any
    // client-side routing.
    expect(friendlyEntry!.tagName).toBe("A");
    expect(friendlyEntry).toHaveAttribute(
      "href",
      "#briefing-divergence-div-friendly",
    );
    // The matching row carries that exact id so the anchor resolves
    // — without this the "link" would point at nothing.
    const friendlyRow = screen
      .getAllByTestId("briefing-divergences-row")
      .find((r) => r.getAttribute("data-divergence-id") === "div-friendly");
    expect(friendlyRow).toBeDefined();
    expect(friendlyRow).toHaveAttribute("id", "briefing-divergence-div-friendly");
    // Relative-time prefix renders inline alongside the copy with
    // the absolute ISO tucked into the `title` for hover precision.
    const friendlyTime = within(friendlyEntry!).getByTestId(
      "briefing-divergences-acknowledged-time",
    );
    expect(friendlyTime).toHaveTextContent("1 h ago");
    expect(friendlyTime).toHaveAttribute("title", oneHourAgo);

    // Un-hydrated user falls back to the raw id rather than blanking
    // the attribution — same posture the inline badge uses.
    const rawEntry = entries.find(
      (e) => e.getAttribute("data-divergence-id") === "div-raw-id",
    );
    expect(rawEntry).toBeDefined();
    expect(
      within(rawEntry!).getByTestId(
        "briefing-divergences-acknowledged-text",
      ),
    ).toHaveTextContent("user-22 acknowledged the override");

    // Null requestor → "system" so an unattributed resolve still
    // reads as a real audit-trail entry instead of a blank line.
    const systemEntry = entries.find(
      (e) => e.getAttribute("data-divergence-id") === "div-system",
    );
    expect(systemEntry).toBeDefined();
    expect(
      within(systemEntry!).getByTestId(
        "briefing-divergences-acknowledged-text",
      ),
    ).toHaveTextContent("system acknowledged the override");
  });

  it("renders the acknowledgement entry attributed to the resolving requestor after the resolve mutation succeeds (Task #268)", async () => {
    // End-to-end-ish coverage of the actual resolve action flow,
    // not just static fixtures: start with an Open divergence row
    // (no acknowledgement entry yet), click the "Resolve" button,
    // simulate the server returning a resolved row, fire the
    // captured `onSuccess` so the page-level invalidation chain
    // kicks in, and assert the acknowledgement entry now appears
    // attributed to the resolving requestor. This is the regression
    // path that protects the user-visible promise of Task #268:
    // resolving a divergence in design-tools must surface the
    // "<operator> acknowledged the override" entry.
    const openCreatedAt = "2025-01-05T12:00:00.000Z";
    hoisted.divergences = [
      {
        id: "div-to-resolve",
        bimModelId: "bim-1",
        materializableElementId: "elem-A",
        briefingId: "brief-1",
        reason: "geometry-edited",
        note: null,
        detail: {},
        createdAt: openCreatedAt,
        elementKind: "buildable-envelope",
        elementLabel: "Envelope (lot 12)",
        // Open: no `resolvedAt` / `resolvedByRequestor`.
      },
    ];
    const { client } = renderPanel();

    // Pre-condition: the row is in the Open partition and the
    // acknowledgement entry is NOT in the document yet.
    const initialRow = screen.getByTestId("briefing-divergences-row");
    expect(initialRow.getAttribute("data-divergence-resolved")).toBe("false");
    expect(
      screen.queryByTestId("briefing-divergences-acknowledged-entry"),
    ).not.toBeInTheDocument();

    // Click the in-row Resolve button to fire the mutation. The
    // mocked `useResolveBimModelDivergence` captures the row's
    // registered `onSuccess` so we can drive the post-mutation
    // invalidation chain by hand without racing a real network
    // round-trip.
    fireEvent.click(screen.getByTestId("briefing-divergences-resolve-button"));
    expect(hoisted.resolveMutate).toHaveBeenCalledTimes(1);
    expect(hoisted.resolveMutate).toHaveBeenCalledWith({
      id: "bim-1",
      divergenceId: "div-to-resolve",
    });
    expect(hoisted.capturedResolveOptions?.mutation?.onSuccess).toBeDefined();

    // The api-server's resolve handler stamps `resolvedAt` and
    // `resolvedByRequestor` on the row and re-emits it via the
    // list endpoint after the row's `onSuccess` invalidation
    // triggers a refetch. Simulate that end-state by writing the
    // resolved shape directly into the query cache via
    // `setQueryData` — this is the same observable result the real
    // refetch would produce, with deterministic ordering that
    // doesn't race the mocked `useQuery`'s internal scheduler.
    // `onSuccess` still fires so the page-level invalidation is
    // exercised; `setQueryData` then replaces the cached payload
    // the next render reads from.
    const resolvedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const resolvedRowFixture = {
      ...hoisted.divergences[0],
      resolvedAt,
      resolvedByRequestor: {
        kind: "user" as const,
        id: "user-resolver",
        displayName: "Riley Resolver",
      },
    };
    hoisted.divergences = [resolvedRowFixture];
    await act(async () => {
      await hoisted.capturedResolveOptions!.mutation!.onSuccess!(
        undefined,
        { id: "bim-1", divergenceId: "div-to-resolve" },
        undefined,
      );
    });
    // Mirror the post-invalidation refetch result so the panel
    // re-renders with the resolved row in place. Performed outside
    // the previous `act` block so React Query's cache notifier
    // delivers the update on a clean tick — pairing it with the
    // onSuccess inside the same act sometimes leaves the observer
    // queued behind the invalidation that just ran.
    await act(async () => {
      client.setQueryData(["listBimModelDivergences", "bim-1"], {
        divergences: [resolvedRowFixture],
      });
    });

    // The row should have moved to the Resolved partition. Its
    // `data-divergence-resolved` attribute flips to "true", and
    // because the Resolved section is collapsed by default we need
    // to expand it before the acknowledgement entry is in the
    // document tree. Use `findBy*` so the assertion polls until the
    // cache propagation lands rather than racing the next paint.
    const resolvedToggle = await screen.findByTestId(
      "briefing-divergences-resolved-toggle",
    );
    fireEvent.click(resolvedToggle);

    const ackEntry = await screen.findByTestId(
      "briefing-divergences-acknowledged-entry",
    );
    // Attribution must point at the resolving requestor — the
    // user's task brief explicitly requires "attributed to the
    // resolving requestor". Display-name takes precedence over the
    // raw id when the API hydrated it.
    expect(
      within(ackEntry).getByTestId("briefing-divergences-acknowledged-text"),
    ).toHaveTextContent("Riley Resolver acknowledged the override");
    // Same `data-divergence-id` the row carries, so the entry can
    // be correlated with its originating divergence.
    expect(ackEntry.getAttribute("data-divergence-id")).toBe("div-to-resolve");
    // And the actual `<a href>` link target must resolve to the
    // recorded row's DOM id — the deep-link the task brief calls
    // out. Without this the entry would be a label, not a link.
    expect(ackEntry.tagName).toBe("A");
    expect(ackEntry).toHaveAttribute(
      "href",
      "#briefing-divergence-div-to-resolve",
    );
    const resolvedRow = screen
      .getAllByTestId("briefing-divergences-row")
      .find((r) => r.getAttribute("data-divergence-id") === "div-to-resolve");
    expect(resolvedRow).toBeDefined();
    expect(resolvedRow).toHaveAttribute(
      "id",
      "briefing-divergence-div-to-resolve",
    );
    expect(resolvedRow!.getAttribute("data-divergence-resolved")).toBe("true");
  });

  it("does not render an acknowledgement entry on Open (un-resolved) divergence rows (Task #268)", () => {
    // The acknowledgement entry mirrors the
    // `briefing-divergence.resolved` event, which the server only
    // emits when an operator marks a divergence resolved. An Open
    // row has no resolve event yet, so it must NOT render the
    // entry — otherwise the operator would read an audit trail for
    // an action that never happened.
    hoisted.divergences = [
      {
        id: "div-open",
        bimModelId: "bim-1",
        materializableElementId: "elem-open",
        briefingId: "brief-1",
        reason: "geometry-edited",
        note: null,
        detail: {},
        createdAt: "2025-01-05T12:00:00.000Z",
        elementKind: "buildable-envelope",
        elementLabel: "Envelope (lot 12)",
        // No `resolvedAt` / `resolvedByRequestor` — the row stays
        // in the Open partition.
      },
    ];
    renderPanel();

    // The row itself renders, but the acknowledgement entry must
    // be absent.
    const row = screen.getByTestId("briefing-divergences-row");
    expect(row.getAttribute("data-divergence-resolved")).toBe("false");
    expect(
      screen.queryByTestId("briefing-divergences-acknowledged-entry"),
    ).not.toBeInTheDocument();
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

  it("renders a 'View details' button next to Resolve on each Open architect row (Task #320)", () => {
    // Task #320: the architect surface gains the same per-divergence
    // drill-in the reviewer side already has. The button must
    // co-exist with Resolve on Open rows so an architect can inspect
    // an override before deciding to acknowledge it.
    hoisted.divergences = [
      {
        id: "div-open",
        bimModelId: "bim-1",
        materializableElementId: "elem-A",
        briefingId: "brief-1",
        reason: "geometry-edited",
        note: null,
        detail: {},
        createdAt: "2025-01-05T12:00:00.000Z",
        elementKind: "buildable-envelope",
        elementLabel: "Envelope (lot 12)",
      },
    ];
    renderPanel();

    const viewBtn = screen.getByTestId(
      "briefing-divergences-view-details-button",
    );
    expect(viewBtn).toHaveAttribute("data-divergence-id", "div-open");
    // Resolve still rendered on the Open row alongside the new
    // affordance — the architect-side write action must not regress.
    expect(
      screen.getByTestId("briefing-divergences-resolve-button"),
    ).toBeInTheDocument();
    // Dialog stays closed until the button is clicked.
    expect(
      screen.queryByTestId("briefing-divergence-detail-dialog"),
    ).not.toBeInTheDocument();
  });

  it("opens the BriefingDivergenceDetailDialog with the row's diff when 'View details' is clicked (Task #320)", () => {
    // Click-through: a 'geometry-edited' row carries a
    // before/after envelope plus a forward-compat `revitElementId`
    // attribute. Both surfaces should land inside the dialog (the
    // 3-column diff for the envelope, the flat-attributes table
    // for the side-channel field) so the architect sees the same
    // payload the reviewer would.
    hoisted.divergences = [
      {
        id: "div-1",
        bimModelId: "bim-1",
        materializableElementId: "elem-A",
        briefingId: "brief-1",
        reason: "geometry-edited",
        note: null,
        detail: {
          before: { area: 100, height: 12 },
          after: { area: 110, height: 14 },
          revitElementId: 9876,
        },
        createdAt: "2025-01-05T12:00:00.000Z",
        elementKind: "buildable-envelope",
        elementLabel: "Envelope (lot 12)",
      },
    ];
    renderPanel();

    fireEvent.click(
      screen.getByTestId("briefing-divergences-view-details-button"),
    );

    const dialog = screen.getByTestId("briefing-divergence-detail-dialog");
    expect(dialog).toBeInTheDocument();

    const diffRows = within(dialog).getAllByTestId(
      "briefing-divergence-detail-diff-row",
    );
    expect(
      diffRows.map((r) => r.getAttribute("data-field")).sort(),
    ).toEqual(["area", "height"]);

    const attrFields = within(dialog)
      .getAllByTestId("briefing-divergence-detail-attribute-row")
      .map((r) => r.getAttribute("data-field"));
    expect(attrFields).toContain("revitElementId");

    // Element label flows through into the dialog header so the
    // architect can confirm which envelope the diff belongs to.
    expect(within(dialog).getByText("Envelope (lot 12)")).toBeInTheDocument();

    // Closing the dialog tears it back out of the document — the
    // architect can re-open it on demand.
    fireEvent.click(screen.getByTestId("briefing-divergence-detail-close"));
    expect(
      screen.queryByTestId("briefing-divergence-detail-dialog"),
    ).not.toBeInTheDocument();
  });

  it("renders the 'View details' button on Resolved architect rows even when the Resolve button is gone (Task #320)", () => {
    // Resolved rows drop the Resolve action (the row is already
    // acknowledged) but still carry the recorded override payload
    // an architect may want to inspect after the fact. The drill-in
    // affordance must therefore stay rendered on resolved rows too.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    hoisted.divergences = [
      {
        id: "div-resolved",
        bimModelId: "bim-1",
        materializableElementId: "elem-A",
        briefingId: "brief-1",
        reason: "geometry-edited",
        note: null,
        detail: { before: { area: 1 }, after: { area: 2 } },
        createdAt: "2025-01-05T12:00:00.000Z",
        elementKind: "buildable-envelope",
        elementLabel: "Envelope (lot 12)",
        resolvedAt: oneHourAgo,
        resolvedByRequestor: {
          kind: "user",
          id: "user-7",
          displayName: "Alex Architect",
        },
      },
    ];
    renderPanel();

    // Resolved partition is collapsed by default — expand it so the
    // resolved row is in the document tree.
    fireEvent.click(
      screen.getByTestId("briefing-divergences-resolved-toggle"),
    );

    const viewBtn = screen.getByTestId(
      "briefing-divergences-view-details-button",
    );
    expect(viewBtn).toHaveAttribute("data-divergence-id", "div-resolved");
    // No Resolve button on a resolved row.
    expect(
      screen.queryByTestId("briefing-divergences-resolve-button"),
    ).toBeNull();

    fireEvent.click(viewBtn);
    expect(
      screen.getByTestId("briefing-divergence-detail-dialog"),
    ).toBeInTheDocument();
  });

  // Task #358 — defensive coverage for the dialog's
  // `extractDetailViews` fallback. The C# Revit recorder writes a
  // free-shape `detail` blob and the dialog deliberately falls back
  // to the flat-attributes table when `before` / `after` is present
  // but is not a plain object pair (a scalar, an array, or only one
  // half of the envelope). Without these tests, a future refactor
  // that tightened the typing or threw on the malformed shape would
  // regress the user-facing dialog from "shows the recorded fields
  // as a key/value table" to "crashes the panel".
  //
  // For each malformed shape we assert: the dialog mounts, the
  // 3-column diff section is *not* rendered (since the envelope
  // wasn't a usable pair), and the `before` / `after` keys land in
  // the flat-attributes table with their values stringified — for
  // arrays and objects that's the JSON-pretty-printed form
  // `stringifyValue` produces.
  describe("malformed before/after payloads (Task #358)", () => {
    function openDetailDialogWithDetail(detail: Record<string, unknown>) {
      hoisted.divergences = [
        {
          id: "div-malformed",
          bimModelId: "bim-1",
          materializableElementId: "elem-A",
          briefingId: "brief-1",
          reason: "geometry-edited",
          note: null,
          detail,
          createdAt: "2025-01-05T12:00:00.000Z",
          elementKind: "buildable-envelope",
          elementLabel: "Envelope (lot 12)",
        },
      ];
      renderPanel();
      fireEvent.click(
        screen.getByTestId("briefing-divergences-view-details-button"),
      );
      return screen.getByTestId("briefing-divergence-detail-dialog");
    }

    it("renders the flat-attributes table for a scalar before/after pair without crashing", () => {
      const dialog = openDetailDialogWithDetail({ before: 5, after: 6 });

      // No diff section — the envelope wasn't a plain-object pair.
      expect(
        within(dialog).queryByTestId("briefing-divergence-detail-diff"),
      ).not.toBeInTheDocument();
      expect(
        within(dialog).queryAllByTestId("briefing-divergence-detail-diff-row"),
      ).toHaveLength(0);

      // The flat-attributes table renders both halves as scalar
      // strings, so the operator still sees what was recorded.
      const rowsByField = new Map(
        within(dialog)
          .getAllByTestId("briefing-divergence-detail-attribute-row")
          .map((r) => [r.getAttribute("data-field"), r] as const),
      );
      expect(rowsByField.get("before")).toBeDefined();
      expect(rowsByField.get("after")).toBeDefined();
      expect(rowsByField.get("before")).toHaveTextContent("5");
      expect(rowsByField.get("after")).toHaveTextContent("6");
    });

    it("renders the flat-attributes table for an array before/after pair without crashing", () => {
      const dialog = openDetailDialogWithDetail({
        before: [1, 2],
        after: [3, 4],
      });

      // Arrays aren't plain objects — the diff branch must stay
      // dormant so the dialog doesn't try to key into array indices
      // as a 3-column field/before/after diff.
      expect(
        within(dialog).queryByTestId("briefing-divergence-detail-diff"),
      ).not.toBeInTheDocument();
      expect(
        within(dialog).queryAllByTestId("briefing-divergence-detail-diff-row"),
      ).toHaveLength(0);

      const rowsByField = new Map(
        within(dialog)
          .getAllByTestId("briefing-divergence-detail-attribute-row")
          .map((r) => [r.getAttribute("data-field"), r] as const),
      );
      // The raw envelope is JSON-serialized into the value cell so
      // the operator can still inspect what the recorder wrote.
      // We assert on the array contents (whitespace-tolerant)
      // rather than the exact pretty-printed string so a future
      // tweak to `stringifyValue`'s indentation doesn't break the
      // test for the wrong reason.
      const beforeText = rowsByField.get("before")?.textContent ?? "";
      const afterText = rowsByField.get("after")?.textContent ?? "";
      expect(beforeText).toContain("1");
      expect(beforeText).toContain("2");
      expect(afterText).toContain("3");
      expect(afterText).toContain("4");
    });

    it("renders the flat-attributes table when only one half of the before/after pair is present", () => {
      const dialog = openDetailDialogWithDetail({ before: { x: 1 } });

      // Only `before` is present — the diff branch only fires when
      // both halves are plain objects, so it must stay dormant and
      // the lone half must surface in the flat-attributes table
      // rather than being hidden as if it were already represented.
      expect(
        within(dialog).queryByTestId("briefing-divergence-detail-diff"),
      ).not.toBeInTheDocument();
      expect(
        within(dialog).queryAllByTestId("briefing-divergence-detail-diff-row"),
      ).toHaveLength(0);

      const rowsByField = new Map(
        within(dialog)
          .getAllByTestId("briefing-divergence-detail-attribute-row")
          .map((r) => [r.getAttribute("data-field"), r] as const),
      );
      expect(rowsByField.get("before")).toBeDefined();
      // No `after` key was on the envelope so it must not appear
      // as an attribute row — the dialog only surfaces what the
      // recorder actually wrote.
      expect(rowsByField.has("after")).toBe(false);
      const beforeText = rowsByField.get("before")?.textContent ?? "";
      expect(beforeText).toContain("x");
      expect(beforeText).toContain("1");
    });
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
