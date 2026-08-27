/**
 * P-85 WDLL item 7 — single-artifact vision read (no DB).
 */

import {
  enrichExtractedTextWithVision,
  VISION_READ_SOURCE_HEADER,
} from "./attachedDocumentVision";
import { getVisionAnthropicClient } from "./findingLlmClient";

export type VisionReadStatus = "complete" | "failed" | "skipped";

export interface ArtifactVisionReadResult {
  artifactId: string;
  status: VisionReadStatus;
  visionApplied: boolean;
  extractedText?: string;
  failureReason?: string;
}

export async function readRecordsRequestArtifactVision(input: {
  artifactId: string;
  title: string;
  fileBytes: Buffer;
  mimeType?: string;
  visionClient?: Awaited<ReturnType<typeof getVisionAnthropicClient>>;
}): Promise<ArtifactVisionReadResult> {
  const mimeType = input.mimeType ?? "image/png";
  const client =
    input.visionClient ?? (await getVisionAnthropicClient());

  if (!client) {
    return {
      artifactId: input.artifactId,
      status: "skipped",
      visionApplied: false,
      failureReason: "vision_client_unavailable",
    };
  }

  if (input.fileBytes.byteLength === 0) {
    return {
      artifactId: input.artifactId,
      status: "failed",
      visionApplied: false,
      failureReason: "blank_capture",
    };
  }

  const enriched = await enrichExtractedTextWithVision({
    docId: input.artifactId,
    title: input.title,
    mimeType,
    fileBytes: input.fileBytes,
    baseExtractedText: "",
    visionClient: client,
  });

  if (!enriched.visionApplied || !enriched.extractedText.includes(VISION_READ_SOURCE_HEADER)) {
    return {
      artifactId: input.artifactId,
      status: "failed",
      visionApplied: false,
      failureReason: "vision_read_produced_no_text",
    };
  }

  return {
    artifactId: input.artifactId,
    status: "complete",
    visionApplied: true,
    extractedText: enriched.extractedText,
  };
}
