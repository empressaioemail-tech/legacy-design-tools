import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { createHash } from "node:crypto";
import Busboy from "busboy";
import { db, snapshots, sheets, submissions } from "@workspace/db";
import { eq, sql, asc, and, inArray, desc, lte } from "drizzle-orm";
import { logger } from "../lib/logger";
import { getSnapshotSecret } from "../lib/snapshotSecret";
import { getHistoryService } from "../atoms/registry";
import { extractSheetCrossRefs } from "../lib/sheetCrossRefs";
import {
  runSheetContentExtraction,
  type SheetExtractionTarget,
} from "../lib/sheetContentExtractor";

const snapshotSecret = getSnapshotSecret();

const router: IRouter = Router();

const MAX_THUMB_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_FULL_BYTES = 20 * 1024 * 1024; // 20 MB
const MAX_TOTAL_BYTES = 150 * 1024 * 1024; // 150 MB
const MAX_SHEETS_PER_UPLOAD = 500;

interface SheetMetadataEntry {
  index: number;
  sheetNumber: string;
  sheetName: string;
  viewCount: number | null;
  revisionNumber: string | null;
  revisionDate: string | null;
  thumbnailWidth: number;
  thumbnailHeight: number;
  fullWidth: number;
  fullHeight: number;
  contentBody: string | null;
}

/**
 * Scalar columns we diff for `sheet.updated` events. Binary PNG columns
 * are diffed separately by SHA-256 hash to keep payloads bounded.
 */
const SHEET_DIFF_SCALAR_FIELDS = [
  "sheetName",
  "viewCount",
  "revisionNumber",
  "revisionDate",
  "thumbnailWidth",
  "thumbnailHeight",
  "fullWidth",
  "fullHeight",
  "sortOrder",
  "engagementId",
  "contentBody",
] as const;

function sha256Hex(buf: Buffer | Uint8Array): string {
  return createHash("sha256")
    .update(Buffer.isBuffer(buf) ? buf : Buffer.from(buf))
    .digest("hex");
}

interface SheetUpdateChange {
  from: unknown;
  to: unknown;
}

/**
 * Produce a field-level diff between an existing sheet row and the
 * proposed insert values. Only changed fields are returned. Binary
 * fields (`thumbnailPng`, `fullPng`) are diffed by SHA-256 hash so the
 * resulting event payload stays small even when the PNGs are large.
 */
function diffSheetRow(
  oldRow: Record<string, unknown>,
  newRow: Record<string, unknown>,
): Record<string, SheetUpdateChange> {
  const changes: Record<string, SheetUpdateChange> = {};
  for (const f of SHEET_DIFF_SCALAR_FIELDS) {
    const oldV = oldRow[f] ?? null;
    const newV = newRow[f] ?? null;
    if (oldV !== newV) {
      changes[f] = { from: oldV, to: newV };
    }
  }
  for (const f of ["thumbnailPng", "fullPng"] as const) {
    const oldB = oldRow[f] as Buffer | Uint8Array | undefined | null;
    const newB = newRow[f] as Buffer | Uint8Array | undefined | null;
    if (!oldB || !newB) continue;
    const oldH = sha256Hex(oldB);
    const newH = sha256Hex(newB);
    if (oldH !== newH) {
      changes[f] = { from: oldH, to: newH };
    }
  }
  return changes;
}

