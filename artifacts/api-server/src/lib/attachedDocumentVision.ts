/**
 * Opus 4.8 vision read for chat-attachment intake (reuses finding-engine P2 path).
 *
 * Image uploads and low-text PDFs are interpreted at upload time so the in-app
 * agent's `read_attached_document` tool returns grounded sheet content. Extracted
 * vision text carries explicit source + verification headers — never authoritative
 * without operator confirmation.
 */

import {
  FINDING_VISION_ANTHROPIC_MODEL,
  FINDING_VISION_MAX_SHEETS_PER_PASS,
  runDisciplineVisionRead,
  type AttachedSheetImage,
} from "@workspace/finding-engine";
import type { getVisionAnthropicClient } from "./findingLlmClient";
import { renderPdfPagesToPng } from "./pdfPageRenderer";

type VisionAnthropicClient = NonNullable<
  Awaited<ReturnType<typeof getVisionAnthropicClient>>
>;

export const VISION_READ_SOURCE_HEADER = `[source: vision-read ${FINDING_VISION_ANTHROPIC_MODEL}]`;
export const VISION_READ_VERIFICATION_HEADER =
  "[verification: unverified-model-read — preliminary interpretation; confirm against the original document before treating as authoritative]";

function bareMime(mime: string): string {
  return (mime.toLowerCase().split(";")[0] ?? "").trim();
}

function isImageMime(mime: string): boolean {
  return bareMime(mime).startsWith("image/");
}

async function imagesFromUpload(
  docId: string,
  title: string,
  mimeType: string,
  fileBytes: Buffer,
): Promise<AttachedSheetImage[]> {
  if (isImageMime(mimeType)) {
    return [
      {
        pieceId: docId,
        pngBase64: fileBytes.toString("base64"),
        label: title,
      },
    ];
  }
  if (bareMime(mimeType) === "application/pdf") {
    const pages = await renderPdfPagesToPng(fileBytes, {
      maxPages: FINDING_VISION_MAX_SHEETS_PER_PASS,
    });
    return pages.map((page) => ({
      pieceId: `${docId}:page${page.pageIndex + 1}`,
      pngBase64: page.png.toString("base64"),
      label: `${title} — page ${page.pageIndex + 1}`,
    }));
  }
  return [];
}

export interface VisionEnrichmentResult {
  extractedText: string;
  visionApplied: boolean;
}

/**
 * Run claude-opus-4-8 vision read when the upload is an image or a low-text PDF.
 * Returns merged extractedText with quality-gate headers when vision succeeds.
 */
export async function enrichExtractedTextWithVision(args: {
  docId: string;
  title: string;
  mimeType: string;
  fileBytes: Buffer;
  baseExtractedText: string;
  lowTextExtraction?: boolean;
  visionClient: VisionAnthropicClient | null;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}): Promise<VisionEnrichmentResult> {
  const needsVision =
    isImageMime(args.mimeType) || args.lowTextExtraction === true;
  if (!needsVision || !args.visionClient) {
    return { extractedText: args.baseExtractedText, visionApplied: false };
  }

  const images = await imagesFromUpload(
    args.docId,
    args.title,
    args.mimeType,
    args.fileBytes,
  );
  if (images.length === 0) {
    return { extractedText: args.baseExtractedText, visionApplied: false };
  }

  const pieces = images.map((img) => ({
    pieceId: img.pieceId,
    kind: "attached-document" as const,
    label: img.label ?? args.title,
    text: null as string | null,
    discipline: "building" as const,
    confidence: 1,
  }));

  const result = await runDisciplineVisionRead(args.visionClient, {
    discipline: "building",
    pieces,
    images,
    codeSections: [],
    log: args.log,
  });

  if (!result?.observations?.trim()) {
    return { extractedText: args.baseExtractedText, visionApplied: false };
  }

  const visionBlock = [
    VISION_READ_SOURCE_HEADER,
    VISION_READ_VERIFICATION_HEADER,
    "",
    result.observations.trim(),
  ].join("\n");

  const merged = args.baseExtractedText.trim()
    ? `${args.baseExtractedText.trim()}\n\n${visionBlock}`
    : visionBlock;

  return { extractedText: merged, visionApplied: true };
}
