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
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  db,
  bimModels,
  snapshots,
  snapshotIfcFiles,
  materializableElements,
} from "@workspace/db";
import { BIM_MODEL_IFC_INGEST_ACTOR_ID } from "@workspace/server-actor-ids";
import type { EventAnchoringService } from "@hauska/atom-contract";
import { logger } from "./logger";
import { ObjectStorageService } from "./objectStorage";
import { parseIfc, type ParseIfcResult } from "./ifcParser";
import { getHistoryService } from "../atoms/registry";

/**
 * Upper bound on a single IFC upload. Raised above the sheet caps because
 * a federated Revit IFC for a multi-discipline project can run 50-100 MB
 * even after compression. The parser's transient heap during
 * `LoadAllGeometry` runs ~10x the file size; since QA-16 that heap lives
 * in a one-shot `worker_threads` worker, so an oversized IFC OOM-kills
 * only that worker — the api-server instance keeps serving.
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
 *   6b. DA-BIM-Symmetry: UPSERT a `bim_models` row for the engagement
 *       (one-per-engagement per the table's UNIQUE constraint) and
 *       append a `bim-model.ingested-from-ifc` atom event carrying the
 *       IFC provenance. Best-effort: the event append never fails the
 *       ingest. Makes the as-built IFC a first-class peer of the
 *       to-be-built Push-to-Revit side in the engagement atom graph.
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
  //    Guarded: an unguarded DB error here is exactly what made QA-04's
  //    Layer 1 surface as an opaque HTML 500 instead of clean JSON.
  let previous:
    | { id: string; blobObjectPath: string; gltfObjectPath: string | null }
    | null;
  try {
    const previousRows = await db
      .select({
        id: snapshotIfcFiles.id,
        blobObjectPath: snapshotIfcFiles.blobObjectPath,
        gltfObjectPath: snapshotIfcFiles.gltfObjectPath,
      })
      .from(snapshotIfcFiles)
      .where(eq(snapshotIfcFiles.snapshotId, snapshot.id))
      .limit(1);
    previous = previousRows[0] ?? null;
  } catch (err) {
    reqLog.error(
      { err, snapshotId: snapshot.id },
      "ifc ingest: snapshot_ifc_files lookup failed",
    );
    res.status(500).json({ error: "db_error" });
    return;
  }

  let ifcFileId: string;
  try {
    if (previous) {
      // Re-ingest: prior materializable_elements rows stay in place; the
      // step-5 transaction stamps them as superseded and links the new
      // row ids via superseded_by_id (mirrors briefing-sources, preserves
      // atom history per [[adr-001-atom-architecture]] / [[adr-011]]).
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

  // 3) Parse. Runs in a one-shot worker_threads worker (QA-16) — a hang,
  //    a WASM trap, or an OOM kills only that worker, never this instance.
  //    Any rejection (malformed IFC, parse timeout, worker crash) lands
  //    here and is recorded as the row's parse_error.
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
  } else {
    // QA-33 — when the IFC's geometry pass produced no bytes (every
    // `buildMeshForGeometry` early-returned because web-ifc reported
    // empty vertex/index arrays, or the IFC was metadata-only), the
    // bundle row's `glb_object_path` stays null and the viewer renders
    // an empty viewport even though per-entity rows were inserted.
    // Log loudly so the operator can recognize this case in Cloud Run
    // logs without having to inspect bucket contents.
    reqLog.warn(
      { snapshotId: snapshot.id, ifcFileId, entityCount: parseResult.entityCount },
      "ifc ingest: parser produced zero glb bytes — bundle row will have no GLB",
    );
  }

  // 5) Supersede prior active IFC rows for this engagement, insert
  //    the new per-entity rows + bundle row, and patch superseded_by_id
  //    on matching prior rows so the per-entity history is walkable.
  //
  //    Transactional so a partial failure cannot leave prior rows
  //    flagged superseded with no replacements (or vice-versa). Mirror
  //    of briefing-sources' supersession contract — see
  //    [[adr-001-atom-architecture]] / [[adr-011]]: atom history is
  //    append + supersede, never delete.
  //
  //    QA-35: scope is the *engagement*, not the *snapshot*. Each IFC
  //    re-upload creates a fresh snapshot (different `snapshot.id`),
  //    so a snapshot-scoped supersede always finds zero prior rows on
  //    re-ingest and lets prior generations stay active. Operator
  //    reproduced this on cortex-api-00020-85n: three uploads of the
  //    same Musgrave IFC stacked to 303 active rows (3 × 101) when
  //    only the most recent 101 should have been active. The partial
  //    unique index `materializable_elements_active_ifc_identity_uniq`
  //    is keyed `(source_snapshot_id, ifc_global_id)` so it still
  //    correctly prevented double-insert into the *same* snapshot but
  //    permitted overlap across snapshots — the index can be
  //    re-keyed to `(engagement_id, ifc_global_id)` in a follow-up
  //    migration to defense-in-depth this fix at the DB layer.
  try {
    await db.transaction(async (tx) => {
      // 5a) Read prior active rows (if any) so we can patch
      //     superseded_by_id once new rows have been assigned ids.
      //     Engagement-scoped + IFC-source-kind-scoped so a re-ingest
      //     across snapshots still finds prior generations to
      //     supersede. For a first-ingest this returns []; the rest
      //     of the transaction degrades to plain inserts.
      const priorActiveRows = await tx
        .select({
          id: materializableElements.id,
          ifcGlobalId: materializableElements.ifcGlobalId,
          sourceKind: materializableElements.sourceKind,
        })
        .from(materializableElements)
        .where(
          and(
            eq(materializableElements.engagementId, snapshot.engagementId),
            inArray(materializableElements.sourceKind, [
              "as-built-ifc",
              "as-built-ifc-bundle",
            ]),
            isNull(materializableElements.supersededAt),
          ),
        );
      const priorIdByIdentity = new Map<string, string>();
      for (const row of priorActiveRows) {
        if (row.ifcGlobalId === null) continue;
        priorIdByIdentity.set(
          `${row.sourceKind}|${row.ifcGlobalId}`,
          row.id,
        );
      }

      // 5b) Stamp supersession on all prior active IFC rows for this
      //     engagement up front. The matching new-row id (when one
      //     exists) gets patched into superseded_by_id in 5e once the
      //     inserts return; prior rows whose entity no longer appears
      //     in the re-ingest stay with superseded_by_id = null, which
      //     is the "tombstoned" lens.
      //
      //     The bundle rows from prior snapshots fall through to the
      //     tombstoned-lens branch because their synthetic
      //     `ifc_global_id = bundle:<snapshot.id>` is snapshot-unique
      //     by construction — there's no matching new bundle in
      //     `priorIdByIdentity`, which is intentional (we want the
      //     viewer's `loadAsBuiltIfcElementsForEngagement` query
      //     to see only the most-recent snapshot's bundle).
      if (priorActiveRows.length > 0) {
        await tx
          .update(materializableElements)
          .set({ supersededAt: new Date() })
          .where(
            and(
              eq(materializableElements.engagementId, snapshot.engagementId),
              inArray(materializableElements.sourceKind, [
                "as-built-ifc",
                "as-built-ifc-bundle",
              ]),
              isNull(materializableElements.supersededAt),
            ),
          );
      }

      // 5c) Insert per-entity rows.
      const insertedEntities =
        parseResult.entities.length > 0
          ? await tx
              .insert(materializableElements)
              .values(
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
              )
              .returning({
                id: materializableElements.id,
                ifcGlobalId: materializableElements.ifcGlobalId,
                sourceKind: materializableElements.sourceKind,
              })
          : [];

      // 5d) Bundle row — carries the consolidated glTF for the
      //     viewer's one-mesh-at-a-time rendering. Synthetic
      //     ifc_global_id / ifc_type satisfy the CHECK invariant
      //     without colliding with real GUIDs.
      const [insertedBundle] = await tx
        .insert(materializableElements)
        .values({
          engagementId: snapshot.engagementId,
          sourceKind: "as-built-ifc-bundle",
          elementKind: "as-built-ifc",
          sourceSnapshotId: snapshot.id,
          ifcGlobalId: `bundle:${snapshot.id}`,
          ifcType: "<bundle>",
          label: "As-built IFC bundle",
          glbObjectPath: gltfObjectPath,
          locked: false,
        })
        .returning({
          id: materializableElements.id,
          ifcGlobalId: materializableElements.ifcGlobalId,
          sourceKind: materializableElements.sourceKind,
        });
      if (!insertedBundle) {
        throw new Error("bundle insert returned no rows");
      }

      // 5e) Patch superseded_by_id on prior rows whose entity-identity
      //     re-appears in the new ingest. N+1 UPDATEs in a transaction
      //     — re-ingest is a rare operator-initiated path so the
      //     per-row chatter is acceptable; if profiling shows it as a
      //     hotspot on large IFCs, swap to a single VALUES-based UPDATE.
      if (priorIdByIdentity.size > 0) {
        const freshRows = [...insertedEntities, insertedBundle];
        for (const fresh of freshRows) {
          if (fresh.ifcGlobalId === null) continue;
          const priorId = priorIdByIdentity.get(
            `${fresh.sourceKind}|${fresh.ifcGlobalId}`,
          );
          if (priorId !== undefined) {
            await tx
              .update(materializableElements)
              .set({ supersededById: fresh.id })
              .where(eq(materializableElements.id, priorId));
          }
        }
      }
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

  // 6) Mark the row parsed. Guarded so a DB error here returns the
  //    route's clean `db_error` JSON rather than an opaque HTML 500.
  const parsedAt = new Date();
  try {
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
  } catch (err) {
    reqLog.error(
      { err, snapshotId: snapshot.id, ifcFileId },
      "ifc ingest: parsed-row update failed",
    );
    res.status(500).json({ error: "db_error" });
    return;
  }

  // 6b) DA-BIM-Symmetry — produce the `bim-model` atom for this
  //     engagement so the as-built IFC is a first-class peer of the
  //     to-be-built Push-to-Revit side in the atom graph. Best-effort:
  //     mirrors `emitBimModelEvent` in routes/bimModels.ts so an event
  //     append failure leaves the ingest's row writes intact and the
  //     response stays 201. Implemented as an exported helper so the
  //     unit test exercises the producer without driving the full route.
  await ensureBimModelAndEmitIfcIngestEvent({
    db,
    history: getHistoryService(),
    engagementId: snapshot.engagementId,
    snapshotId: snapshot.id,
    ifcFileId,
    ifcBlobObjectPath: blobObjectPath,
    gltfBundleObjectPath: gltfObjectPath,
    entityCount: parseResult.entityCount,
    entityTypes: distinctIfcTypes(parseResult.entities),
    log: reqLog,
  });

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
  // QA-33 — single structured success log line so an operator triaging
  // an empty viewport can see in one place: how many entities the
  // parser produced, how many glb bytes came out, and whether the
  // bundle row got a `glb_object_path` written. Together these three
  // distinguish the failure modes (zero-glb-bytes vs upload-failed vs
  // bundle-OK-but-viewer-side issue) without needing bucket access.
  reqLog.info(
    {
      snapshotId: snapshot.id,
      ifcFileId,
      entityCount: parseResult.entityCount,
      glbBytesLen: parseResult.glbBytes.length,
      gltfObjectPath,
      ifcVersion: parseResult.ifcVersion,
    },
    "ifc ingest: complete",
  );
  res.status(201).json(success);
}

/**
 * Distinct list of IFC types observed in a parsed result, sorted for
 * stability so the atom event payload is deterministic across calls
 * with the same input set (helps test assertions and chain hashing).
 */
