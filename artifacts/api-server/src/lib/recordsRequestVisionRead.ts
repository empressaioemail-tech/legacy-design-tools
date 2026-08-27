/**
 * P-85 WDLL item 7 — batch vision read for all artifacts on a Records Request job.
 */

import { eq } from "drizzle-orm";
import { db, recordsRequestArtifacts } from "@workspace/db";
import { ObjectStorageService } from "./objectStorage";
import {
  readRecordsRequestArtifactVision,
  type ArtifactVisionReadResult,
} from "./recordsRequestArtifactVision";

export type { ArtifactVisionReadResult, VisionReadStatus } from "./recordsRequestArtifactVision";

let cachedObjectStorage: ObjectStorageService | null = null;
function objectStorage(): ObjectStorageService {
  if (!cachedObjectStorage) cachedObjectStorage = new ObjectStorageService();
  return cachedObjectStorage;
}

async function loadArtifactBytes(row: {
  storagePath: string | null;
  metadata: unknown;
}): Promise<Buffer | null> {
  if (row.storagePath) {
    try {
      return await objectStorage().getObjectEntityBytes(row.storagePath);
    } catch {
      return null;
    }
  }
  const meta =
    row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : null;
  const b64 = meta?.capturePngBase64;
  if (typeof b64 === "string" && b64.trim()) {
    return Buffer.from(b64.trim(), "base64");
  }
  return null;
}

export async function processRecordsRequestJobVisionReads(
  jobId: string,
): Promise<ArtifactVisionReadResult[]> {
  const rows = await db
    .select()
    .from(recordsRequestArtifacts)
    .where(eq(recordsRequestArtifacts.jobId, jobId));

  const results: ArtifactVisionReadResult[] = [];

  for (const row of rows) {
    const bytes = await loadArtifactBytes(row);
    if (!bytes) {
      const failed: ArtifactVisionReadResult = {
        artifactId: row.id,
        status: "failed",
        visionApplied: false,
        failureReason: "artifact_bytes_missing",
      };
      await mergeArtifactVisionMetadata(row.id, {
        status: "failed",
        visionApplied: false,
        failureReason: "artifact_bytes_missing",
        readAt: new Date().toISOString(),
      });
      results.push(failed);
      continue;
    }

    const read = await readRecordsRequestArtifactVision({
      artifactId: row.id,
      title: row.recordingRef ?? row.documentType ?? row.id,
      fileBytes: bytes,
    });

    await mergeArtifactVisionMetadata(row.id, {
      status: read.status,
      visionApplied: read.visionApplied,
      failureReason: read.failureReason,
      extractedText: read.extractedText,
      readAt: new Date().toISOString(),
    });
    results.push(read);
  }

  return results;
}

async function mergeArtifactVisionMetadata(
  artifactId: string,
  visionRead: Record<string, unknown>,
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
