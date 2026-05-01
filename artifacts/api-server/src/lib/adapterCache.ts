/**
 * Postgres-backed implementation of the {@link AdapterResultCache}
 * contract from `@workspace/adapters/cache`. Task #180.
 *
 * One row per `(adapter_key, lat_rounded, lng_rounded)` in
 * `adapter_response_cache` carries the full `AdapterResult` envelope
 * for a configurable TTL. The runner consults `get` before invoking a
 * federal adapter and writes back through `put` after a successful
 * run, so a re-run of `POST /api/engagements/:id/generate-layers`
 * against the same parcel skips the slow / rate-limited federal feeds.
 *
 * Failure isolation: per the cache contract, neither `get` nor `put`
 * may throw — a cache miss / write failure must always degrade to a
 * fresh adapter run rather than fail the request. The implementation
 * here catches every DB error, logs it, and returns `null` (for `get`)
 * or no-ops (for `put`).
 */

import { db, adapterResponseCache } from "@workspace/db";
import type {
  AdapterCacheHit,
  AdapterCacheKey,
  AdapterResult,
  AdapterResultCache,
} from "@workspace/adapters";
import { and, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { logger as defaultLogger } from "./logger";

/** Default TTL — 24 hours, matching Task #180's "default ~24h". */
export const DEFAULT_ADAPTER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Sweep defaults — Task #203.
 *
 * Reads filter `expires_at > now()` so expired rows never serve, but
 * the only natural pressure-release on the table is the unique-index
 * upsert overwriting a row when the same parcel is re-cached. Parcels
 * looked up once and never again would otherwise leak forever; the
 * sweep deletes those rows in bounded batches on a loose interval.
 *
 * Defaults err on the side of "do less work, more often is fine":
 *   - INTERVAL_MS = 1h   — sweep cadence (the table is tiny by design)
 *   - GRACE_MS    = 1h   — only delete rows that have been expired for
 *                          at least this long, so a row that flips
 *                          expired between a `get` miss and the next
 *                          `put` upsert is never racing the sweep
 *   - BATCH_SIZE  = 1000 — caps the DELETE's row count per tick so a
 *                          backlog can't pin a connection or bloat WAL
 */
export const DEFAULT_ADAPTER_CACHE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
export const DEFAULT_ADAPTER_CACHE_SWEEP_GRACE_MS = 60 * 60 * 1000;
export const DEFAULT_ADAPTER_CACHE_SWEEP_BATCH_SIZE = 1000;

/**
 * Resolve the configured TTL from `ADAPTER_CACHE_TTL_MS`. A value of
 * `0` (or any non-positive integer) disables the cache entirely —
 * {@link createAdapterResponseCache} returns `undefined` so the runner
 * skips the cache path.
 */
export function getAdapterCacheTtlMs(
  envValue: string | undefined = process.env.ADAPTER_CACHE_TTL_MS,
): number {
  if (envValue === undefined || envValue === "") {
    return DEFAULT_ADAPTER_CACHE_TTL_MS;
  }
  const parsed = Number(envValue);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_ADAPTER_CACHE_TTL_MS;
  }
  return Math.floor(parsed);
}

/**
 * Build a Postgres-backed cache. Returns `undefined` when the TTL
 * resolves to `0`, signalling "caching disabled" — the runner treats
 * an undefined cache as "always run live".
 */
export function createAdapterResponseCache(opts?: {
  ttlMs?: number;
  log?: Logger;
}): AdapterResultCache | undefined {
  const ttlMs = opts?.ttlMs ?? getAdapterCacheTtlMs();
  if (ttlMs <= 0) return undefined;
  const log = opts?.log ?? defaultLogger;
  return new PostgresAdapterResponseCache(ttlMs, log);
}

class PostgresAdapterResponseCache implements AdapterResultCache {
  constructor(
    private readonly ttlMs: number,
    private readonly log: Logger,
  ) {}

