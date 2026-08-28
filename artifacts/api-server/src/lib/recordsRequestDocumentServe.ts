/**
 * P-85 Card 3 — expose the already-captured instrument page image as documentUrl.
 */

import { eq } from "drizzle-orm";
import { ObjectStorageService } from "./objectStorage";

export const RECORDS_REQUEST_ARTIFACT_DOCUMENT_PREFIX =
  "/api/property-explorer/v1/records-request/artifacts";

export function recordsRequestArtifactDocumentUrl(artifactId: string): string {
  const id = artifactId.trim();
  if (!id) {
    throw new Error("artifact_id_required");
  }
  return `${RECORDS_REQUEST_ARTIFACT_DOCUMENT_PREFIX}/${id}/document`;
}

function metadataRecord(metadata: unknown): Record<string, unknown> | null {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : null;
}

export function artifactHasPersistedDocument(artifact: {
  storagePath?: string | null;
  metadata?: unknown;
}): boolean {
  if (artifact.storagePath?.trim()) return true;
  const b64 = metadataRecord(artifact.metadata)?.capturePngBase64;
  return typeof b64 === "string" && b64.trim().length > 0;
}

export function documentUrlForArtifact(artifact: {
  id: string;
  storagePath?: string | null;
  metadata?: unknown;
}): string | null {
  if (!artifactHasPersistedDocument(artifact)) return null;
  return recordsRequestArtifactDocumentUrl(artifact.id);
}

function artifactContentType(artifact: {
  storagePath?: string | null;
  metadata?: unknown;
}): string {
  const fromMeta = metadataRecord(artifact.metadata)?.captureMimeType;
  if (typeof fromMeta === "string" && fromMeta.trim()) return fromMeta.trim();
  if (artifact.storagePath?.toLowerCase().endsWith(".pdf")) {
    return "application/pdf";
  }
  return "image/png";
}

export function capturePngBytesFromMetadata(metadata: unknown): Buffer | null {
  const b64 = metadataRecord(metadata)?.capturePngBase64;
  if (typeof b64 !== "string" || !b64.trim()) return null;
  return Buffer.from(b64.trim(), "base64");
}

export type ArtifactClassifyStatusWire = "written" | "refused" | "skipped" | null;

export type ArtifactDocumentWire = {
  artifactId: string;
  recordingRef: string | null;
  documentUrl: string | null;
  acquisitionMethod: string;
  classifyStatus: ArtifactClassifyStatusWire;
  refuseCode: string | null;
};

function classifyFieldsFromMetadata(metadata: unknown): {
  classifyStatus: ArtifactClassifyStatusWire;
  refuseCode: string | null;
} {
  const classify = metadataRecord(metadata)?.classify;
  if (!classify || typeof classify !== "object" || Array.isArray(classify)) {
    return { classifyStatus: null, refuseCode: null };
  }
  const rec = classify as Record<string, unknown>;
  const status = rec.status;
  const classifyStatus: ArtifactClassifyStatusWire =
    status === "written" || status === "refused" || status === "skipped"
      ? status
      : null;
  const refuseCode =
    typeof rec.refuseCode === "string" && rec.refuseCode.trim()
      ? rec.refuseCode.trim()
      : null;
  return { classifyStatus, refuseCode };
}

export function artifactDocumentWire(artifact: {
  id: string;
  recordingRef?: string | null;
  acquisitionMethod: string;
  storagePath?: string | null;
  metadata?: unknown;
}): ArtifactDocumentWire {
  const classify = classifyFieldsFromMetadata(artifact.metadata);
  return {
    artifactId: artifact.id,
    recordingRef: artifact.recordingRef ?? null,
    documentUrl: documentUrlForArtifact(artifact),
    acquisitionMethod: artifact.acquisitionMethod,
    classifyStatus: classify.classifyStatus,
    refuseCode: classify.refuseCode,
  };
}

export function enrichRecordsRequestJobWire(
  wire: Record<string, unknown>,
  artifacts: Array<{
    id: string;
    recordingRef?: string | null;
    acquisitionMethod: string;
    storagePath?: string | null;
    metadata?: unknown;
  }>,
): Record<string, unknown> {
  const docs = artifacts.map(artifactDocumentWire);
  const urlByRef = new Map<string, string>();
  for (const doc of docs) {
    if (doc.recordingRef && doc.documentUrl && !urlByRef.has(doc.recordingRef)) {
      urlByRef.set(doc.recordingRef, doc.documentUrl);
    }
  }

  const scope =
    wire.scopeSearched &&
    typeof wire.scopeSearched === "object" &&
    !Array.isArray(wire.scopeSearched)
      ? (wire.scopeSearched as Record<string, unknown>)
      : null;
  const indexHits = scope && Array.isArray(scope.indexHits) ? scope.indexHits : null;
  const scopeSearched = scope
    ? {
        ...scope,
        ...(indexHits
          ? {
              indexHits: indexHits.map((raw) => {
                if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
                const hit = raw as Record<string, unknown>;
                const ref =
                  typeof hit.recordingRef === "string" ? hit.recordingRef : null;
                return {
                  ...hit,
                  documentUrl: ref ? urlByRef.get(ref) ?? null : null,
                };
              }),
            }
          : {}),
      }
    : wire.scopeSearched;

  return {
    ...wire,
    artifacts: docs,
    scopeSearched,
  };
}

export type ArtifactDocumentLoadResult =
  | { ok: true; bytes: Buffer; contentType: string }
  | { ok: false; status: 403 | 404; error: string };

let cachedObjectStorage: ObjectStorageService | null = null;
function defaultGetObjectBytes(storagePath: string): Promise<Buffer> {
  if (!cachedObjectStorage) cachedObjectStorage = new ObjectStorageService();
  return cachedObjectStorage.getObjectEntityBytes(storagePath);
}

export async function loadRecordsRequestArtifactDocumentForUser(input: {
  artifactId: string;
  userId: string;
  getObjectBytes?: (storagePath: string) => Promise<Buffer>;
}): Promise<ArtifactDocumentLoadResult> {
  const artifactId = input.artifactId.trim();
  if (!artifactId) {
    return { ok: false, status: 404, error: "artifact_not_found" };
  }

  const { db, recordsRequestArtifacts, recordsRequestJobs } = await import(
    "@workspace/db"
  );
  const artifactRows = await db
    .select()
    .from(recordsRequestArtifacts)
    .where(eq(recordsRequestArtifacts.id, artifactId))
    .limit(1);
  const artifact = artifactRows[0];
  if (!artifact) {
    return { ok: false, status: 404, error: "artifact_not_found" };
  }

  const jobRows = await db
    .select({ userId: recordsRequestJobs.userId })
    .from(recordsRequestJobs)
    .where(eq(recordsRequestJobs.id, artifact.jobId))
    .limit(1);
  const job = jobRows[0];
  if (!job || job.userId !== input.userId) {
    return { ok: false, status: 403, error: "artifact_forbidden" };
  }

  if (artifact.storagePath?.trim()) {
    try {
      const getter = input.getObjectBytes ?? defaultGetObjectBytes;
      const bytes = await getter(artifact.storagePath);
      return {
        ok: true,
        bytes,
        contentType: artifactContentType(artifact),
      };
    } catch {
      return { ok: false, status: 404, error: "document_not_stored" };
    }
  }

  const bytes = capturePngBytesFromMetadata(artifact.metadata);
  if (!bytes) {
    return { ok: false, status: 404, error: "document_not_captured" };
  }
  return {
    ok: true,
    bytes,
    contentType: artifactContentType(artifact),
  };
}