function parseMetadataEntries(raw: string): SheetMetadataEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("metadata field is not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("metadata must be a JSON array");
  }
  const out: SheetMetadataEntry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      throw new Error("metadata entries must be objects");
    }
    const o = item as Record<string, unknown>;
    if (
      typeof o["index"] !== "number" ||
      typeof o["sheetNumber"] !== "string" ||
      typeof o["sheetName"] !== "string" ||
      typeof o["thumbnailWidth"] !== "number" ||
      typeof o["thumbnailHeight"] !== "number" ||
      typeof o["fullWidth"] !== "number" ||
      typeof o["fullHeight"] !== "number"
    ) {
      throw new Error(
        "each metadata entry needs index, sheetNumber, sheetName, thumbnailWidth/Height, fullWidth/Height",
      );
    }
    out.push({
      index: o["index"] as number,
      sheetNumber: (o["sheetNumber"] as string).trim(),
      sheetName: (o["sheetName"] as string).trim(),
      viewCount:
        typeof o["viewCount"] === "number"
          ? (o["viewCount"] as number)
          : null,
      revisionNumber:
        typeof o["revisionNumber"] === "string"
          ? (o["revisionNumber"] as string)
          : null,
      revisionDate:
        typeof o["revisionDate"] === "string"
          ? (o["revisionDate"] as string)
          : null,
      thumbnailWidth: o["thumbnailWidth"] as number,
      thumbnailHeight: o["thumbnailHeight"] as number,
      fullWidth: o["fullWidth"] as number,
      fullHeight: o["fullHeight"] as number,
      contentBody:
        typeof o["contentBody"] === "string"
          ? (o["contentBody"] as string)
          : null,
    });
  }
  return out;
}

