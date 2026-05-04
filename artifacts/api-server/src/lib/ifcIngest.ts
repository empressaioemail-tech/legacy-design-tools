/**
 * IFC ingest pipeline for `POST /api/snapshots/:id/ifc` (Track B sprint).
 *
 * Owns: multipart parsing, blob persistence, web-ifc parse dispatch,
 * transactional DB writes (snapshot_ifc_files + materializable_elements).
 *
 * Mirror of `sheets.ts`'s sheet-upload pattern — Busboy + best-effort
 * abort + safeRespond — adapted for one file (the `.ifc`) plus a single
 * `metadata` JSON field.
 */

import type { Request, Response } from "express";
import Busboy from "busboy";
import { eq } from "drizzle-orm";
import {
  db,
  snapshots,
  snapshotIfcFiles,
  materializableElements,
} from "@workspace/db";
import { logger } from "./logger";
import { ObjectStorageService } from "./objectStorage";
import { parseIfc, type ParseIfcResult } from "./ifcParser";
import { getHistoryService } from "../atoms/registry";
import { emitEngagementIfcIngestedEvent } from "./engagementEvents";

/**
 * Upper bound on a single IFC upload. Raised above the sheet caps because
 * a federated Revit IFC for a multi-discipline project can run 50-100 MB
 * even after compression. Above this the parser's transient heap during
 * `LoadAllGeometry` starts pushing the api-server process toward the 1-2
 * GB Replit ceiling — the worker_threads upgrade documented in
 * `lib/ifcParser/index.ts` is the cure if real-world projects exceed it.
 */
const MAX_IFC_BYTES = 100 * 1024 * 1024;

/** Hard cap on the metadata JSON part. Defends against accidental misuse. */
const MAX_METADATA_BYTES = 64 * 1024;

interface IfcMetadata {
  ifcVersion?: string;
  fileSizeBytes: number;
  exportDurationMs?: number;
}

function parseMetadata(raw: string): IfcMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("metadata field is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("metadata must be a JSON object");
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o["fileSizeBytes"] !== "number" || o["fileSizeBytes"] < 0) {
    throw new Error("metadata.fileSizeBytes is required and must be a non-negative number");
  }
  return {
    ifcVersion:
      typeof o["ifcVersion"] === "string" ? (o["ifcVersion"] as string) : undefined,
    fileSizeBytes: o["fileSizeBytes"] as number,
    exportDurationMs:
      typeof o["exportDurationMs"] === "number"
        ? (o["exportDurationMs"] as number)
        : undefined,
  };
}

interface ParsedUpload {
  metadata: IfcMetadata;
  bytes: Buffer;
}

/**
 * Drive the Busboy parse to completion, returning either `ParsedUpload`
 * on success or a (status, errorCode) pair on a recoverable failure.
 * On unrecoverable parse errors the response has already been sent.
 */
function consumeUpload(
  req: Request,
  res: Response,
): Promise<
  | { ok: true; upload: ParsedUpload }
  | { ok: false; status: number; error: string }
> {
  return new Promise((resolve) => {
    let busboy: Busboy.Busboy;
    try {
      busboy = Busboy({
        headers: req.headers,
        limits: { fileSize: MAX_IFC_BYTES, files: 1, fields: 5 },
      });
    } catch (err) {
      logger.warn({ err }, "ifc ingest: busboy init failed");
      resolve({ ok: false, status: 400, error: "invalid_multipart" });
      return;
    }

    let metadataRaw = "";
    let metadataOversize = false;
    const ifcChunks: Buffer[] = [];
    let ifcBytes = 0;
    let ifcTruncated = false;
    let ifcSeen = false;
    let aborted = false;

    function abort(status: number, error: string) {
      if (aborted) return;
      aborted = true;
      try {
        req.unpipe(busboy);
      } catch {
        /* ignore */
      }
      resolve({ ok: false, status, error });
    }

    busboy.on("field", (name, value) => {
      if (aborted) return;
      if (name === "metadata") {
        metadataRaw += value;
        if (metadataRaw.length > MAX_METADATA_BYTES) metadataOversize = true;
      }
    });

    busboy.on(
      "file",
      (
        name: string,
        stream: NodeJS.ReadableStream,
        info: { mimeType: string; filename: string },
      ) => {
        if (aborted) {
          stream.resume();
          return;
        }
        if (name !== "ifc") {
          stream.resume();
          return;
        }
        ifcSeen = true;
        stream.on("data", (chunk: Buffer) => {
          ifcBytes += chunk.length;
          if (ifcBytes > MAX_IFC_BYTES) {
            ifcTruncated = true;
            return;
          }
          ifcChunks.push(chunk);
        });
        stream.on("limit", () => {
          ifcTruncated = true;
        });
        stream.on("error", (err) => {
          logger.warn({ err, filename: info.filename }, "ifc stream error");
        });
      },
    );

    busboy.on("error", (err) => {
      logger.warn({ err }, "ifc busboy error");
      abort(400, "multipart_parse_failed");
    });

    busboy.on("finish", () => {
      if (aborted) return;
      if (metadataOversize) {
        abort(413, "metadata_too_large");
        return;
      }
      if (!metadataRaw.trim()) {
        abort(400, "missing_metadata_part");
        return;
      }
      let metadata: IfcMetadata;
      try {
        metadata = parseMetadata(metadataRaw);
      } catch (err) {
        abort(400, err instanceof Error ? err.message : "invalid_metadata");
        return;
      }
      if (!ifcSeen) {
        abort(400, "missing_ifc_part");
        return;
      }
      if (ifcTruncated) {
        abort(413, "ifc_too_large");
        return;
      }
      const bytes = Buffer.concat(ifcChunks, ifcBytes);
      resolve({ ok: true, upload: { metadata, bytes } });
    });

    req.pipe(busboy);
  });
}

