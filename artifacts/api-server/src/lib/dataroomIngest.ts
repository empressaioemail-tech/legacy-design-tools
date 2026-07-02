/**
 * Dataroom document-ingest — cortex-api BFF proxy to the engine
 * `POST /v1/document-ingest` unstructured-to-atom pipeline.
 *
 * Flow (point-to model, per
 * `_inbox/2026-07-02_hauska-engine_phase2-document-ingest-close.md`):
 *   1. An engagement file already lives in `attached_documents` (Track D
 *      upload: presign -> PUT -> complete-upload), its bytes in GCS at
 *      `original_blob_ref`.
 *   2. The Dataroom tile asks the BFF to ingest that file. The BFF downloads
 *      the blob bytes, base64-encodes them, and POSTs them INLINE to
 *      engine-api `/v1/document-ingest` over the gate-front seam (service
 *      bearer + x-hauska-* context headers via `engineSpineClient`).
 *   3. The engine pins the blob, classifies it, mints CLAIM atoms each
 *      carrying `sourceDocumentCid`, an asserted widthed confidence, an
 *      access policy, and a verification status.
 *   4. The BFF persists the returned `atoms[]` into `dataroom_document_atoms`
 *      (upsert-on-conflict, idempotent on the engine's deterministic
 *      `atomDid`) so the tile re-renders the cited chips without re-ingesting.
 *
 * FIREWALL: this module NEVER sets `accessPolicy` on the ingest call for a
 * user upload. The engine defaults + clamps to `tenant-private`, and we persist
 * exactly what it returns — so no atom can carry a public policy the engine did
 * not itself grant. There is no auto-publish path here.
 */

import { and, eq } from "drizzle-orm";
import { db, attachedDocuments, dataroomDocumentAtoms } from "@workspace/db";
import { ObjectStorageService } from "./objectStorage";
import {
  postEngineSpine,
  buildSpineGateFrontContextFromTenant,
  type SpineGateFrontContext,
} from "./engineSpineClient";
import { logger } from "./logger";

const objectStorage = new ObjectStorageService();

/** Asserted widthed confidence — never a bare number. */
export interface AssertedConfidence {
  kind: "asserted" | "calibrated";
  value: number;
  intervalWidth: number;
  n: number;
}

/** One extracted atom as returned by engine `/v1/document-ingest`. */
export interface IngestedAtomWire {
  atomDid: string;
  entityType: string;
  entityId?: string;
  accessPolicy: string;
  storageRelation: "point-to" | "embed-with";
  confidence: AssertedConfidence;
  verificationStatus: string;
  sourceDocumentCid: string;
  created?: boolean;
}

/** The engine envelope's `payload` for a document-ingest response. */
interface DocumentIngestPayload {
  status: "ok" | "empty" | "degraded";
  sourceDocument: {
    cid: string;
    contentHash?: string;
    contentType?: string;
    accessPolicy: string;
    pinned: boolean;
  };
  classification?: { documentType?: string; adapter?: string; score?: number };
  atoms: IngestedAtomWire[];
  reason?: string;
}

/** The full EngineEnvelope (only the fields the BFF reads). */
interface EngineEnvelope {
  payload: DocumentIngestPayload;
}

/** The Dataroom-tile-facing per-atom chip shape. */
export interface DataroomAtomChip {
  atomDid: string;
  entityType: string;
  accessPolicy: string;
  storageRelation: string;
  confidence: AssertedConfidence;
  verificationStatus: string;
  sourceDocumentCid: string;
}

export interface DataroomIngestResult {
  documentId: string;
  status: "ok" | "empty" | "degraded";
  sourceDocumentCid: string | null;
  classification: { documentType?: string; adapter?: string; score?: number } | null;
  atoms: DataroomAtomChip[];
  reason?: string;
}

/**
 * Best-effort content-type inference from a filename, used only when the
 * stored row carries no explicit type. The engine's classifier does the real
 * work; this is a hint.
 */
function inferContentType(title: string): string {
  const t = title.toLowerCase();
  if (t.endsWith(".pdf")) return "application/pdf";
  if (t.endsWith(".png")) return "image/png";
  if (t.endsWith(".jpg") || t.endsWith(".jpeg")) return "image/jpeg";
  if (t.endsWith(".tif") || t.endsWith(".tiff")) return "image/tiff";
  if (t.endsWith(".txt")) return "text/plain";
  if (t.endsWith(".csv")) return "text/csv";
  return "application/octet-stream";
}

