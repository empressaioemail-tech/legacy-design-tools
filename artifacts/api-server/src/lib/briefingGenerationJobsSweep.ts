/**
 * Periodic sweep that prunes old terminal `briefing_generation_jobs`
 * rows so the table stays bounded.
 *
 * Why this exists: every architect-driven briefing-generate kickoff
 * (DA-PI-3) inserts a row, but the status endpoint only ever reads
 * the most recent row per engagement. Without a sweep the table grows
 * one row per attempt forever — the schema doc on
 * `briefingGenerationJobs.ts` calls out this future-pruning task.
 *
 * Retention contract (mirrored by `pruneOldBriefingGenerationJobs`):
 *   - `pending` rows are NEVER deleted. The partial unique index
 *     already guarantees at most one in-flight row per engagement,
 *     and an in-flight kickoff's row is load-bearing for the status
 *     endpoint and the single-flight 409 path. They DO count toward
 *     the per-engagement keep cap (a pending row IS one of the most
 *     recent runs from the auditor's perspective).
 *   - The most recent N rows per engagement are ALWAYS kept regardless
 *     of age (default N = 5, overridable via
 *     `BRIEFING_GENERATION_JOB_KEEP_PER_ENGAGEMENT`). Auditors
 *     investigating a regression typically want to compare the last
 *     few attempts ("the run before the bad one"), so trimming all
 *     the way down to 1 made the table audit-hostile. Keeping N still
 *     bounds growth — every new run pushes the (N+1)th out of the
 *     retention window's protection.
 *   - Every other terminal row (`completed` / `failed`) older than
 *     the retention window AND with at least N newer rows for the
 *     same engagement is deleted.
 *
 * Boot at api-server startup with `startBriefingGenerationJobsSweep(log)`.
 * The sweep runs once on boot (delayed so it doesn't pile onto the
 * atom-registry / migration / queue-worker boot work) and then every
 * `BRIEFING_GENERATION_JOB_SWEEP_INTERVAL_MS` afterward (default 24h).
 *
 * Notes:
 *   - One sweeper per process; calling start twice is a no-op + warn,
 *     same shape as `startQueueWorker` in `lib/codes/src/queue.ts`.
 *   - Ticks never throw out of the handler — failures are logged and
 *     we wait for the next tick. A transient DB blip cannot crash
 *     the api-server.
 *   - `stopBriefingGenerationJobsSweep` is exposed for tests and
 *     graceful-shutdown wiring; the production process relies on
 *     `unref()` so the timer does not keep Node alive on SIGTERM.
 */

import { sql } from "drizzle-orm";
import { db, briefingGenerationJobs } from "@workspace/db";
import type { Logger } from "pino";

/** Default retention: 30 days. Overridable via env at boot. */
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Default interval: daily. Overridable via env at boot. */
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * Default per-engagement keep cap: the most recent 5 rows per
 * engagement are protected regardless of age. Auditors comparing a
 * regression want a short window of recent attempts, not just the
 * single latest one. Overridable via env at boot.
 */
const DEFAULT_KEEP_PER_ENGAGEMENT = 5;
/**
 * Default boot delay: 60s. Lets the api-server settle (atom-registry
 * bootstrap, schema validation, first request) before the sweep's
 * DELETE acquires row locks.
 */
const DEFAULT_BOOT_DELAY_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let bootTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;

export interface PruneOptions {
  /**
   * Override the database handle. Defaults to the shared `db`
   * singleton. Tests pass their per-suite schema's drizzle client so
   * the DELETE lands in the test schema instead of the dev DB.
   */
  db?: typeof db;
  /** Retention window in milliseconds. Defaults to 30 days. */
  retentionMs?: number;
  /**
   * Reference "now" for cutoff math. Defaults to `new Date()`. Pinning
   * this in tests makes the kept-vs-deleted boundary deterministic.
   */
  now?: Date;
  /**
   * Number of most-recent rows per engagement to preserve regardless
   * of age. Defaults to 5. Must be >= 1 — the latest row per
   * engagement is load-bearing for `GET /briefing/status` and is
   * never reaped. Pending rows count toward this cap.
   */
  keepPerEngagement?: number;
}

/**
 * Delete every `briefing_generation_jobs` row that is:
 *   1. in a terminal state (`completed` or `failed`),
 *   2. started before `now - retentionMs`, AND
 *   3. has at least `keepPerEngagement` newer rows (any state) for
 *      the same engagement.
 *
 * Returns the number of rows actually deleted (zero if the table is
 * already trimmed). Pending rows are excluded by clause (1) regardless
 * of age, so an in-flight kickoff is never pruned. Pending rows DO
 * count as "newer rows" in clause (3), so a freshly kicked-off run
 * still protects the auditor's recent-attempts window.
 *
 * The "N newer rows exist" predicate is what protects the audit
 * story: the most recent N rows per engagement (default 5) stay even
 * if they're ancient, so auditors comparing a regression always have
 * a few recent attempts on record. Setting `keepPerEngagement = 1`
 * collapses to the original "always keep the latest" behavior.
 *
 * Implemented as one DELETE … (SELECT COUNT(*)) statement so we never
 * need to hold a transaction across a SELECT-then-DELETE pair (which
 * would race against a concurrent kickoff).
 */
