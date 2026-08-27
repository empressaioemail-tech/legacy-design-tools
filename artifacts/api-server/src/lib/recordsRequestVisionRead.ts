/**
 * P-85 WDLL item 7 — batch vision read for all artifacts on a Records Request job.
 */

import { eq } from "drizzle-orm";
import {
  db,
  recordsRequestArtifacts,
} from "@workspace/db";
import { ObjectStorageService } from "./objectStorage";
import {
  readRecordsRequestArtifactVision,
  type ArtifactVisionReadResult,
  type VisionReadStatus,
} from "./recordsRequestArtifactVision";
import {
  processRecordsRequestJobClassification,
  type ArtifactClassifyResult,
} from "./recordsRequestClassifyWrite";

export type { ArtifactVisionReadResult, VisionReadStatus } from "./recordsRequestArtifactVision";
export type { ArtifactClassifyResult } from "./recordsRequestClassifyWrite";

export interface RecordsRequestVisionAndClassifyResult {
  vision: ArtifactVisionReadResult[];
  classification: ArtifactClassifyResult[];
}

/** Persisted on `records_request_artifacts.metadata.visionRead`. */
export type ArtifactVisionReadMetadata = {
  status: VisionReadStatus;
  visionApplied: boolean;
  failureReason?: string;
  extractedText?: string;
  readAt: string;
};

export type ProcessRecordsRequestJobVisionReadsDeps = {
  readArtifact?: typeof readRecordsRequestArtifactVision;
  getObjectBytes?: (storagePath: string) => Promise<Buffer>;
  /** Test seam — skip item 8 classify when set false. */
  runClassification?: boolean;
  classifyJob?: typeof processRecordsRequestJobClassification;
};

let cachedObjectStorage: ObjectStorageService | null = null;
function objectStorage(): ObjectStorageService {
  if (!cachedObjectStorage) cachedObjectStorage = new ObjectStorageService();
  return cachedObjectStorage;
}

function artifactMetadataRecord(metadata: unknown): Record<string, unknown> | null {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : null;
}

export function resolveArtifactMimeType(row: {
  storagePath: string | null;
  metadata: unknown;
}): string {
  const meta = artifactMetadataRecord(row.metadata);
  const fromMeta = meta?.captureMimeType ?? meta?.contentMimeType;
  if (typeof fromMeta === "string" && fromMeta.trim()) {
    return fromMeta.trim();
  }
  if (row.storagePath?.toLowerCase().endsWith(".pdf")) {
    return "application/pdf";
  }
  return "image/png";
}

async function loadArtifactBytes(
  row: {
    storagePath: string | null;
    metadata: unknown;
  },
  deps?: ProcessRecordsRequestJobVisionReadsDeps,
): Promise<Buffer | null> {
  if (row.storagePath) {
    try {
      if (deps?.getObjectBytes) {
        return await deps.getObjectBytes(row.storagePath);
      }
      return await objectStorage().getObjectEntityBytes(row.storagePath);
    } catch {
      return null;
    }
  }
  const meta = artifactMetadataRecord(row.metadata);
  const b64 = meta?.capturePngBase64;
  if (typeof b64 === "string" && b64.trim()) {
    return Buffer.from(b64.trim(), "base64");
  }
  return null;
}

function visionReadMetadataFromResult(
  read: ArtifactVisionReadResult,
): ArtifactVisionReadMetadata {
  return {
    status: read.status,
    visionApplied: read.visionApplied,
    ...(read.failureReason ? { failureReason: read.failureReason } : {}),
    ...(read.extractedText ? { extractedText: read.extractedText } : {}),
    readAt: new Date().toISOString(),
  };
}

export async function processRecordsRequestJobVisionReads(
  jobId: string,
  deps?: ProcessRecordsRequestJobVisionReadsDeps,
): Promise<RecordsRequestVisionAndClassifyResult> {
  const rows = await db
    .select()
    .from(recordsRequestArtifacts)
    .where(eq(recordsRequestArtifacts.jobId, jobId));

  const readArtifact = deps?.readArtifact ?? readRecordsRequestArtifactVision;
  const results: ArtifactVisionReadResult[] = [];

  for (const row of rows) {
    const bytes = await loadArtifactBytes(row, deps);
    if (!bytes) {
      const failed: ArtifactVisionReadResult = {
        artifactId: row.id,
        status: "failed",
        visionApplied: false,
        failureReason: "artifact_bytes_missing",
      };
      await mergeArtifactVisionMetadata(row.id, visionReadMetadataFromResult(failed));
      results.push(failed);
      continue;
    }

    const read = await readArtifact({
      artifactId: row.id,
      title: row.recordingRef ?? row.documentType ?? row.id,
      fileBytes: bytes,
      mimeType: resolveArtifactMimeType(row),
    });

    await mergeArtifactVisionMetadata(row.id, visionReadMetadataFromResult(read));
    results.push(read);
  }

  const runClassification = deps?.runClassification ?? true;
  const classifyJob =
    deps?.classifyJob ?? processRecordsRequestJobClassification;
  const classification = runClassification ? await classifyJob(jobId) : [];

  return { vision: results, classification };
}

async function mergeArtifactVisionMetadata(
  artifactId: string,
  visionRead: ArtifactVisionReadMetadata,
): Promise<void> {
  const rows = await db
    .select({ metadata: recordsRequestArtifacts.metadata })
    .from(recordsRequestArtifacts)
    .where(eq(recordsRequestArtifacts.id, artifactId))
    .limit(1);
  const prior = rows[0]?.metadata;
  const base =
    prior && typeof prior === "object" && !Array.isArray(prior)
      ? (prior as Record<string, unknown>)
      : {};
  await db
    .update(recordsRequestArtifacts)
    .set({
      metadata: {
        ...base,
        visionRead,
      },
    })
    .where(eq(recordsRequestArtifacts.id, artifactId));
}
