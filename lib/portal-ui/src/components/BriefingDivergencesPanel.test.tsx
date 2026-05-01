/**
 * Component-level tests for the shared `BriefingDivergencesPanel`.
 *
 * Lives next to the component (Task #390, completing the portal-ui
 * sibling-test set started in Tasks #362 / #367 / #377 / #387) so the
 * panel's loading-vs-error-vs-empty fan-out, the Open-vs-Resolved
 * partition, the per-element grouping (forwarded down through
 * `BriefingDivergenceGroup`), the resolved-section collapse-by-
 * default toggle, the open count badge, the title / description
 * copy override (architect default vs. reviewer override), the
 * lazy-fetch gate that keeps `useListBimModelDivergences` idle
 * until the bim-model id resolves, and the click-through `renderRow`
 * seam that drives `BriefingDivergenceDetailDialog` on the reviewer
 * surface all stay pinned without leaning on whichever artifact
 * (plan-review or design-tools) happens to import the panel first.
 *
 * The duplicated coverage on
 * `artifacts/design-tools/src/pages/__tests__/BriefingDivergencesPanel.test.tsx`
 * (the integration suite that mounts the panel under the architect
 * surface) and `artifacts/plan-review/src/components/__tests__/
 * BimModelTab.test.tsx` (the integration suite that mounts the
 * panel under the reviewer surface) stay valid, but a refactor that
 * touches only the shared panel can no longer ship without ever
 * running a portal-ui-scoped test.
 *
 * `@workspace/api-client-react` is mocked so we can:
 *   - control what `useGetEngagementBimModel` returns (data +
 *     isLoading) so the loading / no-bim-model / has-bim-model
 *     branches can be exercised deterministically,
 *   - control what `useListBimModelDivergences` returns (data +
 *     isLoading + isError) so the loading / error / empty / open /
 *     open+resolved / resolved-only branches each get their own
 *     case,
 *   - capture the arguments the panel passes into the divergences
 *     hook — specifically the `enabled` lazy-fetch gate and the
 *     `queryKey` shape — so the contract it shares with the
 *     architect-side resolve mutation's `invalidateQueries` call
 *     can't drift,
 *   - hand back a stable `getListBimModelDivergencesQueryKey` whose
 *     shape mirrors what the design-tools-side test mocks, so the
 *     "shared cache-key contract" assertion really proves the two
 *     surfaces line up.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import type { BimModelDivergenceListEntry } from "@workspace/api-client-react";

// ── Hoisted state shared with the mocks ────────────────────────────
//
// Each test mutates these slots before mounting the panel so the
// loading / error / empty / has-rows branches each get a focused
// case. Arg-capture lists let us assert what the panel passed into
// `useListBimModelDivergences` (the lazy-fetch gate + the
// queryKey contract).
const hoisted = vi.hoisted(() => ({
  bimModel: {
    data: undefined as
      | undefined
      | { bimModel: { id: string } | null },
    isLoading: false,
  },
  divergences: {
    data: undefined as
      | undefined
      | { divergences: Array<Record<string, unknown>> },
    isLoading: false,
    isError: false,
    calls: [] as Array<{
      bimModelId: string;
      options?: {
        query?: {
          enabled?: boolean;
          queryKey?: unknown;
          staleTime?: number;
        };
      };
    }>,
  },
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetEngagementBimModel: (_engagementId: string) => ({
    data: hoisted.bimModel.data,
    isLoading: hoisted.bimModel.isLoading,
  }),
  useListBimModelDivergences: (
    bimModelId: string,
    options?: {
      query?: {
        enabled?: boolean;
        queryKey?: unknown;
        staleTime?: number;
      };
    },
  ) => {
    hoisted.divergences.calls.push({ bimModelId, options });
    return {
      data: hoisted.divergences.data,
      isLoading: hoisted.divergences.isLoading,
      isError: hoisted.divergences.isError,
    };
  },
  // Stable key shape — must match what the design-tools-side test
  // mock exposes so the "shared cache-key contract" assertion really
  // proves the two surfaces line up. The design-tools integration
  // test (`artifacts/design-tools/src/pages/__tests__/BriefingDivergencesPanel.test.tsx`)
  // overrides this with `["listBimModelDivergences", id]`; we mirror
  // that so the queryKey assertion below pins the same shape both
  // sides agree on.
  getListBimModelDivergencesQueryKey: (bimModelId: string) => [
    "listBimModelDivergences",
    bimModelId,
  ],
}));

const { BriefingDivergencesPanel } = await import("./BriefingDivergencesPanel");

function makeRow(
  overrides: Partial<BimModelDivergenceListEntry> = {},
): BimModelDivergenceListEntry {
  return {
    id: "div-1",
    bimModelId: "bim-1",
    materializableElementId: "elem-A",
    briefingId: "brief-1",
    reason: "geometry-edited",
    note: null,
    detail: {},
    createdAt: "2025-01-05T12:00:00.000Z",
    resolvedAt: null,
    resolvedByRequestor: null,
    elementKind: "buildable-envelope",
    elementLabel: "Envelope (lot 12)",
    ...overrides,
  };
}

beforeEach(() => {
  hoisted.bimModel.data = { bimModel: { id: "bim-1" } };
  hoisted.bimModel.isLoading = false;
  hoisted.divergences.data = { divergences: [] };
  hoisted.divergences.isLoading = false;
  hoisted.divergences.isError = false;
  hoisted.divergences.calls = [];
});

describe("BriefingDivergencesPanel", () => {
  it("renders nothing while the bim-model query is in-flight (defensive — applies to both surfaces)", () => {
    // The panel hides itself until the engagement has actually
    // been pushed to Revit at least once. The same gate the
    // architect's affordance uses — a flash of "Architect
    // overrides in Revit" with an empty list during the
    // bim-model fetch would imply no overrides exist when the
    // truth is unknown. Pin the null-render so a refactor that
    // demotes the loading-gate can't ship.
    hoisted.bimModel.isLoading = true;
    hoisted.bimModel.data = undefined;
    const { container } = render(
      <BriefingDivergencesPanel
        engagementId="eng-1"
        renderRow={() => null}
      />,
    );
    expect(container.firstChild).toBeNull();
    expect(
      screen.queryByTestId("briefing-divergences-panel"),
    ).not.toBeInTheDocument();
  });

  it("renders nothing when the engagement has no bim-model (no Push has happened yet)", () => {
    // Same gate, second branch — the engagement loaded fine but
    // no bim-model has ever been pushed. The architect's
    // affordance and the reviewer's BIM Model tab both rely on
    // this null-render so a fresh engagement doesn't surface an
    // empty card. The reviewer surface (plan-review) shows its
    // own "No BIM model recorded yet" card instead, which sits
    // above this panel.
    hoisted.bimModel.data = { bimModel: null };
    const { container } = render(
      <BriefingDivergencesPanel
        engagementId="eng-1"
        renderRow={() => null}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("keeps the divergences hook idle (enabled=false) until the bim-model id resolves", () => {
    // Lazy-fetch gate — without this the divergences hook would
    // fire a `/api/bim-models//divergences` call while the
    // bim-model fetch is still in-flight. Pin the gate is wired
    // even though the panel returns null (React still calls the
    // hook on first render — hooks can't be conditionally
    // called).
    hoisted.bimModel.isLoading = true;
    hoisted.bimModel.data = undefined;
    render(
      <BriefingDivergencesPanel
        engagementId="eng-1"
        renderRow={() => null}
      />,
    );
    const last = hoisted.divergences.calls.at(-1);
    expect(last?.bimModelId).toBe("");
    expect(last?.options?.query?.enabled).toBe(false);
  });

  it("passes the same queryKey the resolve-mutation invalidates against (shared cache contract)", () => {
    // The architect-side resolve mutation invalidates this exact
    // key on success. If the panel hand-rolled the key here (or
    // dropped the explicit `queryKey` from the options), the
    // resolve action would still succeed but the panel would
    // never refetch — the row would stay Open until a manual
    // page reload. Pin the shape here so the two sides can't
    // drift.
    hoisted.bimModel.data = { bimModel: { id: "bim-XYZ" } };
    render(
      <BriefingDivergencesPanel
        engagementId="eng-1"
        renderRow={() => null}
      />,
    );
    const last = hoisted.divergences.calls.at(-1);
    expect(last?.bimModelId).toBe("bim-XYZ");
    expect(last?.options?.query?.enabled).toBe(true);
    expect(last?.options?.query?.queryKey).toEqual([
      "listBimModelDivergences",
      "bim-XYZ",
    ]);
    // The 60s staleTime is the panel's own mild-cache contract
    // so a tab-switch round-trip doesn't re-spin the spinner.
    expect(last?.options?.query?.staleTime).toBe(60_000);
  });

  it("renders the loading copy while the divergences query is in-flight", () => {
    hoisted.divergences.isLoading = true;
    hoisted.divergences.data = undefined;
    render(
      <BriefingDivergencesPanel
        engagementId="eng-1"
        renderRow={() => null}
      />,
    );
    expect(
      screen.getByTestId("briefing-divergences-loading"),
    ).toBeInTheDocument();
    // The empty / list / error testids must NOT be in the tree
    // during loading — the four states are mutually exclusive.
    expect(
      screen.queryByTestId("briefing-divergences-empty"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("briefing-divergences-list"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("briefing-divergences-error"),
    ).not.toBeInTheDocument();
  });

  it("surfaces the error copy when the divergences query rejects", () => {
    hoisted.divergences.isError = true;
    hoisted.divergences.isLoading = false;
    hoisted.divergences.data = undefined;
    render(
      <BriefingDivergencesPanel
        engagementId="eng-1"
        renderRow={() => null}
      />,
    );
    const err = screen.getByTestId("briefing-divergences-error");
    expect(err).toBeInTheDocument();
    // role=alert so screen readers pick the error up immediately
    // — pin the role so a refactor that swaps the wrapper for a
    // plain div can't quietly drop the announce.
    expect(err).toHaveAttribute("role", "alert");
    expect(err).toHaveTextContent(/couldn.?t load recent overrides/i);
  });

  it("renders the empty-state copy when no divergences have been recorded", () => {
    hoisted.divergences.data = { divergences: [] };
    render(
      <BriefingDivergencesPanel
        engagementId="eng-1"
        renderRow={() => null}
      />,
    );
    const empty = screen.getByTestId("briefing-divergences-empty");
    expect(empty).toBeInTheDocument();
    expect(empty).toHaveTextContent(
      "No overrides recorded yet — the briefing matches what's in Revit.",
    );
  });

  it("renders the architect-default title + description copy when no overrides are passed", () => {
    // Default copy is the architect-facing wording so design-tools
    // can mount the panel without overriding anything. The
    // reviewer surface in plan-review passes its own neutral copy
    // (covered separately below) — pin the architect default so
    // a refactor that flips the default to the reviewer copy
    // can't sneak past either consumer's expectations.
    render(
      <BriefingDivergencesPanel
        engagementId="eng-1"
        renderRow={() => null}
      />,
    );
    const panel = screen.getByTestId("briefing-divergences-panel");
    expect(panel).toHaveTextContent("Architect overrides in Revit");
    expect(panel).toHaveTextContent(
      /the c# add-in records every edit an architect makes/i,
    );
  });

  it("honours the title + description overrides (reviewer-surface neutral copy)", () => {
    // Plan-review's BimModelTab passes "BIM model overrides"
    // because the reviewer is reading as a neutral observer
    // rather than the editing party. Pin both override slots so
    // a refactor that drops one of them can't slip past the
    // reviewer surface (which would otherwise read as "Architect
    // overrides in Revit" in a reviewer-side modal).
    render(
      <BriefingDivergencesPanel
        engagementId="eng-1"
        renderRow={() => null}
        title="BIM model overrides"
        description="Click a row to see the briefing-vs-Revit diff."
      />,
    );
    const panel = screen.getByTestId("briefing-divergences-panel");
    expect(panel).toHaveTextContent("BIM model overrides");
    expect(panel).toHaveTextContent(
      "Click a row to see the briefing-vs-Revit diff.",
    );
    // The architect default copy must NOT leak through when
    // overrides are supplied — pin the absence so a future
    // refactor that hand-merges the two strings can't ship.
    expect(panel).not.toHaveTextContent("Architect overrides in Revit");
  });

  it("renders the open count badge with `data-open-count` reflecting the open partition size", () => {
    // The open count badge is the number that the engagement-list
    // tally cards key off — pin the `data-open-count` attribute
    // so a refactor that miscounts (or accidentally counts
    // resolved rows too) can't ship. Resolved rows must not
    // contribute to the count.
    hoisted.divergences.data = {
      divergences: [
        makeRow({ id: "div-open-1", resolvedAt: null }),
        makeRow({ id: "div-open-2", resolvedAt: null }),
        makeRow({
          id: "div-resolved-1",
          resolvedAt: "2025-01-06T08:00:00.000Z",
        }),
      ],
    };
    render(
      <BriefingDivergencesPanel
        engagementId="eng-1"
        renderRow={() => null}
      />,
    );
    const badge = screen.getByTestId("briefing-divergences-open-count");
    expect(badge).toHaveAttribute("data-open-count", "2");
    expect(badge).toHaveTextContent("2 open");
  });

  it("partitions divergences into Open and Resolved sections, with Resolved collapsed by default", () => {
    // Two open + one resolved means both sections render; the
    // Resolved section must start collapsed (the toggle's
    // `aria-expanded` reflects the state) so the eye lands on
    // the Open section first. Resolved-list testid must NOT be
    // in the tree until the toggle flips.
    hoisted.divergences.data = {
      divergences: [
        makeRow({ id: "div-open-1", resolvedAt: null }),
        makeRow({
          id: "div-resolved-1",
          materializableElementId: "elem-B",
          resolvedAt: "2025-01-06T08:00:00.000Z",
        }),
      ],
    };
    render(
      <BriefingDivergencesPanel
        engagementId="eng-1"
        renderRow={(row) => (
          <div key={row.id} data-testid={`stub-row-${row.id}`} />
        )}
      />,
    );
    expect(
      screen.getByTestId("briefing-divergences-open-section"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("briefing-divergences-resolved-section"),
    ).toBeInTheDocument();

    // Open list is mounted with the open row; resolved list is
    // gated behind the collapsed toggle so its rows are NOT in
    // the tree yet.
    expect(screen.getByTestId("stub-row-div-open-1")).toBeInTheDocument();
    expect(
      screen.queryByTestId("briefing-divergences-resolved-list"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("stub-row-div-resolved-1")).toBeNull();

    const toggle = screen.getByTestId("briefing-divergences-resolved-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("expands and re-collapses the Resolved section when the toggle is clicked", () => {
    // The toggle is a single state slot — clicking it twice must
    // return the section to collapsed. Pin both transitions so a
    // refactor that flips the latch into an additive open list
    // (or that latches it open after one click) can't ship.
    hoisted.divergences.data = {
      divergences: [
        makeRow({
          id: "div-resolved-1",
          resolvedAt: "2025-01-06T08:00:00.000Z",
        }),
      ],
    };
    render(
      <BriefingDivergencesPanel
        engagementId="eng-1"
        renderRow={(row) => (
          <div key={row.id} data-testid={`stub-row-${row.id}`} />
        )}
      />,
    );
    const toggle = screen.getByTestId("briefing-divergences-resolved-toggle");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByTestId("briefing-divergences-resolved-list"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("stub-row-div-resolved-1")).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByTestId("briefing-divergences-resolved-list"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("stub-row-div-resolved-1")).toBeNull();
  });

  it("renders the 'no open overrides — every recorded override has been acknowledged' hint when only resolved rows remain", () => {
    // Edge case the reviewer surface specifically wants — when
    // every recorded override has been resolved, the Open
    // section disappears and a separate hint surfaces so the
    // reviewer doesn't see a blank Open partition with a
    // collapsed Resolved section underneath. Pin the testid the
    // BimModelTab integration suite asserts against.
    hoisted.divergences.data = {
      divergences: [
        makeRow({
          id: "div-resolved-1",
          resolvedAt: "2025-01-06T08:00:00.000Z",
        }),
      ],
    };
    render(
      <BriefingDivergencesPanel
        engagementId="eng-1"
        renderRow={() => null}
      />,
    );
    expect(
      screen.getByTestId("briefing-divergences-open-empty"),
    ).toHaveTextContent(/every recorded override has been acknowledged/i);
    // The Open section's actual list must NOT be in the tree —
    // pin the absence so a refactor that double-renders the
    // hint plus an empty list can't ship.
    expect(
      screen.queryByTestId("briefing-divergences-open-section"),
    ).not.toBeInTheDocument();
  });

  it("groups same-element divergences into one card and forwards each row through `renderRow`", () => {
    // Two open rows for the same element + one for a different
    // element must collapse into two groups, in payload order
    // (the panel doesn't re-sort — the server returns
    // newest-first within each group). The `renderRow`
    // callback is the integration seam each surface uses to plug
    // in its own `BriefingDivergenceRow` wrapper. Pin both that
    // it's called with each row and that the panel passes the
    // rows through in the original order.
    const renderRow = vi.fn(
      (row: BimModelDivergenceListEntry) => (
        <div key={row.id} data-testid={`stub-row-${row.id}`} />
      ),
    );
    hoisted.divergences.data = {
      divergences: [
        makeRow({
          id: "div-newer",
          materializableElementId: "elem-A",
          createdAt: "2025-01-05T12:00:00.000Z",
        }),
        makeRow({
          id: "div-older",
          materializableElementId: "elem-A",
          reason: "unpinned",
          createdAt: "2025-01-04T08:00:00.000Z",
        }),
        makeRow({
          id: "div-other",
          materializableElementId: "elem-B",
          reason: "deleted",
          createdAt: "2025-01-03T08:00:00.000Z",
          elementKind: "property-line",
          elementLabel: "North property line",
        }),
      ],
    };
    render(
      <BriefingDivergencesPanel
        engagementId="eng-1"
        renderRow={renderRow}
      />,
    );

    // Two groups — same-element rows fold into one card.
    const groups = screen.getAllByTestId("briefing-divergences-group");
    expect(groups).toHaveLength(2);
    const groupA = groups.find(
      (g) => g.getAttribute("data-element-id") === "elem-A",
    );
    expect(groupA).toBeDefined();
    const groupAStubs = within(groupA!).getAllByTestId(/^stub-row-/);
    expect(groupAStubs.map((s) => s.dataset.testid)).toEqual([
      "stub-row-div-newer",
      "stub-row-div-older",
    ]);

    const groupB = groups.find(
      (g) => g.getAttribute("data-element-id") === "elem-B",
    );
    expect(groupB).toBeDefined();
    const groupBStubs = within(groupB!).getAllByTestId(/^stub-row-/);
    expect(groupBStubs.map((s) => s.dataset.testid)).toEqual([
      "stub-row-div-other",
    ]);

    // `renderRow` is called once per row, in payload order.
    expect(renderRow.mock.calls.map((c) => c[0].id)).toEqual([
      "div-newer",
      "div-older",
      "div-other",
    ]);
  });

  it("forwards the divergence id to the `renderRow`-provided right-slot when the reviewer clicks 'View details'", () => {
    // End-to-end click-through wiring the reviewer surface uses
    // to drive `BriefingDivergenceDetailDialog`: the panel
    // hands `renderRow` each row, the row's right-slot wraps a
    // "View details" button keyed off `row.id`, and clicking
    // the button must hand that exact id back to the consumer's
    // selection-state setter. Pin the seam end-to-end here so a
    // refactor that drops the row identity along the way can't
    // leave the dialog opening on the wrong divergence.
    const onOpenDetail = vi.fn();
    hoisted.divergences.data = {
      divergences: [
        makeRow({ id: "div-click-target", resolvedAt: null }),
      ],
    };
    render(
      <BriefingDivergencesPanel
        engagementId="eng-1"
        renderRow={(row) => (
          <button
            key={row.id}
            type="button"
            data-testid="briefing-divergences-view-details-button"
            data-divergence-id={row.id}
            onClick={() => onOpenDetail(row.id)}
          >
            View details
          </button>
        )}
      />,
    );
    const button = screen.getByTestId(
      "briefing-divergences-view-details-button",
    );
    expect(button).toHaveAttribute("data-divergence-id", "div-click-target");
    fireEvent.click(button);
    expect(onOpenDetail).toHaveBeenCalledTimes(1);
    expect(onOpenDetail).toHaveBeenCalledWith("div-click-target");
  });

  it("treats undefined `resolvedAt` (forward-compat partial wire shape) as Open, not Resolved", () => {
    // The panel's filter is `resolvedAt == null`, which catches
    // both `null` and `undefined`. Test fixtures and forward-
    // compat partial wire shapes both fall into the Open
    // partition — pin this so a refactor that tightens the
    // check to `=== null` can't quietly bucket fixture rows
    // into the Resolved section (where they'd hide behind the
    // collapsed toggle).
    hoisted.divergences.data = {
      divergences: [
        // The cast strips `resolvedAt` from the row entirely so
        // the value is `undefined` — exercises the same branch
        // a forward-compat partial response would.
        {
          ...makeRow({ id: "div-open-undef" }),
          resolvedAt: undefined,
        } as unknown as BimModelDivergenceListEntry,
      ],
    };
    render(
      <BriefingDivergencesPanel
        engagementId="eng-1"
        renderRow={(row) => (
          <div key={row.id} data-testid={`stub-row-${row.id}`} />
        )}
      />,
    );
    expect(
      screen.getByTestId("briefing-divergences-open-section"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("stub-row-div-open-undef")).toBeInTheDocument();
    // Open count must reflect the undefined row in the open
    // bucket — proves both the partition and the count agree
    // on the Open-vs-Resolved boundary.
    expect(
      screen.getByTestId("briefing-divergences-open-count"),
    ).toHaveAttribute("data-open-count", "1");
  });
});
