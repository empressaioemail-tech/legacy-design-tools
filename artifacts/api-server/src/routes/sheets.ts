import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { createHash } from "node:crypto";
import Busboy from "busboy";
import { db, snapshots, sheets } from "@workspace/db";
import { eq, sql, asc } from "drizzle-orm";
import { logger } from "../lib/logger";
import { getSnapshotSecret } from "../lib/snapshotSecret";

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

    let snapRows;
    try {
      snapRows = await db
        .select({ id: snapshots.id, engagementId: snapshots.engagementId })
        .from(snapshots)
        .where(eq(snapshots.id, snapshotId))
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
          snapshotId,
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
        });
      }

      // Each upsert runs as its own statement (no enclosing transaction),
      // so a single failed row cannot poison the rest. Postgres aborts a
      // transaction on the first statement error, which made the
      // per-row try/catch inside `db.transaction` ineffective for
      // partial-success semantics.
      for (const row of rowsToInsert) {
        try {
          await db
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
              },
            });
          uploaded++;
        } catch (err) {
          failed++;
          errors.push(
            `db insert failed for sheet ${row.sheetNumber}: ${err instanceof Error ? err.message : String(err)}`,
          );
          logger.warn(
            { err, snapshotId, sheetNumber: row.sheetNumber },
            "sheet insert failed",
          );
        }
      }

      // Recompute snapshot.sheetCount from the canonical sheets table so the
      // engagement detail KPI line stays in sync — runs whether or not
      // every row succeeded.
      try {
        await db
          .update(snapshots)
          .set({
            sheetCount: sql<number>`(select cast(count(*) as int) from ${sheets} where ${sheets.snapshotId} = ${snapshotId})`,
          })
          .where(eq(snapshots.id, snapshotId));
      } catch (err) {
        logger.error(
          { err, snapshotId },
          "failed to recompute sheetCount after upload",
        );
        errors.push("warning: sheetCount recompute failed");
      }

      safeRespond(200, { uploaded, skipped, failed, errors });
    });

    req.pipe(busboy);
  },
);

router.get(
  "/snapshots/:snapshotId/sheets",
  async (req: Request, res: Response) => {
    const snapshotId = req.params["snapshotId"];
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
          createdAt: sheets.createdAt,
        })
        .from(sheets)
        .where(eq(sheets.snapshotId, snapshotId))
        .orderBy(asc(sheets.sortOrder));

      res.json(
        rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
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
  const id = req.params["id"];
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

router.get("/sheets/:id/thumbnail.png", (req, res) =>
  serveSheetPng(req, res, "thumbnailPng"),
);
router.get("/sheets/:id/full.png", (req, res) =>
  serveSheetPng(req, res, "fullPng"),
);

export default router;
