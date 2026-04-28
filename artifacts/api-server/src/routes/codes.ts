/**
 * /api/codes/* — atom-anchored municipal/building code knowledge.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { db, codeAtoms, codeAtomSources } from "@workspace/db";
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
    try {
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
        .where(eq(codeAtoms.jurisdictionKey, key))
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
      res.json({
        jurisdictionKey: key,
        enqueued: enqueue.enqueued,
        skipped: enqueue.skipped,
        drained: drain,
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
