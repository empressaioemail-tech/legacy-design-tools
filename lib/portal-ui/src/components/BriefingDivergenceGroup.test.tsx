/**
 * Component-level tests for the shared `BriefingDivergenceGroup`.
 *
 * Lives next to the component (Task #390, completing the portal-ui
 * sibling-test set started in Tasks #362 / #367 / #377 / #387) so the
 * group card's element-kind label lookup, the deleted-element
 * fallback copy ("Element no longer in briefing"), the optional
 * `elementLabel` line, the documented `data-element-id` attribute,
 * and the `renderRow` callback (which is the integration seam each
 * surface uses to plug in its own `BriefingDivergenceRow` wrapper)
 * stay pinned without leaning on whichever artifact (plan-review or
 * design-tools) happens to import the group card first.
 *
 * The duplicated coverage on
 * `artifacts/design-tools/src/pages/__tests__/BriefingDivergencesPanel.test.tsx`
 * (the integration suite that mounts the panel + group + row) stays
 * valid, but a refactor that touches only the shared group can no
 * longer ship without ever running a portal-ui-scoped test.
 *
 * The group has no `useQuery`-style hooks and no module-level state
 * to mock — every helper it pulls in
 * (`MATERIALIZABLE_ELEMENT_KIND_LABELS`) lives in the same
 * `../lib/briefing-divergences` source module. We mount the group
 * directly with the `BriefingDivergenceGroupShape` the panel feeds
 * it and pin the documented testids / `data-*` attributes that the
 * integration tests on both surfaces already rely on.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { BimModelDivergenceListEntry } from "@workspace/api-client-react";
import { BriefingDivergenceGroup } from "./BriefingDivergenceGroup";
import type { BriefingDivergenceGroupShape } from "../lib/briefing-divergences";

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

function makeGroup(
  overrides: Partial<BriefingDivergenceGroupShape> = {},
): BriefingDivergenceGroupShape {
  return {
    elementId: "elem-A",
    elementKind: "buildable-envelope",
    elementLabel: "Envelope (lot 12)",
    rows: [makeRow()],
    ...overrides,
  };
}

describe("BriefingDivergenceGroup", () => {
  it("renders the documented testid + data-element-id for the parent element", () => {
    // The card exposes its parent element id via `data-element-id`
    // so surface-level tests on both consumers can scope into the
    // same-element bucket without having to re-derive the id from
    // the rows it contains.
    render(
      <BriefingDivergenceGroup
        group={makeGroup({ elementId: "elem-XYZ" })}
        renderRow={() => null}
      />,
    );
    const card = screen.getByTestId("briefing-divergences-group");
    expect(card).toHaveAttribute("data-element-id", "elem-XYZ");
  });

  it("renders the human-readable label for each known materializable-element kind", () => {
    // Pin every known-kind branch in one suite — the lookup
    // degrades to the raw `elementKind` string (covered
    // separately below) and to "Element no longer in briefing"
    // when the kind is null. Both fallbacks would silently swap
    // the headline copy without this case if the labels map
    // ever lost an entry.
    const cases: Array<{ kind: string; label: string }> = [
      { kind: "terrain", label: "Terrain" },
      { kind: "property-line", label: "Property line" },
      { kind: "setback-plane", label: "Setback plane" },
      { kind: "buildable-envelope", label: "Buildable envelope" },
      { kind: "floodplain", label: "Floodplain" },
      { kind: "wetland", label: "Wetland" },
      { kind: "neighbor-mass", label: "Neighbor mass" },
    ];
    for (const { kind, label } of cases) {
      const { unmount } = render(
        <BriefingDivergenceGroup
          group={makeGroup({ elementKind: kind })}
          renderRow={() => null}
        />,
      );
      const card = screen.getByTestId("briefing-divergences-group");
      expect(card).toHaveTextContent(label);
      unmount();
    }
  });

  it("falls back to the raw kind string when the kind is unknown to the labels map", () => {
    // Schema-grew-on-server fallback. A new materializable-element
    // kind shipped from the server-side enum without a matching
    // entry on this map would otherwise blank out the headline —
    // pin the raw string surfaces verbatim so a reviewer can
    // still tell which element the group represents.
    render(
      <BriefingDivergenceGroup
        group={makeGroup({ elementKind: "newly-added-kind" })}
        renderRow={() => null}
      />,
    );
    const card = screen.getByTestId("briefing-divergences-group");
    expect(card).toHaveTextContent("newly-added-kind");
  });

  it("falls back to 'Element no longer in briefing' when the kind is null", () => {
    // Deleted-from-briefing branch — the row's parent element no
    // longer carries kind / label metadata because the briefing
    // dropped it. The group must still render so the recorded
    // override stays auditable, with a copy that explains the
    // missing kind rather than an empty header.
    render(
      <BriefingDivergenceGroup
        group={makeGroup({ elementKind: null, elementLabel: null })}
        renderRow={() => null}
      />,
    );
    const card = screen.getByTestId("briefing-divergences-group");
    expect(card).toHaveTextContent("Element no longer in briefing");
  });

  it("renders the elementLabel beneath the kind headline when present", () => {
    // The label is the human-friendly element name (e.g. "Envelope
    // (lot 12)") that the briefing carries alongside the kind.
    // It's the only way a reviewer can disambiguate two
    // same-kind elements in the same briefing — pin it surfaces
    // when present.
    render(
      <BriefingDivergenceGroup
        group={makeGroup({
          elementKind: "buildable-envelope",
          elementLabel: "Envelope (lot 12)",
        })}
        renderRow={() => null}
      />,
    );
    const card = screen.getByTestId("briefing-divergences-group");
    expect(card).toHaveTextContent("Buildable envelope");
    expect(card).toHaveTextContent("Envelope (lot 12)");
  });

  it("omits the elementLabel slot when the briefing never attached one", () => {
    // The label is conditional — null must not render an empty
    // line under the kind headline (would push the row chrome
    // around for no copy). Pin the absence by checking that the
    // card has no extra text beyond the kind label and the
    // rendered rows.
    render(
      <BriefingDivergenceGroup
        group={makeGroup({
          elementKind: "terrain",
          elementLabel: null,
          rows: [],
        })}
        renderRow={() => null}
      />,
    );
    const card = screen.getByTestId("briefing-divergences-group");
    expect(card).toHaveTextContent("Terrain");
    // No "Envelope (lot 12)" or other prior label leaks through.
    expect(card.textContent).toBe("Terrain");
  });

  it("calls renderRow exactly once per row, in payload order, with the row entry as the argument", () => {
    // `renderRow` is the integration seam each surface uses to
    // plug in its own `BriefingDivergenceRow` wrapper (architect:
    // Resolve mutation right-slot; reviewer: View details right-
    // slot wired into `BriefingDivergenceDetailDialog`). Pin
    // both the call count and the row identity so a refactor
    // that flips the iteration order or accidentally double-
    // renders a row can't ship.
    const renderRow = vi.fn((row: BimModelDivergenceListEntry) => (
      <div
        key={row.id}
        data-testid={`stub-row-${row.id}`}
        data-divergence-reason={row.reason}
      />
    ));
    const rows = [
      makeRow({ id: "div-1", reason: "geometry-edited" }),
      makeRow({ id: "div-2", reason: "unpinned" }),
      makeRow({ id: "div-3", reason: "deleted" }),
    ];
    render(
      <BriefingDivergenceGroup
        group={makeGroup({ rows })}
        renderRow={renderRow}
      />,
    );

    // Exactly one call per row, in payload order.
    expect(renderRow).toHaveBeenCalledTimes(3);
    expect(renderRow.mock.calls.map((c) => c[0].id)).toEqual([
      "div-1",
      "div-2",
      "div-3",
    ]);

    // The DOM mirrors the call order — proves the group doesn't
    // re-sort the rows server-side ordering must win because the
    // server already returns Open-first / newest-first.
    const card = screen.getByTestId("briefing-divergences-group");
    const stubs = within(card).getAllByTestId(/^stub-row-/);
    expect(stubs.map((s) => s.dataset.testid)).toEqual([
      "stub-row-div-1",
      "stub-row-div-2",
      "stub-row-div-3",
    ]);
  });

  it("renders nothing inside the rows container when the group has no rows", () => {
    // Defensive guard — a group with zero rows shouldn't crash
    // the iteration. The card itself still renders so the panel
    // can still surface the parent element header.
    const renderRow = vi.fn();
    render(
      <BriefingDivergenceGroup
        group={makeGroup({ rows: [] })}
        renderRow={renderRow}
      />,
    );
    expect(renderRow).not.toHaveBeenCalled();
    expect(screen.getByTestId("briefing-divergences-group")).toBeInTheDocument();
  });
});