async function downloadBlobBytes(objectPath: string): Promise<Buffer> {
  const objectFile = await objectStorage.getObjectEntityFile(objectPath);
  const response = await objectStorage.downloadObject(objectFile);
  if (!response.body) {
    throw new Error("uploaded_object_missing");
  }
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

function toChip(row: {
  atomDid: string;
  entityType: string;
  accessPolicy: string;
  storageRelation: string;
  confidence: unknown;
  verificationStatus: string;
  sourceDocumentCid: string;
}): DataroomAtomChip {
  return {
    atomDid: row.atomDid,
    entityType: row.entityType,
    accessPolicy: row.accessPolicy,
    storageRelation: row.storageRelation,
    confidence: row.confidence as AssertedConfidence,
    verificationStatus: row.verificationStatus,
    sourceDocumentCid: row.sourceDocumentCid,
  };
}

/**
 * Persisted atom chips for a dataroom file (no ingest). Used to render the
 * tile on open without re-calling the engine.
 */
export async function loadDataroomAtomsForDocument(
  documentId: string,
): Promise<DataroomAtomChip[]> {
  const rows = await db
    .select()
    .from(dataroomDocumentAtoms)
    .where(eq(dataroomDocumentAtoms.documentId, documentId));
  return rows.map(toChip);
}

/** Persisted atom chips for every file in an engagement. */
export async function loadDataroomAtomsForEngagement(
  engagementId: string,
): Promise<Record<string, DataroomAtomChip[]>> {
  const rows = await db
    .select()
    .from(dataroomDocumentAtoms)
    .where(eq(dataroomDocumentAtoms.engagementId, engagementId));
  const byDoc: Record<string, DataroomAtomChip[]> = {};
  for (const row of rows) {
    (byDoc[row.documentId] ??= []).push(toChip(row));
  }
  return byDoc;
}

/**
 * Ingest one dataroom file through the engine and persist the extracted atoms.
 *
 * @param engagementId  the engagement scope
 * @param documentId    the `attached_documents` row to ingest
 * @param jurisdictionTenant  resolved tenant for the gate-front context
 */
export async function ingestDataroomDocument(args: {
  engagementId: string;
  documentId: string;
  jurisdictionTenant: string | null;
}): Promise<DataroomIngestResult> {
  const { engagementId, documentId, jurisdictionTenant } = args;

  const [doc] = await db
    .select()
    .from(attachedDocuments)
    .where(
      and(
        eq(attachedDocuments.id, documentId),
        eq(attachedDocuments.engagementId, engagementId),
      ),
    );
  if (!doc) {
    throw new Error("document_not_found");
  }
  if (!doc.originalBlobRef.startsWith("/objects/")) {
    throw new Error("document_has_no_ingestible_blob");
  }

  const bytes = await downloadBlobBytes(doc.originalBlobRef);
  const contentType = inferContentType(doc.title);

  // FIREWALL: no accessPolicy on the request. The engine defaults + clamps to
  // tenant-private for the private upload path. The gate-front context carries
  // an explicit tenant-private access tier so the engine cannot resolve a
  // public tier from our call either.
  const gateFront: SpineGateFrontContext = buildSpineGateFrontContextFromTenant({
    packageId: "plan-review",
    jurisdictionTenant,
    accessTier: "tenant-private",
  });

  const envelope = await postEngineSpine<EngineEnvelope>({
    path: "/v1/document-ingest",
    gateFront,
    body: {
      document: {
        kind: "inline",
        body: bytes.toString("base64"),
        encoding: "base64",
        contentType,
        sourceRef: doc.title,
      },
      contextRefs: { engagementId },
    },
  });

  const payload = envelope?.payload;
  if (!payload || !Array.isArray(payload.atoms)) {
    throw new Error("engine_invalid_ingest_response");
  }

  // Persist exactly what the engine returned (upsert-on-conflict; idempotent on
  // the engine's deterministic atomDid). We do NOT rewrite accessPolicy here.
  for (const atom of payload.atoms) {
    await db
      .insert(dataroomDocumentAtoms)
      .values({
        documentId,
        engagementId,
        atomDid: atom.atomDid,
        entityType: atom.entityType,
        accessPolicy: atom.accessPolicy,
        storageRelation: atom.storageRelation,
        confidence: atom.confidence,
        verificationStatus: atom.verificationStatus,
        sourceDocumentCid: atom.sourceDocumentCid,
      })
      .onConflictDoUpdate({
        target: [
          dataroomDocumentAtoms.documentId,
          dataroomDocumentAtoms.atomDid,
        ],
        set: {
          entityType: atom.entityType,
          accessPolicy: atom.accessPolicy,
          storageRelation: atom.storageRelation,
          confidence: atom.confidence,
          verificationStatus: atom.verificationStatus,
          sourceDocumentCid: atom.sourceDocumentCid,
        },
      });
  }

  if (payload.status === "degraded") {
    logger.warn(
      { engagementId, documentId, reason: payload.reason },
      "dataroom ingest degraded",
    );
  }

  const atoms = await loadDataroomAtomsForDocument(documentId);
  return {
    documentId,
    status: payload.status,
    sourceDocumentCid: payload.sourceDocument?.cid ?? null,
    classification: payload.classification ?? null,
    atoms,
    reason: payload.reason,
  };
}