export function distinctIfcTypes(
  entities: ReadonlyArray<{ ifcType: string }>,
): string[] {
  const set = new Set<string>();
  for (const e of entities) set.add(e.ifcType);
  return [...set].sort();
}

/**
 * Payload shape for the `bim-model.ingested-from-ifc` atom event.
 * Exported so test assertions (and any future consumer that wants to
 * narrow on the event payload) can pin the contract instead of typing
 * `Record<string, unknown>` everywhere.
 */
export interface BimModelIngestedFromIfcPayload {
  snapshotId: string;
  ifcFileId: string;
  sourceKind: "as-built-ifc";
  ifcBlobObjectPath: string;
  gltfBundleObjectPath: string | null;
  entityCount: number;
  entityTypes: ReadonlyArray<string>;
}

/**
 * DA-BIM-Symmetry producer — ensures a `bim_models` row exists for the
 * engagement and appends a `bim-model.ingested-from-ifc` atom event
 * with the IFC ingest provenance. Mirrors the best-effort posture of
 * `emitBimModelEvent` in `routes/bimModels.ts`: row writes are the
 * source of truth, event-append failure is logged but never fails the
 * caller.
 *
 * Exported so the test suite can exercise the producer in isolation
 * without driving the full multipart route (the route is exercised by
 * the integration test).
 *
 * Re-ingest of the same IFC appends a new event on the existing
 * bim-model row's chain — the atom history is append-only per ADR-001
 * even though the materializable_elements rows are delete-and-reinsert
 * today (recon §57 / ADR-011 follow-on, out of scope here).
 *
 * Returns the bim-model row id when the upsert succeeded (regardless of
 * event append outcome), or null when even the upsert failed — the
 * caller treats null as "skip the ingest event" and continues.
 */