router.post(
  "/snapshots/:snapshotId/sheets",
  async (req: Request, res: Response) => {
    if (!snapshotSecret) {
      res.status(500).json({ error: "snapshot secret not configured" });
      return;
    }
    const provided = req.header("x-snapshot-secret");
    if (!provided || provided !== snapshotSecret) {
      res.status(401).json({ error: "Invalid snapshot secret" });
      return;
    }

    const contentType = req.headers["content-type"] ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
      res.status(415).json({ error: "Expected multipart/form-data body" });
      return;
    }

    const snapshotId = req.params["snapshotId"];
    if (!snapshotId) {
      res.status(400).json({ error: "Missing snapshotId" });
      return;
    }
    const snapshotIdStr = String(snapshotId);

    let snapRows;
    try {
      snapRows = await db
        .select({ id: snapshots.id, engagementId: snapshots.engagementId })
        .from(snapshots)
        .where(eq(snapshots.id, snapshotIdStr))
        .limit(1);
    } catch (err) {
      logger.error({ err, snapshotId }, "sheet upload: snapshot lookup failed");
      res.status(500).json({ error: "Snapshot lookup failed" });
      return;
    }

    const snap = snapRows[0];
    if (!snap) {
      res.status(404).json({ error: "Snapshot not found" });
      return;
    }
    const engagementId = snap.engagementId;

    let busboy: Busboy.Busboy;
    try {
      busboy = Busboy({
        headers: req.headers,
        limits: {
          fileSize: MAX_FULL_BYTES,
          files: MAX_SHEETS_PER_UPLOAD * 2,
          fields: 10,
        },
      });
    } catch (err) {
      logger.warn({ err }, "busboy init failed");
      res.status(400).json({ error: "Invalid multipart body" });
      return;
    }

    let metadataRaw = "";
    const thumbsByIndex = new Map<number, Buffer>();
    const fullsByIndex = new Map<number, Buffer>();
    const errors: string[] = [];
    let totalBytes = 0;
    let aborted = false;
    let responded = false;

    function safeRespond(status: number, body: unknown) {
      if (responded) return;
      responded = true;
      res.status(status).json(body);
    }

    function abort(status: number, message: string) {
      if (aborted) return;
      aborted = true;
      try {
        req.unpipe(busboy);
      } catch {
        /* ignore */
      }
      safeRespond(status, { error: message });
    }

    busboy.on("field", (name, value) => {
      if (aborted) return;
      if (name === "metadata") {
        metadataRaw += value;
        if (metadataRaw.length > 1024 * 1024) {
          abort(413, "metadata field too large");
        }
      }
    });

    busboy.on(
      "file",
      (
        name: string,
        stream: NodeJS.ReadableStream,
        info: { mimeType: string },
      ) => {
        if (aborted) {
          stream.resume();
          return;
        }
        const m = /^sheet_(\d+)_(thumb|full)$/.exec(name);
        if (!m || !m[1] || !m[2]) {
          stream.resume();
          errors.push(`unrecognized file field "${name}" — skipping`);
          return;
        }
        const idx = Number(m[1]);
        const kind = m[2] as "thumb" | "full";
        const cap = kind === "thumb" ? MAX_THUMB_BYTES : MAX_FULL_BYTES;

        if (
          info.mimeType !== "image/png" &&
          !info.mimeType.toLowerCase().includes("png")
        ) {
          stream.resume();
          errors.push(
            `field ${name} has content-type ${info.mimeType}; expected image/png`,
          );
          return;
        }

        const chunks: Buffer[] = [];
        let bytes = 0;
        let truncated = false;

        stream.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          totalBytes += chunk.length;
          if (totalBytes > MAX_TOTAL_BYTES) {
            abort(413, "request body exceeded 150MB total cap");
            return;
          }
          if (bytes > cap) {
            truncated = true;
            return;
          }
          chunks.push(chunk);
        });
        stream.on("limit", () => {
          truncated = true;
        });
        stream.on("end", () => {
          if (aborted) return;
          if (truncated) {
            errors.push(
              `${kind} for sheet index ${idx} exceeded ${cap / 1024 / 1024}MB; skipped`,
            );
            return;
          }
          const buf = Buffer.concat(chunks, bytes);
          if (kind === "thumb") thumbsByIndex.set(idx, buf);
          else fullsByIndex.set(idx, buf);
        });
        stream.on("error", (err) => {
          logger.warn({ err, name }, "stream error during sheet upload");
        });
      },
    );

    busboy.on("filesLimit", () =>
      abort(413, `too many files; cap is ${MAX_SHEETS_PER_UPLOAD * 2}`),
    );
    busboy.on("error", (err) => {
      logger.warn({ err }, "busboy parse error");
      abort(400, "Failed to parse multipart body");
    });

    // Prefer the per-request logger (carries the pino-http request id
    // for trace correlation in production) but fall back to the module
    // singleton when the request was wired up without pino-http (notably
    // the test harness in `setup.ts`). This matches the brief's ask for
    // request-scoped logging without breaking the unit tests.
    const reqLogger =
      (req as unknown as { log?: typeof logger }).log ?? logger;

    busboy.on("finish", async () => {
      if (aborted) return;
      let entries: SheetMetadataEntry[];
      try {
        if (!metadataRaw.trim()) {
          throw new Error("metadata field is required");
        }
        entries = parseMetadataEntries(metadataRaw);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Invalid metadata";
        safeRespond(400, { error: msg });
        return;
      }

      let uploaded = 0;
      let skipped = 0;
      let failed = 0;

      const rowsToInsert: Array<typeof sheets.$inferInsert> = [];
      const seenSheetNumbers = new Set<string>();

      for (const entry of entries) {
        const thumb = thumbsByIndex.get(entry.index);
        const full = fullsByIndex.get(entry.index);
        if (!thumb || !full) {
          skipped++;
          errors.push(
            `sheet index ${entry.index} (${entry.sheetNumber}) missing ${
              !thumb && !full ? "both thumb and full" : !thumb ? "thumb" : "full"
            } image — skipped`,
          );
          continue;
        }
        if (!entry.sheetNumber) {
          skipped++;
          errors.push(`sheet index ${entry.index} has empty sheetNumber — skipped`);
          continue;
        }
        if (seenSheetNumbers.has(entry.sheetNumber)) {
          skipped++;
          errors.push(
            `duplicate sheetNumber "${entry.sheetNumber}" in upload — keeping first`,
          );
          continue;
        }
        seenSheetNumbers.add(entry.sheetNumber);

        rowsToInsert.push({
          snapshotId: snapshotIdStr,
          engagementId,
          sheetNumber: entry.sheetNumber,
          sheetName: entry.sheetName,
          viewCount: entry.viewCount,
          revisionNumber: entry.revisionNumber,
          revisionDate: entry.revisionDate,
          thumbnailPng: thumb,
          thumbnailWidth: entry.thumbnailWidth,
          thumbnailHeight: entry.thumbnailHeight,
          fullPng: full,
          fullWidth: entry.fullWidth,
          fullHeight: entry.fullHeight,
          sortOrder: entry.index,
          contentBody: entry.contentBody,
        });
      }

      // Each upsert runs as its own statement (no enclosing transaction),
      // so a single failed row cannot poison the rest. Postgres aborts a
      // transaction on the first statement error, which made the
      // per-row try/catch inside `db.transaction` ineffective for
      // partial-success semantics.
      //
      // We RETURN `(xmax = 0)` alongside the row id so we can tell whether
      // the upsert produced a fresh row (xmax = 0) or merely updated an
      // existing one (xmax != 0). Fresh rows emit `sheet.created`;
      // updates emit `sheet.updated` with a diff payload (task #20).
      const history = getHistoryService();

      // Pre-fetch any existing rows for the (snapshotId, sheetNumber)
      // pairs we're about to upsert. We need the OLD column values so
      // the `sheet.updated` payload can carry a real diff. A single
      // batched query is cheap (small N, indexed by the unique
      // constraint) and avoids a per-row round trip. Best-effort: if
      // this query fails we proceed with empty diffs rather than
      // failing the whole ingest.
      const existingByNumber = new Map<string, Record<string, unknown>>();
      if (rowsToInsert.length > 0) {
        try {
          const existingRows = await db
            .select()
            .from(sheets)
            .where(
              and(
                eq(sheets.snapshotId, snapshotIdStr),
                inArray(
                  sheets.sheetNumber,
                  rowsToInsert.map((r) => r.sheetNumber),
                ),
              ),
            );
          for (const r of existingRows) {
            existingByNumber.set(
              r.sheetNumber,
              r as unknown as Record<string, unknown>,
            );
          }
        } catch (err) {
          reqLogger.warn(
            { err, snapshotId },
            "pre-fetch of existing sheets for diff failed — sheet.updated payloads will have empty diffs",
          );
        }
      }

      for (const row of rowsToInsert) {
        let inserted: { id: string; wasInsert: boolean } | null = null;
        try {
          const returned = await db
            .insert(sheets)
            .values(row)
            .onConflictDoUpdate({
              target: [sheets.snapshotId, sheets.sheetNumber],
              set: {
                sheetName: row.sheetName,
                viewCount: row.viewCount,
                revisionNumber: row.revisionNumber,
                revisionDate: row.revisionDate,
                thumbnailPng: row.thumbnailPng,
                thumbnailWidth: row.thumbnailWidth,
                thumbnailHeight: row.thumbnailHeight,
                fullPng: row.fullPng,
                fullWidth: row.fullWidth,
                fullHeight: row.fullHeight,
                sortOrder: row.sortOrder,
                engagementId: row.engagementId,
                contentBody: row.contentBody,
              },
            })
            .returning({
              id: sheets.id,
              // `xmax = 0` is the canonical Postgres trick for "this
              // tuple was just inserted" vs "this tuple existed and was
              // updated by ON CONFLICT". Cast to boolean so drizzle
              // surfaces it cleanly.
              wasInsert: sql<boolean>`(xmax = 0)`.as("was_insert"),
            });
          uploaded++;
          if (returned[0]) {
            inserted = {
              id: returned[0].id,
              wasInsert: Boolean(returned[0].wasInsert),
            };
          }
        } catch (err) {
          failed++;
          errors.push(
            `db insert failed for sheet ${row.sheetNumber}: ${err instanceof Error ? err.message : String(err)}`,
          );
          reqLogger.warn(
            { err, snapshotId, sheetNumber: row.sheetNumber },
            "sheet insert failed",
          );
          continue;
        }

        // Event emission is best-effort: a history append failure must
        // never roll back or fail the row insert (the row is the source
        // of truth; events are observability). Per task #18 invariants.
        if (inserted) {
          if (inserted.wasInsert) {
            try {
              const event = await history.appendEvent({
                entityType: "sheet",
                entityId: inserted.id,
                eventType: "sheet.created",
                // No human actor for snapshot ingest — the add-in posts on
                // behalf of the workstation. We model it as a system actor
                // with a stable id so downstream consumers can filter
                // ingest-originated events without false positives.
                actor: { kind: "system", id: "snapshot-ingest" },
                payload: {
                  sheetNumber: row.sheetNumber,
                  sheetName: row.sheetName,
                  snapshotId: snapshotIdStr,
                  engagementId: row.engagementId,
                },
              });
              reqLogger.info(
                {
                  sheetId: inserted.id,
                  snapshotId,
                  sheetNumber: row.sheetNumber,
                  eventId: event.id,
                  chainHash: event.chainHash,
                },
                "sheet.created event appended",
              );
            } catch (err) {
              reqLogger.error(
                {
                  err,
                  sheetId: inserted.id,
                  snapshotId,
                  sheetNumber: row.sheetNumber,
                },
                "sheet.created event append failed — row insert kept",
              );
            }
          } else {
            // The upsert hit `onConflictDoUpdate` (xmax != 0) so this is
            // a re-upload of an existing (snapshotId, sheetNumber)
            // pair. Emit `sheet.updated` with a field-level diff so the
            // history chain grows under the ingest path (task #20).
            const oldRow = existingByNumber.get(row.sheetNumber);
            const changes = oldRow
              ? diffSheetRow(oldRow, row as unknown as Record<string, unknown>)
              : {};
            try {
              const event = await history.appendEvent({
                entityType: "sheet",
                entityId: inserted.id,
                eventType: "sheet.updated",
                actor: { kind: "system", id: "snapshot-ingest" },
                payload: {
                  sheetNumber: row.sheetNumber,
                  snapshotId: snapshotIdStr,
                  engagementId: row.engagementId,
                  changes,
                },
              });
              reqLogger.info(
                {
                  sheetId: inserted.id,
                  snapshotId,
                  sheetNumber: row.sheetNumber,
                  eventId: event.id,
                  chainHash: event.chainHash,
                  changedFields: Object.keys(changes),
                },
                "sheet.updated event appended",
              );
            } catch (err) {
              reqLogger.error(
                {
                  err,
                  sheetId: inserted.id,
                  snapshotId,
                  sheetNumber: row.sheetNumber,
                },
                "sheet.updated event append failed — row update kept",
              );
            }
          }
        }
      }

      // Diff against the prior snapshot for this engagement and emit a
      // `sheet.removed` event for any sheet that lived in the prior
      // snapshot but is missing from this upload. This is what causes
      // an entity's history chain to grow across snapshots — the row
      // itself stays put (it belongs to the old snapshot), but its
      // event log records that it no longer appears in the engagement's
      // current state. (Task #20.)
      try {
        const priorSnapRows = await db
          .select({ id: snapshots.id })
          .from(snapshots)
          .where(
            and(
              eq(snapshots.engagementId, engagementId),
              sql`${snapshots.receivedAt} < (
                SELECT ${snapshots.receivedAt} FROM ${snapshots}
                WHERE ${snapshots.id} = ${snapshotIdStr}
              )`,
            ),
          )
          .orderBy(desc(snapshots.receivedAt))
          .limit(1);
        const prior = priorSnapRows[0];
        if (prior) {
          const priorSheets = await db
            .select({
              id: sheets.id,
              sheetNumber: sheets.sheetNumber,
              sheetName: sheets.sheetName,
            })
            .from(sheets)
            .where(eq(sheets.snapshotId, prior.id));
          const currentNumbers = new Set(
            rowsToInsert.map((r) => r.sheetNumber),
          );
          for (const ps of priorSheets) {
            if (currentNumbers.has(ps.sheetNumber)) continue;
            // Idempotency guard: if a previous ingest into a snapshot
            // newer than `prior` already emitted `sheet.removed` for
            // this entity, skip — re-emitting on every subsequent
            // ingest would noisily inflate the chain.
            try {
              const latest = await history.latestEvent({
                kind: "atom",
                entityType: "sheet",
                entityId: ps.id,
              });
              if (latest && latest.eventType === "sheet.removed") continue;
            } catch (err) {
              reqLogger.warn(
                { err, sheetId: ps.id },
                "latestEvent lookup for sheet.removed idempotency failed — emitting anyway",
              );
            }
            try {
              const ev = await history.appendEvent({
                entityType: "sheet",
                entityId: ps.id,
                eventType: "sheet.removed",
                actor: { kind: "system", id: "snapshot-ingest" },
                payload: {
                  sheetNumber: ps.sheetNumber,
                  sheetName: ps.sheetName,
                  snapshotId: prior.id,
                  engagementId,
                  missingFromSnapshotId: snapshotIdStr,
                },
              });
              reqLogger.info(
                {
                  sheetId: ps.id,
                  priorSnapshotId: prior.id,
                  currentSnapshotId: snapshotIdStr,
                  sheetNumber: ps.sheetNumber,
                  eventId: ev.id,
                  chainHash: ev.chainHash,
                },
                "sheet.removed event appended",
              );
            } catch (err) {
              reqLogger.error(
                {
                  err,
                  sheetId: ps.id,
                  sheetNumber: ps.sheetNumber,
                },
                "sheet.removed event append failed",
              );
            }
          }
        }
      } catch (err) {
        reqLogger.warn(
          { err, snapshotId },
          "sheet.removed diff against prior snapshot failed — skipping removals",
        );
      }

      // Recompute snapshot.sheetCount from the canonical sheets table so the
      // engagement detail KPI line stays in sync — runs whether or not
      // every row succeeded.
      try {
        await db
          .update(snapshots)
          .set({
            sheetCount: sql<number>`(select cast(count(*) as int) from ${sheets} where ${sheets.snapshotId} = ${snapshotIdStr})`,
          })
          .where(eq(snapshots.id, snapshotIdStr));
      } catch (err) {
        logger.error(
          { err, snapshotId },
          "failed to recompute sheetCount after upload",
        );
        errors.push("warning: sheetCount recompute failed");
      }

      // Snapshot-level lifecycle event. Emitted once per request — even
      // if every row in the upload was an upsert-update (uploaded=0 is
      // not a meaningful skip signal here, the request itself attaching
      // sheets to the snapshot is what consumers care about). Best-effort
      // exactly like the per-sheet `sheet.created` emission above.
      try {
        const event = await history.appendEvent({
          entityType: "snapshot",
          entityId: snapshotIdStr,
          eventType: "snapshot.sheets_attached",
          actor: { kind: "system", id: "snapshot-ingest" },
          payload: {
            engagementId,
            uploaded,
            skipped,
            failed,
          },
        });
        reqLogger.info(
          {
            snapshotId,
            engagementId,
            uploaded,
            skipped,
            failed,
            eventId: event.id,
            chainHash: event.chainHash,
          },
          "snapshot.sheets_attached event appended",
        );
      } catch (err) {
        reqLogger.error(
          { err, snapshotId, engagementId },
          "snapshot.sheets_attached event append failed — upload kept",
        );
      }

      safeRespond(200, { uploaded, skipped, failed, errors });

      // Fire-and-forget vision/OCR extraction pass for sheets whose
      // metadata.contentBody was null (i.e. the Revit add-in did not
      // ship a Revit-side text capture). The pass calls the configured
      // sheet-content LLM client and patches the row's content_body
      // column once the call returns. In `mock` mode (the default) the
      // extractor short-circuits to null and this loop is essentially
      // free. The whole stage is wrapped in an outer try/catch so a
      // failure in the (post-response) target-lookup step never
      // produces an unhandled rejection on the busboy `finish` handler.
      // (Task #477.)
      void (async () => {
        try {
          const extractionTargets: SheetExtractionTarget[] = [];
          for (const row of rowsToInsert) {
            if (row.contentBody) continue;
            const matchEntry = entries.find(
              (e) => e.sheetNumber === row.sheetNumber,
            );
            if (!matchEntry) continue;
            const full = fullsByIndex.get(matchEntry.index);
            if (!full) continue;
            const idForExtract = (
              await db
                .select({ id: sheets.id })
                .from(sheets)
                .where(
                  and(
                    eq(sheets.snapshotId, snapshotIdStr),
                    eq(sheets.sheetNumber, row.sheetNumber),
                  ),
                )
                .limit(1)
            )[0]?.id;
            if (!idForExtract) continue;
            extractionTargets.push({ sheetId: idForExtract, fullPng: full });
          }
          if (extractionTargets.length > 0) {
            await runSheetContentExtraction(extractionTargets, reqLogger);
          }
        } catch (err) {
          reqLogger.error(
            { err, snapshotId },
            "sheet-content extraction pass failed unexpectedly",
          );
        }
      })();
    });

    req.pipe(busboy);
  },
);

