/**
 * SheetGrid — placeholder branches, sheet rendering, and the filter input.
 *
 * `useGetSnapshotSheets` (a generated react-query hook) is mocked so we can
 * vary the data state without standing up a query client + fetch shim.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { SheetSummary } from "@workspace/api-client-react";

const sheetsState = vi.hoisted(() => ({
  data: undefined as SheetSummary[] | undefined,
  isLoading: false,
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetSnapshotSheets: () => ({
    data: sheetsState.data,
    isLoading: sheetsState.isLoading,
  }),
  getGetSnapshotSheetsQueryKey: (id: string) => ["sheets", id],
}));

// SheetThumbnail issues an <img> request that happy-dom would silently fail
// on; replace it with a minimal stand-in that exposes the sheet number for
// queryability and forwards onClick so the SheetViewer-open path is testable.
vi.mock("../SheetThumbnail", () => ({
  SheetThumbnail: ({
    sheet,
    onClick,
  }: {
    sheet: SheetSummary;
    onClick: () => void;
  }) => (
    <button
      type="button"
      data-testid={`thumb-${sheet.id}`}
      onClick={onClick}
    >
      {sheet.sheetNumber} {sheet.sheetName}
    </button>
  ),
}));

// SheetViewer renders a fixed-position dialog with an image — out of scope here.
vi.mock("../SheetViewer", () => ({
  SheetViewer: ({ sheet }: { sheet: SheetSummary | null }) =>
    sheet ? <div data-testid="viewer-open">{sheet.id}</div> : null,
}));

const { SheetGrid } = await import("../SheetGrid");

function mkSheet(
  over: Partial<SheetSummary> & Pick<SheetSummary, "id">,
): SheetSummary {
  return {
    id: over.id,
    snapshotId: over.snapshotId ?? "snap-1",
    engagementId: over.engagementId ?? "eng-1",
    sheetNumber: over.sheetNumber ?? "A0.0",
    sheetName: over.sheetName ?? "Cover",
    viewCount: over.viewCount ?? null,
    revisionNumber: over.revisionNumber ?? null,
    revisionDate: over.revisionDate ?? null,
    thumbnailWidth: over.thumbnailWidth ?? 200,
    thumbnailHeight: over.thumbnailHeight ?? 150,
    fullWidth: over.fullWidth ?? 1024,
    fullHeight: over.fullHeight ?? 768,
    sortOrder: over.sortOrder ?? 0,
    contentBody: over.contentBody ?? null,
    crossRefs: over.crossRefs ?? [],
    createdAt: over.createdAt ?? new Date().toISOString(),
  };
}

describe("SheetGrid", () => {
  it("renders a placeholder when no snapshot is selected", () => {
    sheetsState.data = undefined;
    sheetsState.isLoading = false;
    render(<SheetGrid snapshotId={null} onAskClaude={vi.fn()} />);
    expect(screen.getByText(/Select a snapshot/i)).toBeInTheDocument();
  });

  it("renders the empty-state when the snapshot has zero sheets", () => {
    sheetsState.data = [];
    sheetsState.isLoading = false;
    render(<SheetGrid snapshotId="snap-1" onAskClaude={vi.fn()} />);
    expect(screen.getByText(/No sheets uploaded yet/i)).toBeInTheDocument();
  });

  it("filters sheets by case-insensitive prefix on number / substring on name", () => {
    sheetsState.data = [
      mkSheet({ id: "1", sheetNumber: "A1.0", sheetName: "Plans" }),
      mkSheet({ id: "2", sheetNumber: "A2.0", sheetName: "Elevations" }),
      mkSheet({ id: "3", sheetNumber: "S1.0", sheetName: "Structural Plans" }),
    ];
    sheetsState.isLoading = false;
    render(<SheetGrid snapshotId="snap-1" onAskClaude={vi.fn()} />);

    expect(screen.getByTestId("thumb-1")).toBeInTheDocument();
    expect(screen.getByTestId("thumb-2")).toBeInTheDocument();
    expect(screen.getByTestId("thumb-3")).toBeInTheDocument();

    const search = screen.getByPlaceholderText(/Filter by number or name/i);
    fireEvent.change(search, { target: { value: "a" } });
    // "a" prefix matches A1.0 / A2.0 by number; S1.0 also has "Structural Plans"
    // which contains "a" — name match keeps it.
    expect(screen.getByTestId("thumb-1")).toBeInTheDocument();
    expect(screen.getByTestId("thumb-2")).toBeInTheDocument();
    expect(screen.getByTestId("thumb-3")).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "elev" } });
    // Only A2.0 has "Elevations" in its name; the other two have neither
    // an "elev" prefix nor "elev" substring.
    expect(screen.queryByTestId("thumb-1")).toBeNull();
    expect(screen.getByTestId("thumb-2")).toBeInTheDocument();
    expect(screen.queryByTestId("thumb-3")).toBeNull();
  });

  it("opens the viewer when a thumbnail is clicked", () => {
    sheetsState.data = [mkSheet({ id: "abc", sheetNumber: "A0.0" })];
    sheetsState.isLoading = false;
    render(<SheetGrid snapshotId="snap-1" onAskClaude={vi.fn()} />);

    expect(screen.queryByTestId("viewer-open")).toBeNull();
    fireEvent.click(screen.getByTestId("thumb-abc"));
    expect(screen.getByTestId("viewer-open")).toHaveTextContent("abc");
  });
});
