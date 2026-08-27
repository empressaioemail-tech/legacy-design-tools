import { describe, expect, it, vi } from "vitest";
import { readRecordsRequestArtifactVision } from "../recordsRequestArtifactVision";
import { VISION_READ_SOURCE_HEADER } from "../attachedDocumentVision";

vi.mock("../attachedDocumentVision", () => ({
  enrichExtractedTextWithVision: vi.fn(),
  VISION_READ_SOURCE_HEADER: "[source: vision-read claude-opus-4-8]",
  VISION_READ_VERIFICATION_HEADER: "[verification: unverified]",
}));

vi.mock("../findingLlmClient", () => ({
  getVisionAnthropicClient: vi.fn(async () => ({})),
}));

import { enrichExtractedTextWithVision } from "../attachedDocumentVision";

describe("readRecordsRequestArtifactVision", () => {
  it("records failed read for blank capture (WDLL item 7)", async () => {
    const result = await readRecordsRequestArtifactVision({
      artifactId: "art-1",
      title: "DEED",
      fileBytes: Buffer.alloc(0),
      visionClient: {} as never,
    });
    expect(result.status).toBe("failed");
    expect(result.failureReason).toBe("blank_capture");
    expect(result.visionApplied).toBe(false);
  });

  it("records failed read for blank page PNG fixture (WDLL item 7)", async () => {
    const blankPagePng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    vi.mocked(enrichExtractedTextWithVision).mockResolvedValue({
      visionApplied: false,
      extractedText: "",
    });
    const result = await readRecordsRequestArtifactVision({
      artifactId: "art-blank-page",
      title: "DEED",
      fileBytes: blankPagePng,
      mimeType: "image/png",
      visionClient: {} as never,
    });
    expect(result.status).toBe("failed");
    expect(result.failureReason).toBe("vision_read_produced_no_text");
    expect(result.visionApplied).toBe(false);
  });

  it("records complete read with headers when vision succeeds", async () => {
    vi.mocked(enrichExtractedTextWithVision).mockResolvedValue({
      visionApplied: true,
      extractedText: `${VISION_READ_SOURCE_HEADER}\nGrantor: SMITH`,
    });
    const result = await readRecordsRequestArtifactVision({
      artifactId: "art-2",
      title: "DEED",
      fileBytes: Buffer.from("png-bytes"),
      visionClient: {} as never,
    });
    expect(result.status).toBe("complete");
    expect(result.visionApplied).toBe(true);
    expect(result.extractedText).toContain("Grantor: SMITH");
  });

  it("records failed when vision returns no text", async () => {
    vi.mocked(enrichExtractedTextWithVision).mockResolvedValue({
      visionApplied: false,
      extractedText: "",
    });
    const result = await readRecordsRequestArtifactVision({
      artifactId: "art-3",
      title: "DEED",
      fileBytes: Buffer.from("png-bytes"),
      visionClient: {} as never,
    });
    expect(result.status).toBe("failed");
    expect(result.failureReason).toBe("vision_read_produced_no_text");
  });
});
