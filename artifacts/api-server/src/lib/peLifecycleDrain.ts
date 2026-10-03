/**
 * The scheduled lifecycle drain (P-492 3b, 3d, R2).
 *
 * Runs in-process in cortex-api, started from `app.ts` beside the other
 * sweepers, on every App Platform instance. Instances never double-send:
 * rows are claimed with FOR UPDATE SKIP LOCKED (`peLifecycleOutbox.drizzle.ts`).
 *
 * Each tick:
 *   1. records itself in `ss_lifecycle_drain_run` (so "did the drain fire"
 *      is a query, not a log search);
 *   2. at most every 10 minutes per process, enqueues `went_quiet` for
 *      contacts 14 days past their last session, and `claude_connected` for
 *      users whose first Claude connector authorization is recorded in
 *      `pe_ai_connections` — both idempotent by key, so several instances
 *      running the scan is harmless;
 *   3. claims and runs due rows in batches until none are due or the tick's
 *      budget is spent.
 */

import { hostname } from "node:os";
import { and, eq, isNotNull, lt, lte, sql } from "drizzle-orm";
import {
  db as prodDb,
  peAiConnections,
  ssContact,
  ssLifecycleDrainRun,
  users,
} from "@workspace/db";
import type { Logger } from "pino";
import { isClaudeClient } from "./peAiConnectionsClassify";
import { productionLegDeps } from "./peLifecycleDispatch";
import { drizzleOutboxStore } from "./peLifecycleOutbox.drizzle";
import {
  claudeConnectedIdempotencyKey,
  enqueueLifecycleEvent,
  processLifecycleOutbox,
  wentQuietIdempotencyKey,
  type LegDeps,
  type OutboxStore,
} from "./peLifecycleOutbox";
import { QUIET_AFTER_DAYS } from "./ssContactProjection";

type Db = typeof prodDb;
type Log = Pick<Logger, "info" | "warn" | "error">;

export const DEFAULT_DRAIN_INTERVAL_MS = 60 * 1000;
export const DEFAULT_DRAIN_BOOT_DELAY_MS = 30 * 1000;
export const SCAN_EVERY_MS = 10 * 60 * 1000;
const BATCH = 25;
const MAX_BATCHES_PER_TICK = 8;
const SCAN_LIMIT = 200;
const RUN_RETENTION_DAYS = 7;

export async function enqueueWentQuiet(
  store: OutboxStore,
  db: Db,
  now: Date,
): Promise<number> {
  const cutoff = new Date(now.getTime() - QUIET_AFTER_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const stale = await db
    .select({ userId: ssContact.userId, email: ssContact.email, lastActive: ssContact.lastActive })
    .from(ssContact)
    .where(
      and(
        eq(ssContact.quiet, false),
        isNotNull(ssContact.lastActive),
        lte(ssContact.lastActive, cutoff),
      ),
    )
    .limit(SCAN_LIMIT);
  let n = 0;
  for (const c of stale) {
    const r = await enqueueLifecycleEvent(
      {
        userId: c.userId,
        email: c.email,
        event: "went_quiet",
        idempotencyKey: wentQuietIdempotencyKey(c.userId, c.lastActive!),
        apply: { event: "went_quiet" },
      },
      store,
      now,
    );
    if (r.enqueued) n += 1;
  }
  return n;
}

/**
 * R2: the first successful Claude connector authorization is observable as
 * the first `pe_ai_connections` row whose client name is a Claude host,
 * written by smartsite-mcp only after a validated OAuth bearer and a named
 * `initialize` (smartsite-mcp/src/auth.ts, connection-record.ts). Which names
 * are Claude is the existing read rule `isClaudeClient`.
 */
export async function enqueueClaudeConnected(
  store: OutboxStore,
  db: Db,
  now: Date,
): Promise<number> {
  const rows = await db
    .select({
      userId: peAiConnections.ownerUserId,
      clientName: peAiConnections.clientName,
      email: users.email,
    })
    .from(peAiConnections)
    .innerJoin(users, eq(users.id, peAiConnections.ownerUserId))
    .leftJoin(ssContact, eq(ssContact.userId, peAiConnections.ownerUserId))
    .where(
      and(
        sql`coalesce(${ssContact.claudeConnected}, false) = false`,
        sql`(lower(${peAiConnections.clientName}) LIKE 'claude%' OR lower(${peAiConnections.clientName}) LIKE 'anthropic/%')`,
      ),
    )
    .limit(SCAN_LIMIT);
  let n = 0;
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.userId) || !r.email || !isClaudeClient(r.clientName)) continue;
    seen.add(r.userId);
    const out = await enqueueLifecycleEvent(
      {
        userId: r.userId,
        email: r.email,
        event: "claude_connected",
        idempotencyKey: claudeConnectedIdempotencyKey(r.userId),
        apply: { event: "claude_connected" },
      },
      store,
      now,
    );
    if (out.enqueued) n += 1;
  }
  return n;
}

