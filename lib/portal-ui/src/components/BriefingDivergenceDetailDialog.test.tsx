/**
 * Component-level tests for the shared `BriefingDivergenceDetailDialog`.
 *
 * Lives next to the component (Task #362) so the dialog's
 * `extractDetailViews` fan-out — 3-column diff vs. flat-attributes
 * fallback — can be exercised against the rendered DOM without the
 * design-tools `BriefingDivergencesPanel` scaffolding (QueryClient,
 * hoisted hook mocks, panel grouping). Task #358 first added the
 * defensive coverage inside `artifacts/design-tools/src/pages/__tests__/
 * BriefingDivergencesPanel.test.tsx`; that suite stays valid, but
 * shared-library regression coverage now has a natural home in
 * portal-ui itself so a refactor that touches only this file can
 * never ship without ever running a portal-ui-scoped test.
 *
 * The dialog has no `useQuery`-style hooks, so we mount it directly
 * and feed it the `BimModelDivergenceListEntry` shape the api-client
 * returns. Each case asserts on the published testids
 * (`briefing-divergence-detail-{diff,attributes,empty,…}`) so the
 * tests pin observable behavior rather than internal implementation.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import type { BimModelDivergenceListEntry } from "@workspace/api-client-react";
import { BriefingDivergenceDetailDialog } from "./BriefingDivergenceDetailDialog";

function makeDivergence(
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

describe("BriefingDivergenceDetailDialog", () => {
  it("renders nothing when divergence is null", () => {
    const { container } = render(
      <BriefingDivergenceDetailDialog divergence={null} onClose={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(
      screen.queryByTestId("briefing-divergence-detail-dialog"),
    ).not.toBeInTheDocument();
  });

  it("renders a 3-column diff plus the side-channel attribute when before/after are plain objects", () => {
    // The common `geometry-edited` shape: before/after envelope plus
    // a forward-compat `revitElementId` reference. Both surfaces must
    // be present — the diff for the envelope, the flat-attributes
    // table for the side-channel field.
    render(
      <BriefingDivergenceDetailDialog
        divergence={makeDivergence({
          detail: {
            before: { area: 100, height: 12 },
            after: { area: 110, height: 14 },
            revitElementId: 9876,
          },
        })}
        onClose={() => {}}
      />,
    );

    const dialog = screen.getByTestId("briefing-divergence-detail-dialog");

    // Header: kind + reason label, plus the element label.
    expect(within(dialog).getByText(/Buildable envelope/i)).toBeInTheDocument();
    expect(within(dialog).getByText("Envelope (lot 12)")).toBeInTheDocument();

    // 3-column diff section is present and lists exactly the union of
    // before+after keys — no duplicate envelope row in the flat-
    // attributes table since both halves were usable.
    const diffRows = within(dialog).getAllByTestId(
      "briefing-divergence-detail-diff-row",
    );
    expect(
      diffRows.map((r) => r.getAttribute("data-field")).sort(),
    ).toEqual(["area", "height"]);

    // Side-channel field surfaces in the flat-attributes table; the
    // `before` / `after` envelope keys are deliberately NOT duplicated
    // there because the diff section already represents them.
    const attrFields = within(dialog)
      .getAllByTestId("briefing-divergence-detail-attribute-row")
      .map((r) => r.getAttribute("data-field"));
    expect(attrFields).toContain("revitElementId");
    expect(attrFields).not.toContain("before");
    expect(attrFields).not.toContain("after");
  });

  it("falls back to the flat-attributes table for a scalar before/after pair without crashing", () => {
    // Defensive coverage for the `extractDetailViews` fallback —
    // a malformed scalar envelope must not crash and the operator
    // must still see what was recorded as flat key/value rows.
    render(
      <BriefingDivergenceDetailDialog
        divergence={makeDivergence({ detail: { before: 5, after: 6 } })}
        onClose={() => {}}
      />,
    );

    const dialog = screen.getByTestId("briefing-divergence-detail-dialog");
    expect(
      within(dialog).queryByTestId("briefing-divergence-detail-diff"),
    ).not.toBeInTheDocument();

    const rowsByField = new Map(
      within(dialog)
        .getAllByTestId("briefing-divergence-detail-attribute-row")
        .map((r) => [r.getAttribute("data-field"), r] as const),
    );
    expect(rowsByField.get("before")).toHaveTextContent("5");
    expect(rowsByField.get("after")).toHaveTextContent("6");
  });

  it("falls back to the flat-attributes table for an array before/after pair without crashing", () => {
    // Arrays aren't plain objects — the diff branch must stay
    // dormant so the dialog doesn't try to key into array indices
    // as field names.
    render(
      <BriefingDivergenceDetailDialog
        divergence={makeDivergence({
          detail: { before: [1, 2], after: [3, 4] },
        })}
        onClose={() => {}}
      />,
    );

    const dialog = screen.getByTestId("briefing-divergence-detail-dialog");
    expect(
      within(dialog).queryByTestId("briefing-divergence-detail-diff"),
    ).not.toBeInTheDocument();

    const rowsByField = new Map(
      within(dialog)
        .getAllByTestId("briefing-divergence-detail-attribute-row")
        .map((r) => [r.getAttribute("data-field"), r] as const),
    );
    // The raw array is JSON-serialized into the value cell so the
    // operator can still inspect what the recorder wrote. We assert
    // the contents are surfaced without coupling to exact
    // pretty-printed whitespace from `stringifyValue`.
    const beforeText = rowsByField.get("before")?.textContent ?? "";
    const afterText = rowsByField.get("after")?.textContent ?? "";
    expect(beforeText).toContain("1");
    expect(beforeText).toContain("2");
    expect(afterText).toContain("3");
    expect(afterText).toContain("4");
  });

  it("falls back to the flat-attributes table when only one half of the envelope is present", () => {
    // A lone `before` (no `after`) must surface as a flat-attribute
    // row rather than being hidden as if it were already represented
    // in the diff table.
    render(
      <BriefingDivergenceDetailDialog
        divergence={makeDivergence({ detail: { before: { x: 1 } } })}
        onClose={() => {}}
      />,
    );

    const dialog = screen.getByTestId("briefing-divergence-detail-dialog");
    expect(
      within(dialog).queryByTestId("briefing-divergence-detail-diff"),
    ).not.toBeInTheDocument();

    const rowsByField = new Map(
      within(dialog)
        .getAllByTestId("briefing-divergence-detail-attribute-row")
        .map((r) => [r.getAttribute("data-field"), r] as const),
    );
    expect(rowsByField.get("before")).toBeDefined();
    expect(rowsByField.has("after")).toBe(false);
    const beforeText = rowsByField.get("before")?.textContent ?? "";
    expect(beforeText).toContain("x");
    expect(beforeText).toContain("1");
  });

  it("renders the empty-state copy when detail has no fields at all", () => {
    render(
      <BriefingDivergenceDetailDialog
        divergence={makeDivergence({ detail: {} })}
        onClose={() => {}}
      />,
    );
    const dialog = screen.getByTestId("briefing-divergence-detail-dialog");
    expect(
      within(dialog).getByTestId("briefing-divergence-detail-empty"),
    ).toHaveTextContent("No structured detail was recorded for this override.");
    expect(
      within(dialog).queryByTestId("briefing-divergence-detail-diff"),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByTestId("briefing-divergence-detail-attributes"),
    ).not.toBeInTheDocument();
  });

  it("surfaces the architect note when present", () => {
    render(
      <BriefingDivergenceDetailDialog
        divergence={makeDivergence({ note: "Pulled the envelope south by 2ft" })}
        onClose={() => {}}
      />,
    );
    const dialog = screen.getByTestId("briefing-divergence-detail-dialog");
    expect(
      within(dialog).getByTestId("briefing-divergence-detail-note"),
    ).toHaveTextContent("Pulled the envelope south by 2ft");
  });

  it("renders the acknowledgement section only when the row is resolved", () => {
    const { rerender } = render(
      <BriefingDivergenceDetailDialog
        divergence={makeDivergence({ resolvedAt: null })}
        onClose={() => {}}
      />,
    );
    expect(
      screen.queryByTestId("briefing-divergence-detail-acknowledgement"),
    ).not.toBeInTheDocument();

    rerender(
      <BriefingDivergenceDetailDialog
        divergence={makeDivergence({
          resolvedAt: "2025-01-06T08:00:00.000Z",
          resolvedByRequestor: {
            kind: "user",
            id: "user-7",
            displayName: "Alex Architect",
          },
        })}
        onClose={() => {}}
      />,
    );
    const ack = screen.getByTestId(
      "briefing-divergence-detail-acknowledgement",
    );
    // The acknowledgement text is owned by `formatResolvedAcknowledgement`
    // — we just pin that the named requestor's display name flows
    // through into the section so attribution can't quietly drop.
    expect(ack).toHaveTextContent("Alex Architect");
  });

  it("invokes onClose when the close button is clicked", () => {
    const onClose = vi.fn();
    render(
      <BriefingDivergenceDetailDialog
        divergence={makeDivergence()}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByTestId("briefing-divergence-detail-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("invokes onClose when the backdrop is clicked but not when the dialog body is clicked", () => {
    const onClose = vi.fn();
    render(
      <BriefingDivergenceDetailDialog
        divergence={makeDivergence()}
        onClose={onClose}
      />,
    );
    // Click on the dialog body (the `role="dialog"` element) — the
    // component stops propagation here so the backdrop handler must
    // NOT fire.
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();

    // Click the backdrop wrapper itself (the testid'd outer node)
    // — onClose should fire exactly once.
    fireEvent.click(screen.getByTestId("briefing-divergence-detail-dialog"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
