/**
 * SheetContentExtractionPanel — Cortex L2a (Lane C.4 / C.4.2).
 *
 * Coverage isolated to the panel's component contract:
 *   - Loading / not-extracted / extracted states render correctly.
 *   - Extracted text segments + structured annotations render.
 *   - "Run extraction" calls the trigger mutation with the sheet id.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const hoisted = vi.hoisted(() => ({
  data: undefined as { sheetContentExtraction: unknown } | undefined,
  isLoading: false,
  triggerMutate: vi.fn(),
}));

vi.mock("@workspace/api-client-react", () => ({
  getGetSheetContentExtractionQueryKey: (id: string) => [
    "getSheetContentExtraction",
    id,
  ],
  getListAttachedDocumentsQueryKey: (id: string) => [
    "listAttachedDocuments",
    id,
  ],
  useGetSheetContentExtraction: () => ({
    data: hoisted.data,
    isLoading: hoisted.isLoading,
  }),
  useTriggerSheetContentExtraction: () => ({
    mutate: hoisted.triggerMutate,
    isPending: false,
  }),
}));

const { SheetContentExtractionPanel } = await import(
  "../SheetContentExtractionPanel"
);

const SHEET = { id: "sheet-1", sheetNumber: "A-101" } as never;

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const ui: ReactNode = (
    <QueryClientProvider client={client}>
      <SheetContentExtractionPanel sheet={SHEET} />
    </QueryClientProvider>
  );
  return render(ui);
}

beforeEach(() => {
  hoisted.data = undefined;
  hoisted.isLoading = false;
  hoisted.triggerMutate.mockReset();
});

describe("SheetContentExtractionPanel", () => {
  it("renders the loading state while the query is pending", () => {
    hoisted.isLoading = true;
    renderPanel();
    expect(
      screen.getByTestId("sheet-content-extraction-loading"),
    ).toBeInTheDocument();
  });

  it("renders the not-extracted empty state", () => {
    hoisted.data = { sheetContentExtraction: null };
    renderPanel();
    expect(
      screen.getByTestId("sheet-content-extraction-empty"),
    ).toBeInTheDocument();
  });

  it("renders text segments and structured annotations", () => {
    hoisted.data = {
      sheetContentExtraction: {
        entityId: "sce-1",
        extractedTextSegments: [
          {
            text: "GENERAL NOTES",
            boundingBox: { x: 0, y: 0, width: 1, height: 1 },
            sourceConfidence: 1,
          },
        ],
        structuredAnnotations: [
          {
            kind: "revision-cloud",
            position: { x: 0, y: 0, width: 0.2, height: 0.2 },
            content: "Revision 3",
            sourceConfidence: 0.9,
          },
        ],
        ocrModel: "claude-sonnet-4-5",
      },
    };
    renderPanel();
    expect(screen.getByTestId("sheet-content-segment-0")).toHaveTextContent(
      "GENERAL NOTES",
    );
    expect(
      screen.getByTestId("sheet-content-annotation-0"),
    ).toHaveTextContent("Revision 3");
  });

  it("triggers the extraction mutation with the sheet id", () => {
    hoisted.data = { sheetContentExtraction: null };
    renderPanel();
    fireEvent.click(screen.getByTestId("sheet-content-extraction-run"));
    expect(hoisted.triggerMutate).toHaveBeenCalledWith({ sheetId: "sheet-1" });
  });
});