router.get(
  "/snapshots/:snapshotId/sheets",
  async (req: Request, res: Response) => {
    const snapshotId = String(req.params["snapshotId"] ?? "");
    if (!snapshotId) {
      res.status(400).json({ error: "Missing snapshotId" });
      return;
    }
    try {
      const snapRows = await db
        .select({ id: snapshots.id })
        .from(snapshots)
        .where(eq(snapshots.id, snapshotId))
        .limit(1);
      if (snapRows.length === 0) {
        res.status(404).json({ error: "Snapshot not found" });
        return;
      }

      const rows = await db
        .select({
          id: sheets.id,
          snapshotId: sheets.snapshotId,
          engagementId: sheets.engagementId,
          sheetNumber: sheets.sheetNumber,
          sheetName: sheets.sheetName,
          viewCount: sheets.viewCount,
          revisionNumber: sheets.revisionNumber,
          revisionDate: sheets.revisionDate,
          thumbnailWidth: sheets.thumbnailWidth,
          thumbnailHeight: sheets.thumbnailHeight,
          fullWidth: sheets.fullWidth,
          fullHeight: sheets.fullHeight,
          sortOrder: sheets.sortOrder,
          contentBody: sheets.contentBody,
          createdAt: sheets.createdAt,
        })
        .from(sheets)
        .where(eq(sheets.snapshotId, snapshotId))
        .orderBy(asc(sheets.sortOrder));

      res.json(
        rows.map((r) => ({
          ...r,
          createdAt: r.createdAt.toISOString(),
          crossRefs: extractSheetCrossRefs(r.contentBody ?? ""),
        })),
      );
    } catch (err) {
      logger.error({ err, snapshotId }, "list sheets failed");
      res.status(500).json({ error: "Failed to list sheets" });
    }
  },
);