export async function pruneOldBriefingGenerationJobs(
  opts: PruneOptions = {},
): Promise<number> {
  const dbHandle = opts.db ?? db;
  const retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionMs);
  // Clamp at 1 — a value of 0 would let the sweep delete the latest
  // row per engagement, which breaks `GET /briefing/status`. NaN /
  // negative values fall through to the default.
  const rawKeep = opts.keepPerEngagement ?? DEFAULT_KEEP_PER_ENGAGEMENT;
  const keepPerEngagement =
    Number.isFinite(rawKeep) && rawKeep >= 1
      ? Math.floor(rawKeep)
      : DEFAULT_KEEP_PER_ENGAGEMENT;

  // The "newer" comparison uses the row-value `(started_at, id)`
  // tuple instead of `started_at` alone so two rows that happen to
  // share an identical `started_at` (default `now()` resolution is
  // microseconds, but a backfill or rapid test seed can still tie)
  // get a deterministic order. Without the tiebreaker, tied rows
  // each see "no newer sibling" and the keep cap silently retains
  // more than N rows per engagement.
  const result = await dbHandle.execute(sql`
    DELETE FROM ${briefingGenerationJobs} AS j
    WHERE j.state IN ('completed', 'failed')
      AND j.started_at < ${cutoff}
      AND (
        SELECT COUNT(*) FROM ${briefingGenerationJobs} AS k
        WHERE k.engagement_id = j.engagement_id
          AND (k.started_at, k.id) > (j.started_at, j.id)
      ) >= ${keepPerEngagement}
    RETURNING j.id
  `);
  return result.rows.length;
}

/**
 * Boot the periodic sweep. Idempotent — a second call logs a warning
 * and returns rather than starting a second timer.
 */
export function startBriefingGenerationJobsSweep(log: Logger): void {
  if (timer) {
    log.warn(
      {},
      "briefing-generation-jobs sweep: startBriefingGenerationJobsSweep called twice, ignoring",
    );
    return;
  }
  const intervalMs = Number(
    process.env["BRIEFING_GENERATION_JOB_SWEEP_INTERVAL_MS"] ??
      DEFAULT_INTERVAL_MS,
  );
  const retentionMs = Number(
    process.env["BRIEFING_GENERATION_JOB_RETENTION_MS"] ??
      DEFAULT_RETENTION_MS,
  );
  const bootDelayMs = Number(
    process.env["BRIEFING_GENERATION_JOB_SWEEP_BOOT_DELAY_MS"] ??
      DEFAULT_BOOT_DELAY_MS,
  );
  const keepPerEngagement = Number(
    process.env["BRIEFING_GENERATION_JOB_KEEP_PER_ENGAGEMENT"] ??
      DEFAULT_KEEP_PER_ENGAGEMENT,
  );
  log.info(
    { intervalMs, retentionMs, bootDelayMs, keepPerEngagement },
    "briefing-generation-jobs sweep: starting",
  );
  timer = setInterval(() => {
    void tick(log, retentionMs, keepPerEngagement);
  }, intervalMs);
  // unref so the sweeper does not block process exit during graceful
  // shutdown — same pattern as the code-atom queue worker.
  if (typeof timer.unref === "function") timer.unref();
  // Fire one sweep on boot (after a delay) so a freshly-started
  // process eventually trims its table even before the first interval
  // tick fires (which on the daily default would be ~24h away).
  bootTimer = setTimeout(
    () => void tick(log, retentionMs, keepPerEngagement),
    bootDelayMs,
  );
  if (typeof bootTimer.unref === "function") bootTimer.unref();
}

export function stopBriefingGenerationJobsSweep(): void {
  if (timer) clearInterval(timer);
  if (bootTimer) clearTimeout(bootTimer);
  timer = null;
  bootTimer = null;
}

async function tick(
  log: Logger,
  retentionMs: number,
  keepPerEngagement: number,
): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const deleted = await pruneOldBriefingGenerationJobs({
      retentionMs,
      keepPerEngagement,
    });
    if (deleted > 0) {
      log.info(
        { deleted, retentionMs, keepPerEngagement },
        "briefing-generation-jobs sweep: pruned terminal rows",
      );
    }
  } catch (err) {
    log.error(
      { err },
      "briefing-generation-jobs sweep: tick failed (will retry on next interval)",
    );
  } finally {
    inFlight = false;
  }
}