  async get(key: AdapterCacheKey): Promise<AdapterCacheHit | null> {
    try {
      // numeric columns round-trip as strings via node-postgres; we
      // pass the toFixed'd form so the equality match is byte-exact
      // and the unique index can serve the lookup. We also pull
      // `created_at` so the runner can stamp the outcome's `cachedAt`
      // for the FE pill — the upsert in `put` resets `created_at` to
      // `now()`, so it tracks the most recent successful fetch (Task
      // #204).
      const rows = await db
        .select({
          payload: adapterResponseCache.resultPayload,
          createdAt: adapterResponseCache.createdAt,
        })
        .from(adapterResponseCache)
        .where(
          and(
            eq(adapterResponseCache.adapterKey, key.adapterKey),
            eq(adapterResponseCache.latRounded, formatCoord(key.latRounded)),
            eq(adapterResponseCache.lngRounded, formatCoord(key.lngRounded)),
            gt(adapterResponseCache.expiresAt, new Date()),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      // Schema guarantees `payload` is an object (the runner only
      // writes through valid AdapterResult envelopes), but cast at
      // the boundary so a manual / corrupted row degrades to a miss
      // rather than a runtime crash inside the runner.
      const payload = row.payload as unknown;
      if (!payload || typeof payload !== "object") return null;
      return {
        result: payload as AdapterResult,
        cachedAt: row.createdAt,
      };
    } catch (err) {
      this.log.warn(
        { err, adapterKey: key.adapterKey },
        "adapterCache: get failed — degrading to live run",
      );
      return null;
    }
  }

  async put(key: AdapterCacheKey, result: AdapterResult): Promise<void> {
    try {
      const expiresAt = new Date(Date.now() + this.ttlMs);
      await db
        .insert(adapterResponseCache)
        .values({
          adapterKey: key.adapterKey,
          latRounded: formatCoord(key.latRounded),
          lngRounded: formatCoord(key.lngRounded),
          resultPayload: result as unknown as Record<string, unknown>,
          expiresAt,
        })
        .onConflictDoUpdate({
          target: [
            adapterResponseCache.adapterKey,
            adapterResponseCache.latRounded,
            adapterResponseCache.lngRounded,
          ],
          set: {
            resultPayload: result as unknown as Record<string, unknown>,
            expiresAt,
            // Refresh createdAt on the write so the row's age tracks
            // the most recent successful fetch, not the first time we
            // ever cached this parcel.
            createdAt: sql`now()`,
          },
        });
    } catch (err) {
      this.log.warn(
        { err, adapterKey: key.adapterKey },
        "adapterCache: put failed — row will be re-fetched next run",
      );
    }
  }
}

/**
 * Format a coordinate the way the `numeric(9, 5)` column expects.
 * Drizzle/pg accept a string for `numeric`; using `toFixed(5)` here
 * matches the rounding we already did in `toCacheKey` so the unique
 * index lookup is exact.
 */
function formatCoord(value: number): string {
  return value.toFixed(5);
}

/**
 * Parse a non-negative integer env value, falling back to the default
 * for `undefined`, empty strings, non-numeric input, or negative
 * numbers. `0` is preserved (callers interpret it as "disabled").
 */
function parseNonNegativeIntEnv(
  envValue: string | undefined,
  fallback: number,
): number {
  if (envValue === undefined || envValue === "") return fallback;
  const parsed = Number(envValue);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

/**
 * Resolve the sweep tick interval from `ADAPTER_CACHE_SWEEP_INTERVAL_MS`.
 * `0` disables the worker entirely — {@link startAdapterCacheSweepWorker}
 * returns without arming a timer.
 */
export function getAdapterCacheSweepIntervalMs(
  envValue: string | undefined = process.env.ADAPTER_CACHE_SWEEP_INTERVAL_MS,
): number {
  return parseNonNegativeIntEnv(
    envValue,
    DEFAULT_ADAPTER_CACHE_SWEEP_INTERVAL_MS,
  );
}

/**
 * Resolve the grace period from `ADAPTER_CACHE_SWEEP_GRACE_MS`. Rows
 * are only swept once they have been expired for at least this long,
 * which keeps the sweep from racing a near-simultaneous `put` upsert.
 * `0` is allowed and means "delete as soon as expired".
 */
export function getAdapterCacheSweepGraceMs(
  envValue: string | undefined = process.env.ADAPTER_CACHE_SWEEP_GRACE_MS,
): number {
  return parseNonNegativeIntEnv(envValue, DEFAULT_ADAPTER_CACHE_SWEEP_GRACE_MS);
}

/**
 * Resolve the per-tick batch cap from `ADAPTER_CACHE_SWEEP_BATCH_SIZE`.
 * `0` or negative falls back to the default; a real value of `0` is
 * meaningless here (a sweep that deletes nothing isn't a sweep), so
 * we treat it as "use the default" rather than "disable" — the worker
 * is disabled via the interval env, not the batch size.
 */
export function getAdapterCacheSweepBatchSize(
  envValue: string | undefined = process.env.ADAPTER_CACHE_SWEEP_BATCH_SIZE,
): number {
  const parsed = parseNonNegativeIntEnv(
    envValue,
    DEFAULT_ADAPTER_CACHE_SWEEP_BATCH_SIZE,
  );
  return parsed > 0 ? parsed : DEFAULT_ADAPTER_CACHE_SWEEP_BATCH_SIZE;
}

/**
 * Namespace for the cluster-wide Postgres advisory lock that
 * serializes sweep ticks across api-server instances. We append
 * `current_schema()` inside the SQL so the lock key is automatically
 * scoped to whichever schema the cache table lives in — that keeps
 * concurrent test schemas from contending on the same key while
 * still giving a single shared key to all production instances
 * (which all read/write the `public` schema).
 *
 * Exposed so tests can compute the same hash and simulate a peer
 * instance holding the lock.
 */
export const ADAPTER_CACHE_SWEEP_LOCK_NAMESPACE = "adapter_cache_sweep";

/**
 * Delete up to `batchSize` rows whose `expires_at` is older than
 * `now() - graceMs`. Returns the number of rows actually removed
 * (0 when there's nothing to do). Never throws — DB failures are
 * logged and reported as `0` so a transient outage can't crash the
 * sweep worker.
 *
 * The DELETE targets a `SELECT … LIMIT batchSize` subquery so the
 * row count is bounded regardless of how much expired backlog has
 * accumulated, and the inner SELECT is served by the
 * `adapter_response_cache_expires_idx` index (per the schema note).
 *
 * Multi-instance safety (Task #218): the whole tick runs inside a
 * transaction that first tries to acquire a transaction-scoped
 * Postgres advisory lock. If a peer api-server instance already
 * holds the lock for this tick, this call short-circuits and
 * returns `0` without scanning the index or contending on rows.
 * The lock auto-releases at COMMIT/ROLLBACK so a crashed sweeper
 * can't strand the lock.
 */
export async function sweepExpiredAdapterCacheRows(opts?: {
  graceMs?: number;
  batchSize?: number;
  log?: Logger;
}): Promise<number> {
  const graceMs = opts?.graceMs ?? getAdapterCacheSweepGraceMs();
  const batchSize = opts?.batchSize ?? getAdapterCacheSweepBatchSize();
  const log = opts?.log ?? defaultLogger;
  const cutoff = new Date(Date.now() - graceMs);
  try {
    return await db.transaction(async (tx) => {
      // pg_try_advisory_xact_lock returns true if it acquired the
      // lock, false if any other session is already holding it. The
      // hash key is derived in-DB from the namespace + current schema
      // so production instances (all on `public`) share one key while
      // concurrent test schemas stay isolated from each other.
      const lockResult = (await tx.execute(
        sql`SELECT pg_try_advisory_xact_lock(
              hashtextextended(
                ${ADAPTER_CACHE_SWEEP_LOCK_NAMESPACE} || '|' || current_schema(),
                0
              )
            ) AS locked`,
      )) as unknown as { rows: Array<{ locked?: unknown }> };
      const locked = lockResult.rows?.[0]?.locked === true;
      if (!locked) {
        // Another instance is already sweeping this tick. Logging at
        // debug because in a multi-instance deploy this is the steady
        // state for every instance except the lucky one each tick.
        log.debug(
          {},
          "adapterCache sweep: peer holds advisory lock, skipping tick",
        );
        return 0;
      }
      const victims = tx
        .select({ id: adapterResponseCache.id })
        .from(adapterResponseCache)
        .where(lt(adapterResponseCache.expiresAt, cutoff))
        .limit(batchSize);
      const deleted = await tx
        .delete(adapterResponseCache)
        .where(inArray(adapterResponseCache.id, victims))
        .returning({ id: adapterResponseCache.id });
      return deleted.length;
    });
  } catch (err) {
    log.warn(
      { err, graceMs, batchSize },
      "adapterCache sweep: delete failed — will retry next tick",
    );
    return 0;
  }
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let sweepBootstrapTimer: ReturnType<typeof setTimeout> | null = null;
let sweepInFlight = false;

/**
 * Boot the periodic sweep worker. Idempotent — a second call logs and
 * returns. When the interval env resolves to `0` (disabled) the worker
 * is not armed at all, which is the only safe way to opt out without
 * also disabling the cache itself.
 *
 * Modeled after `startQueueWorker` in `lib/codes/src/queue.ts`:
 *   - tick is async-guarded so a slow DB round-trip can't stack ticks
 *   - timer is `unref`'d so a graceful shutdown isn't blocked by it
 *   - first sweep runs ~1s after boot so a process that crashed mid-
 *     sweep on the previous deploy doesn't wait a full interval to
 *     start cleaning up
 */
export function startAdapterCacheSweepWorker(opts?: {
  log?: Logger;
  intervalMs?: number;
  graceMs?: number;
  batchSize?: number;
}): void {
  const log = opts?.log ?? defaultLogger;
  if (sweepTimer) {
    log.warn(
      {},
      "adapterCache sweep: startAdapterCacheSweepWorker called twice, ignoring",
    );
    return;
  }
  const intervalMs = opts?.intervalMs ?? getAdapterCacheSweepIntervalMs();
  if (intervalMs <= 0) {
    log.info(
      { intervalMs },
      "adapterCache sweep: disabled by ADAPTER_CACHE_SWEEP_INTERVAL_MS=0",
    );
    return;
  }
  const graceMs = opts?.graceMs ?? getAdapterCacheSweepGraceMs();
  const batchSize = opts?.batchSize ?? getAdapterCacheSweepBatchSize();
  log.info(
    { intervalMs, graceMs, batchSize },
    "adapterCache sweep: starting",
  );
  sweepTimer = setInterval(() => {
    void sweepTick({ log, graceMs, batchSize });
  }, intervalMs);
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();
  // Run a first sweep ~1s after boot so a process restarted with a
  // backlog doesn't have to wait a full interval to start cleaning up.
  // Tracked in `sweepBootstrapTimer` so `stopAdapterCacheSweepWorker`
  // can cancel it — without that, a `start` immediately followed by a
  // `stop` (common in tests) would still let the bootstrap fire ~1s
  // later against a closed schema.
  sweepBootstrapTimer = setTimeout(
    () => void sweepTick({ log, graceMs, batchSize }),
    1000,
  );
  if (typeof sweepBootstrapTimer.unref === "function") {
    sweepBootstrapTimer.unref();
  }
}

/** Stop the sweep worker. Safe to call when no worker is running. */
export function stopAdapterCacheSweepWorker(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  if (sweepBootstrapTimer) clearTimeout(sweepBootstrapTimer);
  sweepBootstrapTimer = null;
}

async function sweepTick(opts: {
  log: Logger;
  graceMs: number;
  batchSize: number;
}): Promise<void> {
  if (sweepInFlight) return;
  sweepInFlight = true;
  try {
    const deleted = await sweepExpiredAdapterCacheRows({
      graceMs: opts.graceMs,
      batchSize: opts.batchSize,
      log: opts.log,
    });
    // Only log when we actually did something — the table is small by
    // design, so a quiet sweep is the common case and shouldn't fill
    // logs. A non-zero count is meaningful (capacity signal).
    if (deleted > 0) {
      opts.log.info(
        { deleted, batchSize: opts.batchSize, graceMs: opts.graceMs },
        "adapterCache sweep: removed expired rows",
      );
    }
  } catch (err) {
    // sweepExpiredAdapterCacheRows already swallows DB errors; this
    // catch is the belt-and-braces guard against a bug in the helper
    // surfacing as an unhandled rejection inside setInterval.
    opts.log.error({ err }, "adapterCache sweep: tick failed");
  } finally {
    sweepInFlight = false;
  }
}