async function serveSheetPng(
  req: Request,
  res: Response,
  column: "thumbnailPng" | "fullPng",
) {
  const id = String(req.params["id"] ?? "");
  if (!id) {
    res.status(400).json({ error: "Missing id" });
    return;
  }
  try {
    const rows = await db
      .select({
        bytes: column === "thumbnailPng" ? sheets.thumbnailPng : sheets.fullPng,
      })
      .from(sheets)
      .where(eq(sheets.id, id))
      .limit(1);

    const row = rows[0];
    if (!row || !row.bytes) {
      res.status(404).json({ error: "Sheet not found" });
      return;
    }

    const buf = Buffer.isBuffer(row.bytes)
      ? row.bytes
      : Buffer.from(row.bytes as Uint8Array);
    // ETag is derived from the bytes themselves so re-uploading a sheet
    // (same id, different image) busts cached entries even though the URL
    // is unchanged.
    const etag = `"${createHash("sha1").update(buf).digest("hex")}"`;

    if (req.headers["if-none-match"] === etag) {
      res.status(304).end();
      return;
    }

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Length", String(buf.length));
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.setHeader("ETag", etag);
    res.end(buf);
  } catch (err) {
    logger.error({ err, id, column }, "serve sheet png failed");
    res.status(500).json({ error: "Failed to load sheet image" });
  }
}