export type DrainTickResult = {
  claimed: number;
  sent: number;
  failed: number;
  dead: number;
  quietEnqueued: number;
  claudeEnqueued: number;
};

export type DrainTickOptions = {
  db?: Db;
  store?: OutboxStore;
  legs?: LegDeps;
  now?: () => Date;
  runScans?: boolean;
  log?: Log;
};

export async function runLifecycleDrainTick(
  opts: DrainTickOptions = {},
): Promise<DrainTickResult> {
  const db = opts.db ?? prodDb;
  const store = opts.store ?? drizzleOutboxStore(db);
  const legs = opts.legs ?? productionLegDeps(db);
  const clock = opts.now ?? (() => new Date());
  const startedAt = clock();
  const [run] = await db
    .insert(ssLifecycleDrainRun)
    .values({ host: hostname(), startedAt })
    .returning({ id: ssLifecycleDrainRun.id });
  const result: DrainTickResult = {
    claimed: 0,
    sent: 0,
    failed: 0,
    dead: 0,
    quietEnqueued: 0,
    claudeEnqueued: 0,
  };
  let error: string | null = null;
  try {
    if (opts.runScans ?? true) {
      result.quietEnqueued = await enqueueWentQuiet(store, db, startedAt);
      result.claudeEnqueued = await enqueueClaudeConnected(store, db, startedAt);
    }
    for (let i = 0; i < MAX_BATCHES_PER_TICK; i += 1) {
      const r = await processLifecycleOutbox({ store, limit: BATCH, ...legs, now: clock });
      result.claimed += r.claimed;
      result.sent += r.sent;
      result.failed += r.failed;
      result.dead += r.dead;
      if (r.claimed < BATCH) break;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : "drain_tick_failed";
    opts.log?.error({ err }, "ss lifecycle drain: tick failed");
  }
  if (run) {
    await db
      .update(ssLifecycleDrainRun)
      .set({ ...result, finishedAt: clock(), error })
      .where(eq(ssLifecycleDrainRun.id, run.id));
  }
  await db
    .delete(ssLifecycleDrainRun)
    .where(
      lt(
        ssLifecycleDrainRun.startedAt,
        new Date(startedAt.getTime() - RUN_RETENTION_DAYS * 86_400_000),
      ),
    );
  opts.log?.info({ ...result, error }, "ss lifecycle drain: tick");
  return result;
}

let timer: ReturnType<typeof setInterval> | null = null;
let bootTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
let lastScanAt = 0;

export async function lifecycleDrainKick(log: Log): Promise<void> {
  if (inFlight) {
    log.warn("ss lifecycle drain: tick skipped — previous tick still running");
    return;
  }
  inFlight = true;
  try {
    const runScans = Date.now() - lastScanAt >= SCAN_EVERY_MS;
    if (runScans) lastScanAt = Date.now();
    await runLifecycleDrainTick({ runScans, log });
  } catch (err) {
    log.error({ err }, "ss lifecycle drain: tick threw");
  } finally {
    inFlight = false;
  }
}

/**
 * Start the drain. `SS_LIFECYCLE_DRAIN_INTERVAL_MS=0` disables it (named,
 * logged), which is the only way it does not run.
 */
export function startLifecycleDrain(log: Log): void {
  if (timer !== null || bootTimer !== null) {
    log.warn("ss lifecycle drain: already started — ignoring duplicate start");
    return;
  }
  const intervalMs = Number(
    process.env["SS_LIFECYCLE_DRAIN_INTERVAL_MS"] ?? DEFAULT_DRAIN_INTERVAL_MS,
  );
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    log.warn({ intervalMs }, "ss lifecycle drain: DISABLED by SS_LIFECYCLE_DRAIN_INTERVAL_MS");
    return;
  }
  const bootDelayMs = Number(
    process.env["SS_LIFECYCLE_DRAIN_BOOT_DELAY_MS"] ?? DEFAULT_DRAIN_BOOT_DELAY_MS,
  );
  bootTimer = setTimeout(() => {
    bootTimer = null;
    void lifecycleDrainKick(log);
    timer = setInterval(() => void lifecycleDrainKick(log), intervalMs);
    timer.unref();
  }, Math.max(0, bootDelayMs));
  bootTimer.unref();
  log.info({ intervalMs, bootDelayMs }, "ss lifecycle drain: started");
}

export function stopLifecycleDrain(): void {
  if (bootTimer) clearTimeout(bootTimer);
  if (timer) clearInterval(timer);
  bootTimer = null;
  timer = null;
  inFlight = false;
}
