/**
 * /api/codes/* — atom-anchored municipal/building code knowledge.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { db, codeAtoms, codeAtomSources, codeAtomFetchQueue } from "@workspace/db";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { embedTexts, EMBEDDING_MODEL } from "@workspace/codes";
import {
  enqueueWarmupForJurisdiction,
  drainQueue,
  getJurisdiction,
  listJurisdictions,
} from "@workspace/codes";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ----------------------- helpers ---------------------------------------------

function previewBody(s: string, max = 240): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? collapsed.slice(0, max - 1) + "…" : collapsed;
}

interface BookCount {
  codeBook: string;
  edition: string;
  count: number;
}

async function jurisdictionAtomCounts(
  jurisdictionKey: string,
): Promise<{
  total: number;
  embedded: number;
  lastFetchedAt: string | null;
  byBook: Map<string, BookCount>;
}> {
  const rows = await db
    .select({
      codeBook: codeAtoms.codeBook,
      edition: codeAtoms.edition,
      count: sql<number>`count(*)::int`,
      embedded: sql<number>`count(*) FILTER (WHERE ${codeAtoms.embedding} IS NOT NULL)::int`,
      lastFetchedAt: sql<string | null>`max(${codeAtoms.fetchedAt})`,
    })
    .from(codeAtoms)
    .where(eq(codeAtoms.jurisdictionKey, jurisdictionKey))
    .groupBy(codeAtoms.codeBook, codeAtoms.edition);

  const byBook = new Map<string, BookCount>();
  let total = 0;
  let embedded = 0;
  let last: string | null = null;
  for (const r of rows) {
    total += Number(r.count);
    embedded += Number(r.embedded);
    const lf = r.lastFetchedAt
      ? new Date(r.lastFetchedAt as unknown as string).toISOString()
      : null;
    if (lf && (!last || lf > last)) last = lf;
    byBook.set(`${r.codeBook}|${r.edition}`, {
      codeBook: r.codeBook,
      edition: r.edition,
      count: Number(r.count),
    });
  }
  return { total, embedded, lastFetchedAt: last, byBook };
}

// ----------------------- routes ----------------------------------------------

router.get(
  "/codes/jurisdictions",
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const out = [];
      for (const j of listJurisdictions()) {
        const counts = await jurisdictionAtomCounts(j.key);
        out.push({
          key: j.key,
          displayName: j.displayName,
          atomCount: counts.total,
          embeddedCount: counts.embedded,
          lastFetchedAt: counts.lastFetchedAt,
          books: j.books.map((b) => {
            const bc = counts.byBook.get(`${b.codeBook}|${b.edition}`);
            return {
              codeBook: b.codeBook,
              edition: b.edition,
              label: b.label,
              sourceName: b.sourceName,
              atomCount: bc ? bc.count : 0,
            };
          }),
        });
      }
      res.json(out);
    } catch (err) {
      logger.error({ err }, "list jurisdictions failed");
      res.status(500).json({ error: "Failed to list jurisdictions" });
    }
  },
);

router.get(
  "/codes/jurisdictions/:key/atoms",
  async (req: Request, res: Response): Promise<void> => {
    const key = String(req.params.key ?? "");
    if (!getJurisdiction(key)) {
      res.status(404).json({ error: "Unknown jurisdiction" });
      return;
    }
    const limitRaw = Number(req.query.limit ?? 50);
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(200, Math.floor(limitRaw)))
      : 50;
    // Optional book filter: codeBook (and optionally edition) narrow the
    // response to a single book for the "click a book pill to browse it"
    // flow. We accept codeBook on its own (Bastrop has only one edition per
    // book today) but require codeBook to use edition.
    const codeBookFilter = req.query.codeBook
      ? String(req.query.codeBook)
      : null;
    const editionFilter = req.query.edition ? String(req.query.edition) : null;
    try {
      const conditions = [eq(codeAtoms.jurisdictionKey, key)];
      if (codeBookFilter) conditions.push(eq(codeAtoms.codeBook, codeBookFilter));
      if (codeBookFilter && editionFilter)
        conditions.push(eq(codeAtoms.edition, editionFilter));
      const rows = await db
        .select({
          id: codeAtoms.id,
          jurisdictionKey: codeAtoms.jurisdictionKey,
          codeBook: codeAtoms.codeBook,
          edition: codeAtoms.edition,
          sectionNumber: codeAtoms.sectionNumber,
          sectionTitle: codeAtoms.sectionTitle,
          sourceUrl: codeAtoms.sourceUrl,
          embedding: codeAtoms.embedding,
          fetchedAt: codeAtoms.fetchedAt,
          body: codeAtoms.body,
          sourceName: codeAtomSources.sourceName,
        })
        .from(codeAtoms)
        .innerJoin(codeAtomSources, eq(codeAtomSources.id, codeAtoms.sourceId))
        .where(and(...conditions))
        .orderBy(desc(codeAtoms.fetchedAt))
        .limit(limit);
      res.json(
        rows.map((r) => ({
          id: r.id,
          jurisdictionKey: r.jurisdictionKey,
          codeBook: r.codeBook,
          edition: r.edition,
          sectionNumber: r.sectionNumber,
          sectionTitle: r.sectionTitle,
          sourceName: r.sourceName,
          sourceUrl: r.sourceUrl,
          embedded: r.embedding !== null,
          fetchedAt: r.fetchedAt.toISOString(),
          bodyPreview: previewBody(r.body),
        })),
      );
    } catch (err) {
      logger.error({ err, key }, "list jurisdiction atoms failed");
      res.status(500).json({ error: "Failed to list atoms" });
    }
  },
);

router.get(
  "/codes/atoms/:id",
  async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params.id ?? "");
    try {
      const rows = await db
        .select({
          id: codeAtoms.id,
          jurisdictionKey: codeAtoms.jurisdictionKey,
          codeBook: codeAtoms.codeBook,
          edition: codeAtoms.edition,
          sectionNumber: codeAtoms.sectionNumber,
          sectionTitle: codeAtoms.sectionTitle,
          parentSection: codeAtoms.parentSection,
          body: codeAtoms.body,
          bodyHtml: codeAtoms.bodyHtml,
          sourceUrl: codeAtoms.sourceUrl,
          embedding: codeAtoms.embedding,
          embeddingModel: codeAtoms.embeddingModel,
          fetchedAt: codeAtoms.fetchedAt,
          metadata: codeAtoms.metadata,
          sourceName: codeAtomSources.sourceName,
        })
        .from(codeAtoms)
        .innerJoin(codeAtomSources, eq(codeAtomSources.id, codeAtoms.sourceId))
        .where(eq(codeAtoms.id, id))
        .limit(1);
      const r = rows[0];
      if (!r) {
        res.status(404).json({ error: "Atom not found" });
        return;
      }
      res.json({
        id: r.id,
        jurisdictionKey: r.jurisdictionKey,
        codeBook: r.codeBook,
        edition: r.edition,
        sectionNumber: r.sectionNumber,
        sectionTitle: r.sectionTitle,
        sourceName: r.sourceName,
        sourceUrl: r.sourceUrl,
        embedded: r.embedding !== null,
        fetchedAt: r.fetchedAt.toISOString(),
        bodyPreview: previewBody(r.body),
        body: r.body,
        bodyHtml: r.bodyHtml,
        parentSection: r.parentSection,
        embeddingModel: r.embeddingModel,
        metadata: (r.metadata as Record<string, unknown>) ?? null,
      });
    } catch (err) {
      logger.error({ err, id }, "get atom failed");
      res.status(500).json({ error: "Failed to load atom" });
    }
  },
);

/**
 * Live warmup queue state for a jurisdiction. Used by the Code Library UI to
 * poll progress while "Warm up now" is running and to surface failure detail
 * inline (without requiring server-log access).
 *
 * The DB column `status` uses `in_progress`; the API surface re-labels that
 * bucket as `processing` for clarity. `lastError` carries the most recent
 * failed-row text (orchestrator truncates to 1000 chars at write time).
 */
