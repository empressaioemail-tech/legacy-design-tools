import { describe, expect, it, vi } from "vitest";
import {
  VISION_READ_SOURCE_HEADER,
  VISION_READ_VERIFICATION_HEADER,
  enrichExtractedTextWithVision,
} from "../attachedDocumentVision";

vi.mock("@workspace/finding-engine", async () => {
  const actual = await vi.importActual<typeof import("@workspace/finding-engine")>(
    "@workspace/finding-engine",
  );
  return {
    ...actual,
    runDisciplineVisionRead: vi.fn(async () => ({
      observations: "Sheet A1 shows a 3-story triplex, 36 ft wide.",
      model: "claude-opus-4-8",
      sheetCount: 1,
    })),
    renderPdfPagesToPng: vi.fn(),
  };
});

vi.mock("../pdfPageRenderer", () => ({
  renderPdfPagesToPng: vi.fn(async () => []),
}));

describe("enrichExtractedTextWithVision", () => {
  it("appends vision read with source and verification headers for images", async () => {
    const client = {} as NonNullable<
      Awaited<
        ReturnType<
          typeof import("../findingLlmClient")["getVisionAnthropicClient"]
        >
      >
    >;
    const result = await enrichExtractedTextWithVision({
      docId: "doc-1",
      title: "A1.png",
      mimeType: "image/png",
      fileBytes: Buffer.from("fake-png"),
      baseExtractedText: "",
      visionClient: client,
    });
    expect(result.visionApplied).toBe(true);
    expect(result.extractedText).toContain(VISION_READ_SOURCE_HEADER);
    expect(result.extractedText).toContain(VISION_READ_VERIFICATION_HEADER);
    expect(result.extractedText).toContain("3-story triplex");
  });

  it("skips vision when client is unavailable", async () => {
    const result = await enrichExtractedTextWithVision({
      docId: "doc-1",
      title: "A1.png",
      mimeType: "image/png",
      fileBytes: Buffer.from("fake-png"),
      baseExtractedText: "note only",
      visionClient: null,
    });
    expect(result.visionApplied).toBe(false);
    expect(result.extractedText).toBe("note only");
  });
});