router.get(
  "/submissions/:submissionId/sheets",
  async (req: Request, res: Response) => {
    const submissionId = String(req.params["submissionId"] ?? "");
    if (!submissionId) {
      res.status(400).json({ error: "Missing submissionId" });
      return;
    }
    try {
      const subRows = await db
        .select({
          id: submissions.id,
          engagementId: submissions.engagementId,
          submittedAt: submissions.submittedAt,
        })
        .from(submissions)
        .where(eq(submissions.id, submissionId))
        .limit(1);
      const sub = subRows[0];
      if (!sub) {
        res.status(404).json({ error: "Submission not found" });
        return;
      }

      // Resolve the submission's *contemporaneous* snapshot — the
      // newest snapshot uploaded at or before `submittedAt`. Pinning
      // to submission time (instead of "engagement's latest snapshot
      // right now") keeps each submission stable to the sheet set
      // that was actually packaged and sent to the jurisdiction,
      // even after later snapshots land on the same engagement (SD-5).
      // When the submission atom grows a direct `snapshotId` column
      // this can switch to an exact lookup without changing the wire
      // shape.
      let snapRows = await db
        .select({ id: snapshots.id })
        .from(snapshots)
        .where(
          and(
            eq(snapshots.engagementId, sub.engagementId),
            lte(snapshots.receivedAt, sub.submittedAt),
          ),
        )
        .orderBy(desc(snapshots.receivedAt))
        .limit(1);
      // Fallback: a submission may pre-date its only snapshot in
      // legacy data (the `engagement.submitted` event was appended
      // before any snapshot was ingested). Surface the engagement's
      // earliest snapshot in that case so the rail isn't empty for
      // historical rows.
      if (snapRows.length === 0) {
        snapRows = await db
          .select({ id: snapshots.id })
          .from(snapshots)
          .where(eq(snapshots.engagementId, sub.engagementId))
          .orderBy(asc(snapshots.receivedAt))
          .limit(1);
      }
      const latest = snapRows[0];
      if (!latest) {
        res.json([]);
        return;
      }

      const rows = await db
        .select({
          id: sheets.id,
          snapshotId: sheets.snapshotId,
          engagementId: sheets.engagementId,
          sheetNumber: sheets.sheetNumber,
          sheetName: sheets.sheetName,
          viewCount: sheets.viewCount,
          revisionNumber: sheets.revisionNumber,
          revisionDate: sheets.revisionDate,
          thumbnailWidth: sheets.thumbnailWidth,
          thumbnailHeight: sheets.thumbnailHeight,
          fullWidth: sheets.fullWidth,
          fullHeight: sheets.fullHeight,
          sortOrder: sheets.sortOrder,
          contentBody: sheets.contentBody,
          createdAt: sheets.createdAt,
        })
        .from(sheets)
        .where(eq(sheets.snapshotId, latest.id))
        .orderBy(asc(sheets.sortOrder));

      res.json(
        rows.map((r) => ({
          ...r,
          createdAt: r.createdAt.toISOString(),
          crossRefs: extractSheetCrossRefs(r.contentBody ?? ""),
        })),
      );
    } catch (err) {
      logger.error({ err, submissionId }, "list submission sheets failed");
      res.status(500).json({ error: "Failed to list submission sheets" });
    }
  },
);

router.get("/sheets/:id/thumbnail.png", (req, res) =>
  serveSheetPng(req, res, "thumbnailPng"),
);
router.get("/sheets/:id/full.png", (req, res) =>
  serveSheetPng(req, res, "fullPng"),
);

export default router;