router.get(
  "/codes/warmup-status/:key",
  async (req: Request, res: Response): Promise<void> => {
    const key = String(req.params.key ?? "");
    if (!getJurisdiction(key)) {
      res.status(404).json({ error: "Unknown jurisdiction" });
      return;
    }
    try {
      // One pass aggregating by status, plus the earliest createdAt and
      // latest completedAt across all rows. The most recent failed-row
      // lastError is fetched as a tiny separate query so we can surface the
      // text even when the row is the only failed one in the set.
      const aggRows = await db
        .select({
          status: codeAtomFetchQueue.status,
          count: sql<number>`count(*)::int`,
          minCreated: sql<string | null>`min(${codeAtomFetchQueue.createdAt})`,
          maxCompleted: sql<string | null>`max(${codeAtomFetchQueue.completedAt})`,
        })
        .from(codeAtomFetchQueue)
        .where(eq(codeAtomFetchQueue.jurisdictionKey, key))
        .groupBy(codeAtomFetchQueue.status);

      let pending = 0;
      let processing = 0;
      let completed = 0;
      let failed = 0;
      let startedAt: string | null = null;
      let completedAt: string | null = null;
      for (const r of aggRows) {
        const c = Number(r.count);
        if (r.status === "pending") pending = c;
        else if (r.status === "in_progress") processing = c;
        else if (r.status === "completed") completed = c;
        else if (r.status === "failed") failed = c;
        const minC = r.minCreated
          ? new Date(r.minCreated as unknown as string).toISOString()
          : null;
        if (minC && (!startedAt || minC < startedAt)) startedAt = minC;
        const maxC = r.maxCompleted
          ? new Date(r.maxCompleted as unknown as string).toISOString()
          : null;
        if (maxC && (!completedAt || maxC > completedAt)) completedAt = maxC;
      }
      const total = pending + processing + completed + failed;

      // Most recent failed row's lastError. We only surface it when there's
      // at least one failed row in the bucket — otherwise null. This matches
      // what the spec calls out: "warmup did nothing" should be debuggable
      // from the browser without log access.
      let lastError: string | null = null;
      if (failed > 0) {
        const failedRows = await db
          .select({ lastError: codeAtomFetchQueue.lastError })
          .from(codeAtomFetchQueue)
          .where(
            and(
              eq(codeAtomFetchQueue.jurisdictionKey, key),
              eq(codeAtomFetchQueue.status, "failed"),
              isNotNull(codeAtomFetchQueue.lastError),
            ),
          )
          .orderBy(desc(codeAtomFetchQueue.createdAt))
          .limit(1);
        lastError = failedRows[0]?.lastError ?? null;
      }

      // Derive state. Order matters:
      //   - empty queue → idle (nothing has ever been enqueued)
      //   - any pending or processing → running
      //   - else if any failed → failed (terminal-with-failures)
      //   - else → completed
      let state: "idle" | "running" | "completed" | "failed";
      if (total === 0) state = "idle";
      else if (pending > 0 || processing > 0) state = "running";
      else if (failed > 0) state = "failed";
      else state = "completed";

      // For an empty queue, startedAt/completedAt have no meaning.
      if (total === 0) {
        startedAt = null;
        completedAt = null;
      }
      // For a still-running queue, completedAt is misleading (it's the
      // latest among already-completed rows, not the whole batch). Suppress.
      if (state === "running") completedAt = null;

      res.json({
        jurisdictionKey: key,
        state,
        pending,
        processing,
        completed,
        failed,
        total,
        startedAt,
        completedAt,
        lastError,
      });
    } catch (err) {
      logger.error({ err, key }, "warmup-status failed");
      res.status(500).json({ error: "Failed to read warmup status" });
    }
  },
);

