import { describe, expect, it, vi } from "vitest";
import {
  buildAttachedDocumentExtractedText,
  LOW_TEXT_EXTRACTION_THRESHOLD,
} from "../sheetContent.logic";

describe("buildAttachedDocumentExtractedText", () => {
  it("appends decoded body for text/* uploads", async () => {
    const result = await buildAttachedDocumentExtractedText({
      mimeType: "text/plain",
      note: "operator note",
      fileBytes: Buffer.from("calc body text"),
      maxChars: 200_000,
      extractPdfPlainText: vi.fn(),
    });
    expect(result.extractedText).toContain("operator note");
    expect(result.extractedText).toContain("calc body text");
    expect(result.lowTextExtraction).toBeUndefined();
  });

  it("extracts PDF plain text and flags low_text_extraction", async () => {
    const result = await buildAttachedDocumentExtractedText({
      mimeType: "application/pdf",
      note: "",
      fileBytes: Buffer.from("%PDF-fake"),
      maxChars: 200_000,
      extractPdfPlainText: async () => ({ text: "short", numpages: 1 }),
    });
    expect(result.extractedText).toBe("short");
    expect(result.lowTextExtraction).toBe(true);
    expect("short".length).toBeLessThan(LOW_TEXT_EXTRACTION_THRESHOLD);
  });

  it("merges operator note with PDF extracted text", async () => {
    const result = await buildAttachedDocumentExtractedText({
      mimeType: "application/pdf",
      note: "CHVAC calc for 404 Remodel_B",
      fileBytes: Buffer.from("%PDF-fake"),
      maxChars: 200_000,
      extractPdfPlainText: async () => ({
        text:
          "Manual J load calculation for 5225 Collins Ave unit 404.\n" +
          "Total cooling load: 24,500 BTUH. Sensible heat ratio 0.75.\n" +
          "Supply airflow 1,020 CFM. Return airflow 1,020 CFM balanced.",
        numpages: 3,
      }),
    });
    expect(result.extractedText).toContain("CHVAC calc");
    expect(result.extractedText).toContain("Manual J");
    expect(result.lowTextExtraction).toBeUndefined();
  });

  it("rejects PDFs over 25 MB", async () => {
    await expect(
      buildAttachedDocumentExtractedText({
        mimeType: "application/pdf",
        note: "",
        fileBytes: Buffer.alloc(26 * 1024 * 1024),
        maxChars: 200_000,
        extractPdfPlainText: vi.fn(),
      }),
    ).rejects.toThrow("pdf_too_large");
  });
});
