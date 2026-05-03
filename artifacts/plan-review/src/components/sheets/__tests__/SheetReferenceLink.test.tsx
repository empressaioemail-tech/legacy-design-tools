/**
 * SheetReferenceLink + renderSheetTextWithCrossRefs tests (PLR-8).
 *
 * Covers:
 *   - resolved refs render as clickable buttons that fire
 *     onJumpToSheet with the matched sheet summary.
 *   - unresolved refs render as muted plain-text spans with the
 *     "not found in this submission" tooltip.
 *   - case-insensitive sheet-number matching against the navigator
 *     list.
 *   - renderSheetTextWithCrossRefs interleaves plain text and link
 *     chips in source order without dropping surrounding prose.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { SheetSummary } from "@workspace/api-client-react";
import {
  SheetReferenceLink,
  renderSheetTextWithCrossRefs,
} from "../SheetReferenceLink";

function makeSheet(
  overrides: Partial<SheetSummary> & { id: string; sheetNumber: string },
): SheetSummary {
  return {
    snapshotId: "snap-1",
    engagementId: "eng-1",
    sheetName: `Sheet ${overrides.sheetNumber}`,
    viewCount: null,
    revisionNumber: null,
    revisionDate: null,
    thumbnailWidth: 100,
    thumbnailHeight: 100,
    fullWidth: 1000,
    fullHeight: 1000,
    sortOrder: 0,
    contentBody: null,
    crossRefs: [],
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("SheetReferenceLink", () => {
  const sheets = [
    makeSheet({ id: "s1", sheetNumber: "A-301" }),
    makeSheet({ id: "s2", sheetNumber: "A-501" }),
  ];

  it("renders a clickable button for a resolved ref and fires onJumpToSheet", () => {
    const onJump = vi.fn();
    render(
      <SheetReferenceLink
        crossRef={{ raw: "SEE A-301", sheetNumber: "A-301" }}
        sheets={sheets}
        onJumpToSheet={onJump}
      />,
    );
    const btn = screen.getByTestId("sheet-ref-link-s1");
    expect(btn).toHaveTextContent("SEE A-301");
    fireEvent.click(btn);
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump.mock.calls[0]?.[0]?.id).toBe("s1");
  });

  it("matches sheet numbers case-insensitively", () => {
    const onJump = vi.fn();
    render(
      <SheetReferenceLink
        crossRef={{ raw: "see a-301", sheetNumber: "A-301" }}
        sheets={sheets}
        onJumpToSheet={onJump}
      />,
    );
    expect(screen.getByTestId("sheet-ref-link-s1")).toBeInTheDocument();
  });

  it("renders unresolved refs as muted plain text with a tooltip", () => {
    const onJump = vi.fn();
    render(
      <SheetReferenceLink
        crossRef={{ raw: "SEE A-999", sheetNumber: "A-999" }}
        sheets={sheets}
        onJumpToSheet={onJump}
      />,
    );
    const span = screen.getByTestId("sheet-ref-unresolved-A-999");
    expect(span).toHaveTextContent("SEE A-999");
    expect(span).toHaveAttribute("title", "not found in this submission");
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("renderSheetTextWithCrossRefs", () => {
  const sheets = [
    makeSheet({ id: "s1", sheetNumber: "A-301" }),
    makeSheet({ id: "s2", sheetNumber: "A-501" }),
  ];

  it("returns the body untouched when there are no refs", () => {
    expect(
      renderSheetTextWithCrossRefs("plain note", [], sheets, () => {}),
    ).toEqual(["plain note"]);
  });

  it("interleaves plain text and link chips in source order", () => {
    const onJump = vi.fn();
    const nodes = renderSheetTextWithCrossRefs(
      "Coordinate with SEE A-301 and 5/A-501 elsewhere.",
      [
        { raw: "SEE A-301", sheetNumber: "A-301" },
        { raw: "5/A-501", sheetNumber: "A-501", detailNumber: "5" },
      ],
      sheets,
      onJump,
    );
    render(<div data-testid="body">{nodes}</div>);
    const body = screen.getByTestId("body");
    expect(body.textContent).toBe(
      "Coordinate with SEE A-301 and 5/A-501 elsewhere.",
    );
    expect(screen.getByTestId("sheet-ref-link-s1")).toBeInTheDocument();
    expect(screen.getByTestId("sheet-ref-link-s2")).toBeInTheDocument();
  });
});
