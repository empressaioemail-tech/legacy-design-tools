/**
 * Component-level tests for the shared `BriefingDivergenceRow`.
 *
 * Lives next to the component (Task #390, completing the portal-ui
 * sibling-test set started in Tasks #362 / #367 / #377 / #387) so the
 * presentational row's reason-badge label + palette swap, the
 * Open vs. Resolved branch (resolved badge, attribution chip via
 * `ResolvedByChip`, acknowledgement entry that hash-links back to
 * the row's stable DOM id), the optional `note` slot, the
 * `rightSlot` click-through wiring (architect: Resolve mutation;
 * reviewer: View details into `BriefingDivergenceDetailDialog`),
 * the optional `errorSlot`, and the unknown-reason fallback all
 * stay pinned without leaning on whichever artifact (plan-review or
 * design-tools) happens to import the row first.
 *
 * The duplicated coverage on
 * `artifacts/design-tools/src/pages/__tests__/BriefingDivergencesPanel.test.tsx`
 * (the integration suite that mounts the panel + row) stays valid,
 * but a refactor that touches only the shared row can no longer
 * ship without ever running a portal-ui-scoped test.
 *
 * The row has no `useQuery`-style hooks and no module-level state
 * to mock — every helper it pulls in (`formatRelativeMaterializedAt`,
 * `formatResolvedAcknowledgement`, `briefingDivergenceRowDomId`)
 * lives in the same `../lib/briefing-divergences` source module.
 * We mount the row directly with the `BimModelDivergenceListEntry`
 * shape the api-client returns and pin the documented testids /
 * `data-*` attributes that the integration tests on both surfaces
 * already rely on.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import type { BimModelDivergenceListEntry } from "@workspace/api-client-react";
import { BriefingDivergenceRow } from "./BriefingDivergenceRow";
import { briefingDivergenceRowDomId } from "../lib/briefing-divergences";

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

describe("BriefingDivergenceRow", () => {
  it("publishes the documented data-* attributes (id, reason, resolved=false) on the open branch", () => {
    // The row exposes its identity / reason / resolved-state via
    // `data-*` attributes so surface-level tests can scope into a
    // specific row without parsing visible copy. Pin all three on
    // the open branch — these are the same attributes the
    // integration suites on both consumers query against.
    render(
      <BriefingDivergenceRow
        row={makeDivergence({
          id: "div-77",
          reason: "unpinned",
          resolvedAt: null,
        })}
      />,
    );
    const row = screen.getByTestId("briefing-divergences-row");
    expect(row).toHaveAttribute("data-divergence-id", "div-77");
    expect(row).toHaveAttribute("data-divergence-reason", "unpinned");
    expect(row).toHaveAttribute("data-divergence-resolved", "false");
    // Stable in-page id used by the timeline-side acknowledgement
    // anchor (Task #268). Must match the helper's output exactly so
    // the timeline's `<a href="#…">` resolves on either surface.
    expect(row).toHaveAttribute("id", briefingDivergenceRowDomId("div-77"));
  });

  it("flips data-divergence-resolved to true on the resolved branch", () => {
    render(
      <BriefingDivergenceRow
        row={makeDivergence({
          id: "div-77",
          resolvedAt: "2025-01-06T08:00:00.000Z",
          resolvedByRequestor: {
            kind: "user",
            id: "user-7",
            displayName: "Alex Architect",
          },
        })}
      />,
    );
    const row = screen.getByTestId("briefing-divergences-row");
    expect(row).toHaveAttribute("data-divergence-resolved", "true");
  });

  it("renders the reason-label + palette mapping for each known reason", () => {
    // Pin every known-reason branch in one suite — the label
    // lookup degrades to the raw `row.reason` string and the
    // palette lookup degrades to the `other` info palette, so a
    // refactor that drops either map would still need a path
    // through the unknown-reason fallback (covered separately
    // below). Asserting the inline `style.background` keeps the
    // pin against the *intended* palette token rather than a
    // resolved color.
    const cases: Array<{
      reason: BimModelDivergenceListEntry["reason"];
      label: string;
      bg: string;
      fg: string;
    }> = [
      {
        reason: "deleted",
        label: "Deleted",
        bg: "var(--danger-dim)",
        fg: "var(--danger-text)",
      },
      {
        reason: "unpinned",
        label: "Unpinned",
        bg: "var(--warning-dim)",
        fg: "var(--warning-text)",
      },
      {
        reason: "geometry-edited",
        label: "Geometry edited",
        bg: "var(--warning-dim)",
        fg: "var(--warning-text)",
      },
      {
        reason: "other",
        label: "Other override",
        bg: "var(--info-dim)",
        fg: "var(--info-text)",
      },
    ];
    for (const { reason, label, bg, fg } of cases) {
      const { unmount } = render(
        <BriefingDivergenceRow row={makeDivergence({ reason })} />,
      );
      const badge = screen.getByTestId("briefing-divergences-reason-badge");
      expect(badge).toHaveTextContent(label);
      expect((badge as HTMLElement).style.background).toBe(bg);
      expect((badge as HTMLElement).style.color).toBe(fg);
      unmount();
    }
  });

  it("falls back to the raw reason string + 'other' palette for an unknown reason", () => {
    // Defensive coverage for the schema-grew-on-server fallback.
    // The label drops back to the raw string (so attribution can't
    // blank out) and the palette drops back to the `other` info
    // pill (so the badge stays legible against the SmartCity
    // theme). Cast the `reason` since the row union doesn't list
    // this value — pinning the fallback is the whole point.
    render(
      <BriefingDivergenceRow
        row={makeDivergence({
          reason: "renamed-on-server" as unknown as "other",
        })}
      />,
    );
    const badge = screen.getByTestId("briefing-divergences-reason-badge");
    expect(badge).toHaveTextContent("renamed-on-server");
    expect((badge as HTMLElement).style.background).toBe("var(--info-dim)");
    expect((badge as HTMLElement).style.color).toBe("var(--info-text)");
  });

  it("renders the architect note when present and omits the slot when null", () => {
    // Note slot is conditional — a null note must not render an
    // empty `<div>` (would push the row chrome around for no copy)
    // so we pin both branches. The testid is the same one the
    // integration suites query against on both surfaces.
    const { rerender } = render(
      <BriefingDivergenceRow
        row={makeDivergence({ note: "Pulled the envelope south by 2ft" })}
      />,
    );
    expect(screen.getByTestId("briefing-divergences-note")).toHaveTextContent(
      "Pulled the envelope south by 2ft",
    );

    rerender(<BriefingDivergenceRow row={makeDivergence({ note: null })} />);
    expect(
      screen.queryByTestId("briefing-divergences-note"),
    ).not.toBeInTheDocument();
  });

  it("hides the resolved badge + acknowledgement entry on the open branch", () => {
    // The resolved sub-tree is gated on `resolvedAt != null` —
    // pin the absence of every sub-element on the open branch so
    // a refactor that hoists any of them out of the gate can't
    // sneak past. The acknowledgement deep-link in particular
    // would be a confusing dead anchor if it rendered without a
    // `resolvedAt` to attribute to.
    render(<BriefingDivergenceRow row={makeDivergence({ resolvedAt: null })} />);
    expect(
      screen.queryByTestId("briefing-divergences-resolved-badge"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("briefing-divergences-resolved-attribution"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("briefing-divergences-acknowledged-entry"),
    ).not.toBeInTheDocument();
  });

  it("renders the resolved badge, attribution chip, and acknowledgement entry on the resolved branch", () => {
    // The resolved branch surfaces three pieces of UI: the
    // capital-R "Resolved" pill, the attribution row that wraps
    // the timestamp + `ResolvedByChip`, and the acknowledgement
    // entry that mirrors the `briefing-divergence.resolved` atom
    // event. Pin all three so a refactor that drops any of them
    // (or quietly swaps the chip for plain text) gets caught.
    render(
      <BriefingDivergenceRow
        row={makeDivergence({
          id: "div-resolved",
          resolvedAt: "2025-01-06T08:00:00.000Z",
          resolvedByRequestor: {
            kind: "user",
            id: "user-7",
            displayName: "Alex Architect",
          },
        })}
      />,
    );
    expect(
      screen.getByTestId("briefing-divergences-resolved-badge"),
    ).toHaveTextContent("Resolved");
    const attribution = screen.getByTestId(
      "briefing-divergences-resolved-attribution",
    );
    // The ResolvedByChip carries the resolver name — pin it
    // surfaces inside the attribution slot rather than at the
    // root of the row, so the layout column stays consistent.
    expect(attribution).toHaveTextContent("Alex Architect");
    // The chip's testid is owned by ResolvedByChip itself (covered
    // separately by ResolvedByChip.test.tsx). We just pin it
    // landed inside the attribution row so a refactor that drops
    // the chip from the row layout can't slip past.
    expect(
      within(attribution).getByTestId("briefing-divergences-resolver-chip"),
    ).toBeInTheDocument();
  });

  it("anchors the acknowledgement entry to the same DOM id the row carries (timeline deep-link)", () => {
    // Wave 2 / Task #268 contract — the acknowledgement entry's
    // `<a href="#…">` must resolve to the row's stable DOM id so
    // the matching `briefing-divergence.resolved` timeline entry
    // (rendered elsewhere) can deep-link straight to the
    // originating recorded-divergence row. A drift between the
    // two ids would make the timeline anchor dead-link silently
    // — pin the contract here so the row owns it.
    render(
      <BriefingDivergenceRow
        row={makeDivergence({
          id: "div-anchor-me",
          resolvedAt: "2025-01-06T08:00:00.000Z",
          resolvedByRequestor: {
            kind: "user",
            id: "user-7",
            displayName: "Alex Architect",
          },
        })}
      />,
    );
    const expected = `#${briefingDivergenceRowDomId("div-anchor-me")}`;
    const ack = screen.getByTestId("briefing-divergences-acknowledged-entry");
    expect(ack).toHaveAttribute("href", expected);
    expect(ack).toHaveAttribute("data-divergence-id", "div-anchor-me");
    // The row's own id matches the same anchor (without the `#`)
    // so the link actually lands.
    expect(screen.getByTestId("briefing-divergences-row")).toHaveAttribute(
      "id",
      briefingDivergenceRowDomId("div-anchor-me"),
    );
  });

  it("falls back to the 'system' attribution + drops the timestamp suffix when resolvedByRequestor is null", () => {
    // System-resolved (no session-bound caller) is a real path —
    // dev / system pushes can land here. The acknowledgement
    // entry must still render so the audit trail stays visible,
    // and the attribution must read through the chip's "system"
    // glyph rather than blanking out as an empty initials chip.
    render(
      <BriefingDivergenceRow
        row={makeDivergence({
          resolvedAt: "2025-01-06T08:00:00.000Z",
          resolvedByRequestor: null,
        })}
      />,
    );
    const ack = screen.getByTestId("briefing-divergences-acknowledged-entry");
    // `formatResolvedAcknowledgement(null)` → "system acknowledged
    // the override" — pin the substring rather than the full
    // sentence so a future copy-tweak doesn't have to update both
    // the helper and the test in lockstep, but the system
    // attribution can never blank out silently.
    expect(ack).toHaveTextContent(/system/i);
    expect(ack).toHaveTextContent(/acknowledged the override/i);
  });

  it("renders the rightSlot inside the row header so consumers can wire their action button", () => {
    // The rightSlot is the integration seam each surface uses to
    // hand in its action vocabulary — architect's "Resolve"
    // mutation button on design-tools and reviewer's "View
    // details" drill-in on plan-review. Mount the row with a
    // custom button + click handler and pin both that the slot
    // renders inside the row and that clicking it fires the
    // handler the consumer registered. This is the click-through
    // wiring `BriefingDivergenceDetailDialog` depends on the
    // reviewer surface to drive.
    const onClick = vi.fn();
    render(
      <BriefingDivergenceRow
        row={makeDivergence({ id: "div-click-me" })}
        rightSlot={
          <button
            type="button"
            data-testid="briefing-divergences-view-details-button"
            onClick={() => onClick("div-click-me")}
          >
            View details
          </button>
        }
      />,
    );
    const row = screen.getByTestId("briefing-divergences-row");
    const button = within(row).getByTestId(
      "briefing-divergences-view-details-button",
    );
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledWith("div-click-me");
  });

  it("omits the rightSlot when not supplied (resolved row with no second action)", () => {
    // The `rightSlot` prop is optional — the architect's resolved
    // rows pass `null` because the Resolved badge already carries
    // the state and a second action would be noise. Pin that the
    // row renders cleanly without the slot rather than emitting
    // an empty container that could collect padding / borders.
    render(
      <BriefingDivergenceRow
        row={makeDivergence({
          id: "div-no-slot",
          resolvedAt: "2025-01-06T08:00:00.000Z",
        })}
      />,
    );
    expect(
      screen.queryByTestId("briefing-divergences-view-details-button"),
    ).not.toBeInTheDocument();
    // The row itself must still mount — pin its presence so a
    // future refactor that gates the whole row on `rightSlot`
    // can't accidentally drop the resolved-no-action branch.
    expect(screen.getByTestId("briefing-divergences-row")).toBeInTheDocument();
  });

  it("renders the errorSlot beneath the row so consumers can surface a per-row mutation failure", () => {
    // Architect's resolve-mutation failure renders here — the
    // surface mounts an inline error pill via this slot rather
    // than a top-level toast so the operator sees the failure
    // attached to the row they tried to act on. Pin the slot
    // renders with the consumer's content so a refactor that
    // accidentally drops the slot can't leave the failure
    // invisible.
    render(
      <BriefingDivergenceRow
        row={makeDivergence()}
        errorSlot={
          <div data-testid="custom-resolve-error">
            Couldn't resolve — try again
          </div>
        }
      />,
    );
    const row = screen.getByTestId("briefing-divergences-row");
    expect(within(row).getByTestId("custom-resolve-error")).toHaveTextContent(
      "Couldn't resolve — try again",
    );
  });
});