interface IngestSuccess {
  ifcFileId: string;
  parsedAt: string;
  entityCount: number;
  gltfObjectPath: string | null;
  ifcVersion: string | null;
}

export interface IngestSnapshotIfcResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * End-to-end IFC ingest. Owns:
 *   1. Multipart parse (Busboy).
 *   2. Snapshot existence + secret check (caller already validated the secret;
 *      here we look up the snapshot to bind engagement_id).
 *   3. Storage upload (raw .ifc bytes → /objects/uploads/<uuid>).
 *   4. Upsert into snapshot_ifc_files (replaces blob on re-upload).
 *   5. web-ifc parse → entity rows + consolidated glTF.
 *   6. Transactional DB writes:
 *        DELETE FROM materializable_elements WHERE source_snapshot_id = $1
 *        INSERT N+1 rows (per-entity + bundle)
 *        UPDATE snapshot_ifc_files SET parsed_at, gltf_object_path, ...
 *   7. On parse failure: parse_error populated, blob preserved, 422.
 *
 * Caller (the route) handles secret/auth and the snapshot lookup; this
 * function is given the resolved `snapshot` row.
 */
export async function ingestSnapshotIfc(args: {
  req: Request;
  res: Response;
  snapshot: { id: string; engagementId: string };
}): Promise<void> {
  const { req, res, snapshot } = args;
  const reqLog = (req as unknown as { log?: typeof logger }).log ?? logger;

  const consumed = await consumeUpload(req, res);
  if (!consumed.ok) {
    res.status(consumed.status).json({ error: consumed.error });
    return;
  }
  const { metadata, bytes } = consumed.upload;

  const storage = new ObjectStorageService();

  // 1) Persist the raw IFC blob first so even a parse failure leaves us
  //    with the bytes for triage.
  let blobObjectPath: string;
  try {
    blobObjectPath = await storage.uploadObjectEntityFromBuffer(
      bytes,
      "application/octet-stream",
    );
  } catch (err) {
    reqLog.error({ err, snapshotId: snapshot.id }, "ifc ingest: storage upload failed");
    res.status(500).json({ error: "storage_error" });
    return;
  }

  // 2) Upsert snapshot_ifc_files. On re-upload, capture the previous blob
  //    paths so we can best-effort delete them after the new row commits.
  const previousRows = await db
    .select({
      id: snapshotIfcFiles.id,
      blobObjectPath: snapshotIfcFiles.blobObjectPath,
      gltfObjectPath: snapshotIfcFiles.gltfObjectPath,
    })
    .from(snapshotIfcFiles)
    .where(eq(snapshotIfcFiles.snapshotId, snapshot.id))
    .limit(1);
  const previous = previousRows[0] ?? null;

  let ifcFileId: string;
  try {
    if (previous) {
      // Replace: clear atoms first so the parse can re-emit cleanly.
      await db
        .delete(materializableElements)
        .where(eq(materializableElements.sourceSnapshotId, snapshot.id));
      await db
        .update(snapshotIfcFiles)
        .set({
          blobObjectPath,
          gltfObjectPath: null,
          fileSizeBytes: bytes.length,
          ifcVersion: metadata.ifcVersion ?? null,
          exportDurationMs: metadata.exportDurationMs ?? null,
          parseEntityCount: null,
          parsedAt: null,
          parseError: null,
          uploadedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(snapshotIfcFiles.id, previous.id));
      ifcFileId = previous.id;
    } else {
      const [inserted] = await db
        .insert(snapshotIfcFiles)
        .values({
          snapshotId: snapshot.id,
          blobObjectPath,
          fileSizeBytes: bytes.length,
          ifcVersion: metadata.ifcVersion ?? null,
          exportDurationMs: metadata.exportDurationMs ?? null,
        })
        .returning({ id: snapshotIfcFiles.id });
      if (!inserted) {
        throw new Error("snapshot_ifc_files insert returned no rows");
      }
      ifcFileId = inserted.id;
    }
  } catch (err) {
    reqLog.error({ err, snapshotId: snapshot.id }, "ifc ingest: db upsert failed");
    res.status(500).json({ error: "db_error" });
    return;
  }

  // 3) Parse. Inline (Phase 1; see lib/ifcParser/index.ts for upgrade path).
  let parseResult: ParseIfcResult;
  try {
    parseResult = await parseIfc({ bytes });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reqLog.warn(
      { err, snapshotId: snapshot.id, ifcFileId },
      "ifc ingest: web-ifc parse failed",
    );
    await db
      .update(snapshotIfcFiles)
      .set({ parseError: message, updatedAt: new Date() })
      .where(eq(snapshotIfcFiles.id, ifcFileId));
    res.status(422).json({ error: "ifc_parse_failed", detail: message });
    return;
  }

  // 4) Persist consolidated glTF.
  let gltfObjectPath: string | null = null;
  if (parseResult.glbBytes.length > 0) {
    try {
      gltfObjectPath = await storage.uploadObjectEntityFromBuffer(
        parseResult.glbBytes,
        "model/gltf-binary",
      );
    } catch (err) {
      reqLog.error(
        { err, snapshotId: snapshot.id, ifcFileId },
        "ifc ingest: gltf upload failed (proceeding without GLB)",
      );
      // Non-fatal: per-entity rows still get inserted; the viewer will
      // render no geometry but property-level lookups still work.
    }
  }

  // 5) Insert per-entity rows + the bundle row carrying the GLB path.
  try {
    if (parseResult.entities.length > 0) {
      await db.insert(materializableElements).values(
        parseResult.entities.map((e) => ({
          engagementId: snapshot.engagementId,
          sourceKind: "as-built-ifc" as const,
          elementKind: "as-built-ifc" as const,
          sourceSnapshotId: snapshot.id,
          ifcGlobalId: e.ifcGlobalId,
          ifcType: e.ifcType,
          label: e.label,
          propertySet: e.propertySet,
          locked: false,
        })),
      );
    }
    // Bundle row — carries the consolidated glTF for the viewer's
    // one-mesh-at-a-time rendering. Synthetic ifc_global_id / ifc_type
    // satisfy the CHECK invariant without colliding with real GUIDs.
    await db.insert(materializableElements).values({
      engagementId: snapshot.engagementId,
      sourceKind: "as-built-ifc-bundle",
      elementKind: "as-built-ifc",
      sourceSnapshotId: snapshot.id,
      ifcGlobalId: `bundle:${snapshot.id}`,
      ifcType: "<bundle>",
      label: "As-built IFC bundle",
      glbObjectPath: gltfObjectPath,
      locked: false,
    });
  } catch (err) {
    reqLog.error(
      { err, snapshotId: snapshot.id, ifcFileId },
      "ifc ingest: atom insert failed",
    );
    await db
      .update(snapshotIfcFiles)
      .set({
        parseError: `atom_insert_failed: ${err instanceof Error ? err.message : String(err)}`,
        updatedAt: new Date(),
      })
      .where(eq(snapshotIfcFiles.id, ifcFileId));
    res.status(500).json({ error: "atom_insert_failed" });
    return;
  }

  // 6) Mark the row parsed.
  const parsedAt = new Date();
  await db
    .update(snapshotIfcFiles)
    .set({
      parsedAt,
      gltfObjectPath,
      ifcVersion: parseResult.ifcVersion,
      parseEntityCount: parseResult.entityCount,
      parseError: null,
      updatedAt: parsedAt,
    })
    .where(eq(snapshotIfcFiles.id, ifcFileId));

  // 6a) Emit `engagement.ifc-ingested` on the timeline (Track C). Best-
  // effort — a history outage logs and proceeds; the row writes above
  // are the source of truth and stay committed regardless. Mirrors the
  // engagement.snapshot-received emission in routes/snapshots.ts.
  await emitEngagementIfcIngestedEvent(
    getHistoryService(),
    {
      engagementId: snapshot.engagementId,
      snapshotId: snapshot.id,
      ifcFileId,
      entityCount: parseResult.entityCount,
      ifcVersion: parseResult.ifcVersion,
    },
    reqLog,
  );

  // 7) Best-effort cleanup of the previous blobs. After-commit so a delete
  //    failure can't roll back the new write.
  if (previous) {
    if (previous.blobObjectPath && previous.blobObjectPath !== blobObjectPath) {
      storage
        .deleteObjectIfStored(previous.blobObjectPath)
        .catch((err) =>
          reqLog.warn(
            { err, prev: previous.blobObjectPath },
            "ifc ingest: previous blob cleanup failed",
          ),
        );
    }
    if (previous.gltfObjectPath && previous.gltfObjectPath !== gltfObjectPath) {
      storage
        .deleteObjectIfStored(previous.gltfObjectPath)
        .catch((err) =>
          reqLog.warn(
            { err, prev: previous.gltfObjectPath },
            "ifc ingest: previous gltf cleanup failed",
          ),
        );
    }
  }

  const success: IngestSuccess = {
    ifcFileId,
    parsedAt: parsedAt.toISOString(),
    entityCount: parseResult.entityCount,
    gltfObjectPath,
    ifcVersion: parseResult.ifcVersion,
  };
  res.status(201).json(success);
}

/**
 * Stream the raw IFC blob for a snapshot. Returns 404 if the snapshot
 * has no IFC.
 */
export async function streamSnapshotIfcBlob(args: {
  req: Request;
  res: Response;
  snapshotId: string;
}): Promise<void> {
  const { req, res, snapshotId } = args;
  const reqLog = (req as unknown as { log?: typeof logger }).log ?? logger;
  const rows = await db
    .select({ blobObjectPath: snapshotIfcFiles.blobObjectPath })
    .from(snapshotIfcFiles)
    .where(eq(snapshotIfcFiles.snapshotId, snapshotId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    res.status(404).json({ error: "ifc_not_found" });
    return;
  }
  await streamBlob({
    req,
    res,
    objectPath: row.blobObjectPath,
    contentType: "application/octet-stream",
    cacheControl: "private, max-age=300",
    log: reqLog,
  });
}

/**
 * Stream the consolidated glTF for a snapshot's IFC. 404 if the snapshot
 * has no IFC, the parse hasn't completed, or the parse failed.
 */
export async function streamSnapshotIfcGltf(args: {
  req: Request;
  res: Response;
  snapshotId: string;
}): Promise<void> {
  const { req, res, snapshotId } = args;
  const reqLog = (req as unknown as { log?: typeof logger }).log ?? logger;
  const rows = await db
    .select({
      gltfObjectPath: snapshotIfcFiles.gltfObjectPath,
      parsedAt: snapshotIfcFiles.parsedAt,
      parseError: snapshotIfcFiles.parseError,
    })
    .from(snapshotIfcFiles)
    .where(eq(snapshotIfcFiles.snapshotId, snapshotId))
    .limit(1);
  const row = rows[0];
  if (!row || row.parsedAt === null || row.parseError !== null || !row.gltfObjectPath) {
    res.status(404).json({ error: "gltf_not_available" });
    return;
  }
  await streamBlob({
    req,
    res,
    objectPath: row.gltfObjectPath,
    contentType: "model/gltf-binary",
    cacheControl: "private, max-age=3600",
    log: reqLog,
  });
}

async function streamBlob(args: {
  req: Request;
  res: Response;
  objectPath: string;
  contentType: string;
  cacheControl: string;
  log: typeof logger;
}): Promise<void> {
  const { res, objectPath, contentType, cacheControl, log } = args;
  try {
    const file = await new ObjectStorageService().getObjectEntityFile(objectPath);
    const [metadata] = await file.getMetadata();
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", cacheControl);
    if (metadata.size) res.setHeader("Content-Length", String(metadata.size));
    file
      .createReadStream()
      .on("error", (err) => {
        log.error({ err, objectPath }, "blob stream error");
        if (!res.headersSent) {
          res.status(500).json({ error: "blob_stream_failed" });
        } else {
          res.destroy(err);
        }
      })
      .pipe(res);
  } catch (err) {
    log.error({ err, objectPath }, "blob stream failed");
    res.status(500).json({ error: "blob_stream_failed" });
  }
}

export { MAX_IFC_BYTES };