export async function ensureBimModelAndEmitIfcIngestEvent(args: {
  db: typeof db;
  history: EventAnchoringService;
  engagementId: string;
  snapshotId: string;
  ifcFileId: string;
  ifcBlobObjectPath: string;
  gltfBundleObjectPath: string | null;
  entityCount: number;
  entityTypes: ReadonlyArray<string>;
  log: typeof logger;
}): Promise<string | null> {
  const {
    db: dbInst,
    history,
    engagementId,
    snapshotId,
    ifcFileId,
    ifcBlobObjectPath,
    gltfBundleObjectPath,
    entityCount,
    entityTypes,
    log,
  } = args;

  // UPSERT the bim_models row. The UNIQUE constraint on engagement_id
  // means at most one row per engagement.
  //
  // QA-32 (2026-05-23): stamp `materializedAt` on every successful IFC
  // ingest — on INSERT and on CONFLICT. Prior behaviour was ON CONFLICT
  // DO NOTHING on the rationale that "IFC ingest is as-built provenance
  // and must not clobber to-be-built columns"; the Musgrave_Residence_B
  // verify on cortex-api-00017-jnn surfaced the failure mode that
  // protected: an engagement pushed straight from Revit (no prior
  // briefing-driven Push-to-Revit) ended up with `materialized_at =
  // NULL`, which the design-tools BIM-viewer FE treats (alongside zero
  // elements) as "no model yet". `materialized_at` now means
  // "the most recent successful materialization (briefing OR IFC)" —
  // the briefing-push handler already sets it the same way. The other
  // to-be-built columns (`activeBriefingId`, `briefingVersion`,
  // `revitDocumentPath`) are intentionally NOT touched here; the IFC
  // ingest still has no opinion about them.
  const materializedAt = new Date();
  let bimModelId: string | null = null;
  try {
    const [upserted] = await dbInst
      .insert(bimModels)
      .values({ engagementId, materializedAt, updatedAt: materializedAt })
      .onConflictDoUpdate({
        target: bimModels.engagementId,
        set: { materializedAt, updatedAt: materializedAt },
      })
      .returning({ id: bimModels.id });
    bimModelId = upserted?.id ?? null;
  } catch (err) {
    log.error(
      { err, engagementId, snapshotId, ifcFileId },
      "bim-model upsert for IFC ingest failed — skipping atom event",
    );
    return null;
  }

  if (!bimModelId) {
    log.error(
      { engagementId, snapshotId, ifcFileId },
      "bim-model upsert returned no id and no existing row — skipping atom event",
    );
    return null;
  }

  const payload: BimModelIngestedFromIfcPayload = {
    snapshotId,
    ifcFileId,
    sourceKind: "as-built-ifc",
    ifcBlobObjectPath,
    gltfBundleObjectPath,
    entityCount,
    entityTypes,
  };

  try {
    const event = await history.appendEvent({
      entityType: "bim-model",
      entityId: bimModelId,
      eventType: "bim-model.ingested-from-ifc",
      actor: { kind: "system", id: BIM_MODEL_IFC_INGEST_ACTOR_ID },
      payload: payload as unknown as Record<string, unknown>,
    });
    log.info(
      {
        bimModelId,
        engagementId,
        snapshotId,
        ifcFileId,
        eventId: event.id,
        chainHash: event.chainHash,
      },
      "bim-model.ingested-from-ifc event appended",
    );
  } catch (err) {
    log.error(
      { err, bimModelId, engagementId, snapshotId, ifcFileId },
      "bim-model.ingested-from-ifc event append failed — bim_models row kept",
    );
  }

  return bimModelId;
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
