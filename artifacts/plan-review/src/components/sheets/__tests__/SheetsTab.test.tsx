/**
 * SheetsTab integration test (PLR-8): cross-ref chips render and
 * clicking one switches the selected sheet in the navigator.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SheetSummary } from "@workspace/api-client-react";

const sheets: SheetSummary[] = [
  {
    id: "s1",
    snapshotId: "snap-1",
    engagementId: "eng-1",
    sheetNumber: "A-101",
    sheetName: "Floor Plan",
    viewCount: null,
    revisionNumber: null,
    revisionDate: null,
    thumbnailWidth: 100,
    thumbnailHeight: 100,
    fullWidth: 1000,
    fullHeight: 1000,
    sortOrder: 0,
    contentBody: "GENERAL NOTES — coordinate with SEE A-301.",
    crossRefs: [{ raw: "SEE A-301", sheetNumber: "A-301" }],
    createdAt: new Date(0).toISOString(),
  },
  {
    id: "s2",
    snapshotId: "snap-1",
    engagementId: "eng-1",
    sheetNumber: "A-301",
    sheetName: "Sections",
    viewCount: null,
    revisionNumber: null,
    revisionDate: null,
    thumbnailWidth: 100,
    thumbnailHeight: 100,
    fullWidth: 1000,
    fullHeight: 1000,
    sortOrder: 1,
    contentBody: null,
    crossRefs: [],
    createdAt: new Date(0).toISOString(),
  },
];

vi.mock("@workspace/api-client-react", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/api-client-react")>(
      "@workspace/api-client-react",
    );
  return {
    ...actual,
    useListSubmissionSheets: () => ({
      data: sheets,
      isLoading: false,
      isError: false,
    }),
    useGetAtomSummary: () => ({ data: null, isLoading: false, isError: false }),
  };
});

import { SheetsTab } from "../SheetsTab";

/**
 * SheetsTab now mounts the Cortex L2 panels (Lane C.4 —
 * SheetContentExtractionPanel / AttachedDocumentsPanel), which use
 * react-query, so the render tree needs a QueryClientProvider.
 */
function renderSheetsTab() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <SheetsTab submissionId="snap-1" />
    </QueryClientProvider>,
  );
}

describe("SheetsTab cross-ref integration (PLR-8)", () => {
  it("renders resolved chip and jumps to referenced sheet on click", () => {
    renderSheetsTab();
    const chip = screen.getByTestId("sheet-ref-link-s2");
    expect(chip).toHaveTextContent("SEE A-301");
    fireEvent.click(chip);
    // After clicking, the preview pane should re-render for sheet s2,
    // whose contentBody is null and therefore renders no chips.
    expect(screen.queryByTestId("sheet-ref-link-s2")).toBeNull();
  });
});
