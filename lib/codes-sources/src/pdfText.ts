/**
 * Shared PDF text extraction for ingest pipelines (codes, encumbrances).
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — pdf-parse-fork has no published types
import pdfParse from "pdf-parse-fork";

export async function extractPdfPlainText(
  bytes: Buffer,
): Promise<{ text: string; numpages: number }> {
  const parsed = await pdfParse(bytes);
  return {
    text: (parsed.text ?? "").replace(/\r\n/g, "\n"),
    numpages:
      typeof parsed.numpages === "number" && parsed.numpages > 0
        ? parsed.numpages
        : 1,
  };
}