router.post(
  "/codes/warmup/:key",
  async (req: Request, res: Response): Promise<void> => {
    const key = String(req.params.key ?? "");
    if (!getJurisdiction(key)) {
      res.status(404).json({ error: "Unknown jurisdiction" });
      return;
    }
    try {
      const enqueue = await enqueueWarmupForJurisdiction(key, logger);
      // Drain a small synchronous batch so the caller sees real progress;
      // background worker handles the rest.
      const drain = await drainQueue(logger, 3);
      // Surface per-book discovery failures so the UI can debug
      // "warmup did nothing" without server-log access. The orchestrator
      // already collects these but the previous response shape dropped them.
      const discoveryErrors = enqueue.perBook
        .filter((b) => b.error)
        .map((b) => ({ sourceName: b.sourceName, error: String(b.error) }));
      res.json({
        jurisdictionKey: key,
        enqueued: enqueue.enqueued,
        skipped: enqueue.skipped,
        drained: drain,
        discoveryErrors,
      });
    } catch (err) {
      logger.error({ err, key }, "warmup failed");
      res.status(500).json({ error: "Warmup failed" });
    }
  },
);

/**
 * One-shot backfill: embed any atoms still missing a vector. Useful after
 * provisioning OPENAI_API_KEY for the first time. Safe to call repeatedly —
 * it's bounded by `?limit=` (default 200, hard cap 1000) and only touches
 * atoms where embedding IS NULL.
 */
router.post(
  "/codes/embeddings/backfill",
  async (req: Request, res: Response): Promise<void> => {
    const limit = Math.min(
      Math.max(Number(req.query.limit ?? 200) || 200, 1),
      1000,
    );
    try {
      const pending = await db
        .select({ id: codeAtoms.id, body: codeAtoms.body })
        .from(codeAtoms)
        .where(isNull(codeAtoms.embedding))
        .limit(limit);

      if (pending.length === 0) {
        res.json({ scanned: 0, embedded: 0, failed: 0, remaining: 0 });
        return;
      }

      // Embed in chunks of 64 (well under any per-request token cap).
      const CHUNK = 64;
      let embedded = 0;
      let failed = 0;
      for (let i = 0; i < pending.length; i += CHUNK) {
        const slice = pending.slice(i, i + CHUNK);
        const result = await embedTexts(
          slice.map((r) => r.body),
          { logger },
        );
        if (!result.embeddedAny) {
          failed += slice.length;
          // Bail early if it's a config issue — no point hammering.
          if (result.skipReason === "no_api_key") break;
          continue;
        }
        const now = new Date();
        for (let j = 0; j < slice.length; j++) {
          const vec = result.vectors[j];
          if (!vec) {
            failed++;
            continue;
          }
          await db
            .update(codeAtoms)
            .set({
              embedding: vec,
              embeddingModel: EMBEDDING_MODEL,
              embeddedAt: now,
            })
            .where(eq(codeAtoms.id, slice[j].id));
          embedded++;
        }
      }

      const remainingRows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(codeAtoms)
        .where(isNull(codeAtoms.embedding));
      res.json({
        scanned: pending.length,
        embedded,
        failed,
        remaining: Number(remainingRows[0]?.n ?? 0),
      });
    } catch (err) {
      logger.error({ err }, "embeddings backfill failed");
      res.status(500).json({ error: "Backfill failed" });
    }
  },
);

export default router;
// silence "noUnused": and is used as part of import-side-effects elsewhere
void and;
void isNotNull;
