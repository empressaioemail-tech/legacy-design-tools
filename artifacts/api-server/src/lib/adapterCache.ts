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
  AdapterCacheKey,
  AdapterResult,
  AdapterResultCache,
} from "@workspace/adapters";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { logger as defaultLogger } from "./logger";

/** Default TTL — 24 hours, matching Task #180's "default ~24h". */
export const DEFAULT_ADAPTER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

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

  async get(key: AdapterCacheKey): Promise<AdapterResult | null> {
    try {
      // numeric columns round-trip as strings via node-postgres; we
      // pass the toFixed'd form so the equality match is byte-exact
      // and the unique index can serve the lookup.
      const rows = await db
        .select({ payload: adapterResponseCache.resultPayload })
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
      return payload as AdapterResult;
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
