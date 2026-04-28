/**
 * Warmup orchestrator.
 *
 * Fired (best-effort) when a snapshot's geocode resolves a jurisdiction we
 * recognize. Two phases:
 *
 *   1. enqueueWarmupForJurisdiction(key)
 *        - For each configured book in the jurisdiction:
 *          - Look up the source row, instantiate the adapter via
 *            @workspace/codes-sources getSource().
 *          - Call adapter.listToc() to get TOC entries.
 *          - INSERT each entry into code_atom_fetch_queue (status=pending,
 *            ON CONFLICT DO NOTHING — we dedupe on (source_id, section_url)).
 *
 *   2. drainQueue() (the queue worker, runs in a setInterval at boot)
 *        - SELECT a small batch of pending rows whose next_attempt_at <= now()
 *        - For each: call adapter.fetchSection(url, ctx) → AtomCandidates
 *        - Embed each AtomCandidate.body via embedTexts()
 *        - UPSERT into code_atoms (dedupe on content_hash)
 *        - Mark the queue row completed; on error, increment attempts and
 *          exponentially back off next_attempt_at (1m → 5m → 30m → 2h cap).
 *
 * The queue is the single source of truth for "what work do we owe this
 * jurisdiction" — that lets us crash and resume safely.
 */

import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  codeAtomSources,
  codeAtoms,
  codeAtomFetchQueue,
  type NewCodeAtom,
} from "@workspace/db";
import {
  getSource,
  type AtomCandidate,
  type CodeSource,
  type FetchContext,
} from "@workspace/codes-sources";
import {
  getJurisdiction,
  type CodeBookConfig,
  type JurisdictionConfig,
} from "./jurisdictions";
import { embedTexts, EMBEDDING_MODEL } from "./embeddings";

export interface OrchestratorLogger {
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
  error: (obj: unknown, msg: string) => void;
  debug?: (obj: unknown, msg: string) => void;
}

const consoleLogger: OrchestratorLogger = {
  info: (obj, msg) => console.log(msg, obj),
  warn: (obj, msg) => console.warn(msg, obj),
  error: (obj, msg) => console.error(msg, obj),
};

function contentHash(parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0001")).digest("hex");
}

interface SourceRow {
  id: string;
  sourceName: string;
}

async function loadSourceRow(sourceName: string): Promise<SourceRow | null> {
  const rows = await db
    .select({ id: codeAtomSources.id, sourceName: codeAtomSources.sourceName })
    .from(codeAtomSources)
    .where(eq(codeAtomSources.sourceName, sourceName))
    .limit(1);
  const row = rows[0];
  return row ? { id: row.id, sourceName: row.sourceName } : null;
}

export interface EnqueueResult {
  jurisdictionKey: string;
  enqueued: number;
  skipped: number;
  perBook: Array<{
    sourceName: string;
    enqueued: number;
    skipped: number;
    error?: string;
  }>;
}

/**
 * Discovery phase. Walks each book's TOC and inserts queue rows. Re-runnable
 * — duplicates are silently ignored via the (source_id, section_url) unique
 * index.
 */
export async function enqueueWarmupForJurisdiction(
  jurisdictionKey: string,
  log: OrchestratorLogger = consoleLogger,
): Promise<EnqueueResult> {
  const jurisdiction = getJurisdiction(jurisdictionKey);
  if (!jurisdiction) {
    log.warn({ jurisdictionKey }, "warmup: unknown jurisdiction key, skipping");
    return { jurisdictionKey, enqueued: 0, skipped: 0, perBook: [] };
  }

  const perBook: EnqueueResult["perBook"] = [];
  let totalEnq = 0;
  let totalSkip = 0;

  for (const book of jurisdiction.books) {
    const sourceRow = await loadSourceRow(book.sourceName);
    if (!sourceRow) {
      log.error(
        { sourceName: book.sourceName },
        "warmup: missing code_atom_sources row — did the seed run?",
      );
      perBook.push({
        sourceName: book.sourceName,
        enqueued: 0,
        skipped: 0,
        error: "source_row_missing",
      });
      continue;
    }
    const adapter = getSource(book.sourceName);
    if (!adapter) {
      log.error(
        { sourceName: book.sourceName },
        "warmup: no adapter registered for source",
      );
      perBook.push({
        sourceName: book.sourceName,
        enqueued: 0,
        skipped: 0,
        error: "no_adapter",
      });
      continue;
    }

    let toc;
    try {
      toc = await adapter.listToc({
        jurisdictionKey,
        codeBook: book.codeBook,
        edition: book.edition,
        config: book.config,
      });
    } catch (err) {
      log.error(
        { err, sourceName: book.sourceName, jurisdictionKey },
        "warmup: listToc failed",
      );
      perBook.push({
        sourceName: book.sourceName,
        enqueued: 0,
        skipped: 0,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    let enq = 0;
    let skip = 0;
    for (const entry of toc) {
      try {
        const inserted = await db
          .insert(codeAtomFetchQueue)
          .values({
            sourceId: sourceRow.id,
            jurisdictionKey,
            codeBook: book.codeBook,
            edition: book.edition,
            sectionUrl: entry.sectionUrl,
            sectionRef: entry.sectionRef,
            context: entry.context ?? null,
            status: "pending",
            nextAttemptAt: new Date(),
          })
          .onConflictDoNothing({
            target: [codeAtomFetchQueue.sourceId, codeAtomFetchQueue.sectionUrl],
          })
          .returning({ id: codeAtomFetchQueue.id });
        if (inserted.length > 0) enq++;
        else skip++;
      } catch (err) {
        log.warn({ err, entry: entry.sectionUrl }, "warmup: enqueue failed");
        skip++;
      }
    }
    totalEnq += enq;
    totalSkip += skip;
    perBook.push({ sourceName: book.sourceName, enqueued: enq, skipped: skip });
    log.info(
      { sourceName: book.sourceName, enqueued: enq, skipped: skip, jurisdictionKey },
      "warmup: enqueued TOC entries",
    );
  }

  return { jurisdictionKey, enqueued: totalEnq, skipped: totalSkip, perBook };
}

interface QueueRow {
  id: string;
  sourceId: string;
  sourceName: string;
  jurisdictionKey: string;
  codeBook: string;
  edition: string;
  sectionUrl: string;
  sectionRef: string | null;
  context: unknown;
  attempts: number;
}

export interface DrainResult {
  picked: number;
  completed: number;
  failed: number;
  atomsWritten: number;
}

/** How long a claimed row may stay in_progress before the reaper requeues it. */
const LEASE_DURATION_MS = 5 * 60 * 1000;

/**
 * Crash-safety reaper. Returns any in_progress rows whose lease has elapsed
 * (or whose lease was never set, e.g. claimed by an older build) back to
 * pending so they can be re-claimed. Without this, a process kill mid-fetch
 * would orphan rows forever (the (source_id, section_url) unique index
 * prevents re-enqueue).
 */
async function reapStaleLeases(log: OrchestratorLogger): Promise<number> {
  const res = await db.execute<{ id: string }>(sql`
    UPDATE code_atom_fetch_queue
    SET status = 'pending',
        lease_expires_at = NULL
    WHERE status = 'in_progress'
      AND (lease_expires_at IS NULL OR lease_expires_at <= now())
    RETURNING id
  `);
  const count = res.rows?.length ?? 0;
  if (count > 0) {
    log.warn({ count }, "warmup: requeued stale in_progress leases");
  }
  return count;
}

/**
 * Process up to `batchSize` pending queue rows. Intended to be invoked by a
 * setInterval-driven worker; safe to call concurrently because each row is
 * claimed via UPDATE … RETURNING with a lease.
 *
 * If `jurisdictionKey` is provided, only rows for that jurisdiction are
 * claimed — used by the synchronous warmup endpoint so callers see progress
 * for the jurisdiction they asked about, not unrelated backlog.
 */
export async function drainQueue(
  log: OrchestratorLogger = consoleLogger,
  batchSize = 5,
  jurisdictionKey?: string,
): Promise<DrainResult> {
  // First reap stale leases so crashed-mid-fetch rows can be retried.
  await reapStaleLeases(log);

  const leaseUntil = new Date(Date.now() + LEASE_DURATION_MS);
  const jurisdictionFilter = jurisdictionKey
    ? sql`AND q.jurisdiction_key = ${jurisdictionKey}`
    : sql``;

  // Atomically claim up to N rows. We set status='in_progress' AND
  // lease_expires_at so the reaper can rescue us if we crash.
  const claimed = await db.execute<{
    id: string;
    source_id: string;
    source_name: string;
    jurisdiction_key: string;
    code_book: string;
    edition: string;
    section_url: string;
    section_ref: string | null;
    context: unknown;
    attempts: number;
  }>(sql`
    WITH next_ids AS (
      SELECT q.id
      FROM code_atom_fetch_queue q
      WHERE q.status = 'pending'
        AND q.next_attempt_at <= now()
        ${jurisdictionFilter}
      ORDER BY q.next_attempt_at ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE code_atom_fetch_queue q
    SET status = 'in_progress',
        lease_expires_at = ${leaseUntil}
    FROM next_ids
    JOIN code_atom_sources s ON s.id = (
      SELECT q2.source_id FROM code_atom_fetch_queue q2 WHERE q2.id = next_ids.id
    )
    WHERE q.id = next_ids.id
    RETURNING q.id, q.source_id, s.source_name,
              q.jurisdiction_key, q.code_book, q.edition,
              q.section_url, q.section_ref, q.context, q.attempts
  `);

  const rows = (claimed.rows ?? []) as Array<{
    id: string;
    source_id: string;
    source_name: string;
    jurisdiction_key: string;
    code_book: string;
    edition: string;
    section_url: string;
    section_ref: string | null;
    context: unknown;
    attempts: number;
  }>;

  if (rows.length === 0) return { picked: 0, completed: 0, failed: 0, atomsWritten: 0 };

  let completed = 0;
  let failed = 0;
  let atomsWritten = 0;

  for (const r of rows) {
    const queueRow: QueueRow = {
      id: r.id,
      sourceId: r.source_id,
      sourceName: r.source_name,
      jurisdictionKey: r.jurisdiction_key,
      codeBook: r.code_book,
      edition: r.edition,
      sectionUrl: r.section_url,
      sectionRef: r.section_ref,
      context: r.context,
      attempts: r.attempts,
    };

    const adapter = getSource(queueRow.sourceName);
    if (!adapter) {
      await markFailed(queueRow, "no_adapter", log);
      failed++;
      continue;
    }

    try {
      const written = await processQueueRow(adapter, queueRow, log);
      atomsWritten += written;
      await db
        .update(codeAtomFetchQueue)
        .set({
          status: "completed",
          completedAt: new Date(),
          leaseExpiresAt: null,
        })
        .where(eq(codeAtomFetchQueue.id, queueRow.id));
      completed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(
        { err, sectionUrl: queueRow.sectionUrl, sourceName: queueRow.sourceName },
        "warmup: fetchSection failed",
      );
      await markFailed(queueRow, msg, log);
      failed++;
    }
  }

  return { picked: rows.length, completed, failed, atomsWritten };
}

async function processQueueRow(
  adapter: CodeSource,
  queueRow: QueueRow,
  log: OrchestratorLogger,
): Promise<number> {
  const ctx: FetchContext = {
    jurisdictionKey: queueRow.jurisdictionKey,
    codeBook: queueRow.codeBook,
    edition: queueRow.edition,
    context:
      queueRow.context && typeof queueRow.context === "object"
        ? (queueRow.context as Record<string, unknown>)
        : undefined,
  };
  const candidates = await adapter.fetchSection(queueRow.sectionUrl, ctx);
  if (candidates.length === 0) return 0;

  const embedRes = await embedTexts(candidates.map((c) => c.body), { logger: log });
  const now = new Date();
  let written = 0;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const vec = embedRes.vectors[i];
    const hash = contentHash([
      queueRow.jurisdictionKey,
      queueRow.codeBook,
      queueRow.edition,
      c.sectionRef ?? "",
      c.body,
    ]);
    const row: NewCodeAtom = {
      sourceId: queueRow.sourceId,
      jurisdictionKey: queueRow.jurisdictionKey,
      codeBook: queueRow.codeBook,
      edition: queueRow.edition,
      sectionNumber: c.sectionRef,
      sectionTitle: c.sectionTitle,
      parentSection: c.parentSection ?? null,
      body: c.body,
      bodyHtml: c.bodyHtml ?? null,
      embedding: vec ?? null,
      embeddingModel: vec ? EMBEDDING_MODEL : null,
      embeddedAt: vec ? now : null,
      contentHash: hash,
      sourceUrl: c.sourceUrl,
      fetchedAt: now,
      metadata: c.metadata ?? null,
    };
    try {
      const ins = await db
        .insert(codeAtoms)
        .values(row)
        .onConflictDoNothing({ target: codeAtoms.contentHash })
        .returning({ id: codeAtoms.id });
      if (ins.length > 0) written++;
    } catch (err) {
      log.warn(
        { err, sectionRef: c.sectionRef, jurisdictionKey: queueRow.jurisdictionKey },
        "warmup: atom upsert failed",
      );
    }
  }
  log.info(
    {
      sourceName: queueRow.sourceName,
      sectionUrl: queueRow.sectionUrl,
      candidates: candidates.length,
      written,
      embeddedAny: embedRes.embeddedAny,
      skipReason: embedRes.skipReason,
    },
    "warmup: section processed",
  );
  return written;
}

async function markFailed(
  queueRow: QueueRow,
  error: string,
  _log: OrchestratorLogger,
): Promise<void> {
  const attempts = queueRow.attempts + 1;
  // Exponential backoff: 1m, 5m, 30m, 2h cap.
  const ladder = [60, 5 * 60, 30 * 60, 2 * 60 * 60];
  const delaySec = ladder[Math.min(attempts - 1, ladder.length - 1)];
  const next = new Date(Date.now() + delaySec * 1000);
  // After 5 failures, park as "failed" so it doesn't keep retrying forever.
  const status = attempts >= 5 ? "failed" : "pending";
  await db
    .update(codeAtomFetchQueue)
    .set({
      status,
      attempts,
      lastError: error.slice(0, 1000),
      nextAttemptAt: next,
      leaseExpiresAt: null,
    })
    .where(eq(codeAtomFetchQueue.id, queueRow.id));
}

/**
 * Convenience: enqueue + drain in one call. Use sparingly — the production
 * path is enqueue (sync, fast) + background drain (slow, polite).
 */
export async function runWarmupForJurisdiction(
  jurisdictionKey: string,
  log: OrchestratorLogger = consoleLogger,
): Promise<{ enqueue: EnqueueResult; drain: DrainResult }> {
  const enqueue = await enqueueWarmupForJurisdiction(jurisdictionKey, log);
  const drain = await drainQueue(log, 100, jurisdictionKey);
  return { enqueue, drain };
}

export type { JurisdictionConfig, CodeBookConfig };
