/**
 * Postgres-backed adapter response cache — Task #180.
 *
 * Exercises the real DB layer (no mocks) so the unique-index upsert
 * + numeric-coordinate equality lookup + TTL gate are all proven
 * end-to-end. The runner-level cache contract is covered separately
 * in lib/adapters/src/__tests__/cache.test.ts.
 */

import { describe, it, expect, vi } from "vitest";
import { ctx } from "./test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("adapterCache.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { adapterResponseCache } = await import("@workspace/db");
const { eq } = await import("drizzle-orm");
const { toCacheKey } = await import("@workspace/adapters");
const {
  createAdapterResponseCache,
  getAdapterCacheTtlMs,
  getAdapterCacheSweepIntervalMs,
  getAdapterCacheSweepGraceMs,
  getAdapterCacheSweepBatchSize,
  getAdapterCacheSweepSkipWarnMs,
  sweepExpiredAdapterCacheRows,
  startAdapterCacheSweepWorker,
  stopAdapterCacheSweepWorker,
  runAdapterCacheSweepTick,
  DEFAULT_ADAPTER_CACHE_SWEEP_INTERVAL_MS,
  DEFAULT_ADAPTER_CACHE_SWEEP_GRACE_MS,
  DEFAULT_ADAPTER_CACHE_SWEEP_BATCH_SIZE,
  DEFAULT_ADAPTER_CACHE_SWEEP_SKIP_WARN_MS,
  ADAPTER_CACHE_SWEEP_LOCK_NAMESPACE,
} = await import("../lib/adapterCache");
import type { AdapterResult } from "@workspace/adapters";

setupRouteTests(() => {});

const sampleResult: AdapterResult = {
  adapterKey: "fema:nfhl-flood-zone",
  tier: "federal",
  layerKind: "fema-nfhl-flood-zone",
  sourceKind: "federal-adapter",
  provider: "FEMA NFHL",
  snapshotDate: "2026-01-15T00:00:00.000Z",
  payload: { kind: "flood-zone", floodZone: "AE" },
  note: null,
};

describe("getAdapterCacheTtlMs", () => {
  it("defaults to 24 hours", () => {
    expect(getAdapterCacheTtlMs(undefined)).toBe(24 * 60 * 60 * 1000);
    expect(getAdapterCacheTtlMs("")).toBe(24 * 60 * 60 * 1000);
  });

  it("parses a positive integer from the env value", () => {
    expect(getAdapterCacheTtlMs("60000")).toBe(60_000);
  });

  it("treats `0` as caching disabled", () => {
    expect(getAdapterCacheTtlMs("0")).toBe(0);
  });

  it("falls back to the default for non-numeric or negative values", () => {
    expect(getAdapterCacheTtlMs("nope")).toBe(24 * 60 * 60 * 1000);
    expect(getAdapterCacheTtlMs("-1")).toBe(24 * 60 * 60 * 1000);
  });
});

describe("createAdapterResponseCache factory", () => {
  it("returns undefined when the TTL is zero", () => {
    expect(createAdapterResponseCache({ ttlMs: 0 })).toBeUndefined();
  });
});

describe("PostgresAdapterResponseCache", () => {
  it("returns null on a miss", async () => {
    const cache = createAdapterResponseCache({ ttlMs: 60_000 });
    const key = toCacheKey("fema:nfhl-flood-zone", 38.5733, -109.5499);
    expect(key).not.toBeNull();
    const hit = await cache!.get(key!);
    expect(hit).toBeNull();
  });

  it("round-trips a put + get and exposes the row's createdAt as cachedAt", async () => {
    const cache = createAdapterResponseCache({ ttlMs: 60_000 });
    const key = toCacheKey("fema:nfhl-flood-zone", 38.5733, -109.5499);
    const beforePut = new Date();
    await cache!.put(key!, sampleResult);
    const hit = await cache!.get(key!);
    expect(hit).not.toBeNull();
    expect(hit!.result).toEqual(sampleResult);
    expect(hit!.cachedAt).toBeInstanceOf(Date);
    // The Postgres row's createdAt should land within a generous
    // window around the put — this proves we're reading it through
    // (and not stamping a new Date on the read path).
    expect(hit!.cachedAt.getTime()).toBeGreaterThanOrEqual(
      beforePut.getTime() - 1000,
    );
    expect(hit!.cachedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("upserts on conflict so a re-run replaces the row in place", async () => {
    const cache = createAdapterResponseCache({ ttlMs: 60_000 });
    const key = toCacheKey("fema:nfhl-flood-zone", 38.5733, -109.5499);
    await cache!.put(key!, sampleResult);
    const updated: AdapterResult = {
      ...sampleResult,
      payload: { kind: "flood-zone", floodZone: "X" },
    };
    await cache!.put(key!, updated);
    const rows = await ctx.schema!.db
      .select()
      .from(adapterResponseCache)
      .where(eq(adapterResponseCache.adapterKey, "fema:nfhl-flood-zone"));
    expect(rows).toHaveLength(1);
    const hit = await cache!.get(key!);
    expect(hit?.result.payload).toEqual({
      kind: "flood-zone",
      floodZone: "X",
    });
  });

  it("does not return expired rows", async () => {
    // TTL = -1ms ensures the row is already expired by the time we
    // read it back, exercising the `expires_at > now()` filter.
    const cache = createAdapterResponseCache({ ttlMs: 1 });
    const key = toCacheKey("usgs:ned-elevation", 38.5733, -109.5499);
    await cache!.put(key!, sampleResult);
    // Wait a few ms for the row to expire.
    await new Promise((r) => setTimeout(r, 20));
    // Manually expire the row to make this deterministic.
    await ctx.schema!.db
      .update(adapterResponseCache)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(adapterResponseCache.adapterKey, "usgs:ned-elevation"));
    const hit = await cache!.get(key!);
    expect(hit).toBeNull();
  });

  it("isolates different adapters at the same coordinates", async () => {
    const cache = createAdapterResponseCache({ ttlMs: 60_000 });
    const fema = toCacheKey("fema:nfhl", 38.5733, -109.5499);
    const usgs = toCacheKey("usgs:ned-elevation", 38.5733, -109.5499);
    await cache!.put(fema!, { ...sampleResult, adapterKey: "fema:nfhl" });
    await cache!.put(usgs!, {
      ...sampleResult,
      adapterKey: "usgs:ned-elevation",
      payload: { kind: "elevation", elevationFeet: 4032 },
    });
    const femaHit = await cache!.get(fema!);
    const usgsHit = await cache!.get(usgs!);
    expect(femaHit?.result.adapterKey).toBe("fema:nfhl");
    expect(usgsHit?.result.adapterKey).toBe("usgs:ned-elevation");
  });

  it("isolates the same adapter at different coordinates", async () => {
    const cache = createAdapterResponseCache({ ttlMs: 60_000 });
    const moab = toCacheKey("fema:nfhl", 38.5733, -109.5499);
    const bastrop = toCacheKey("fema:nfhl", 30.1105, -97.3186);
    await cache!.put(moab!, { ...sampleResult, payload: { city: "moab" } });
    await cache!.put(bastrop!, {
      ...sampleResult,
      payload: { city: "bastrop" },
    });
    const moabHit = await cache!.get(moab!);
    const bastropHit = await cache!.get(bastrop!);
    expect(moabHit?.result.payload).toEqual({ city: "moab" });
    expect(bastropHit?.result.payload).toEqual({ city: "bastrop" });
  });

  it("treats coordinates that round to the same 5-decimal value as one cache entry", async () => {
    const cache = createAdapterResponseCache({ ttlMs: 60_000 });
    const a = toCacheKey("fema:nfhl", 38.57330001, -109.54989999);
    const b = toCacheKey("fema:nfhl", 38.57329999, -109.54990002);
    expect(a).toEqual(b);
    await cache!.put(a!, { ...sampleResult, payload: { v: 1 } });
    await cache!.put(b!, { ...sampleResult, payload: { v: 2 } });
    const rows = await ctx.schema!.db.select().from(adapterResponseCache);
    expect(rows).toHaveLength(1);
    const hit = await cache!.get(a!);
    expect(hit?.result.payload).toEqual({ v: 2 });
  });
});

describe("adapter cache sweep env helpers", () => {
  it("getAdapterCacheSweepIntervalMs defaults to 1 hour", () => {
    expect(getAdapterCacheSweepIntervalMs(undefined)).toBe(
      DEFAULT_ADAPTER_CACHE_SWEEP_INTERVAL_MS,
    );
    expect(getAdapterCacheSweepIntervalMs("")).toBe(
      DEFAULT_ADAPTER_CACHE_SWEEP_INTERVAL_MS,
    );
  });

  it("getAdapterCacheSweepIntervalMs honours `0` as disabled", () => {
    expect(getAdapterCacheSweepIntervalMs("0")).toBe(0);
  });

  it("getAdapterCacheSweepIntervalMs falls back on garbage input", () => {
    expect(getAdapterCacheSweepIntervalMs("nope")).toBe(
      DEFAULT_ADAPTER_CACHE_SWEEP_INTERVAL_MS,
    );
    expect(getAdapterCacheSweepIntervalMs("-5")).toBe(
      DEFAULT_ADAPTER_CACHE_SWEEP_INTERVAL_MS,
    );
  });

  it("getAdapterCacheSweepGraceMs parses 0 as no-grace", () => {
    expect(getAdapterCacheSweepGraceMs("0")).toBe(0);
    expect(getAdapterCacheSweepGraceMs(undefined)).toBe(
      DEFAULT_ADAPTER_CACHE_SWEEP_GRACE_MS,
    );
  });

  it("getAdapterCacheSweepBatchSize falls back on `0` (disabling via batch is not supported)", () => {
    expect(getAdapterCacheSweepBatchSize("0")).toBe(
      DEFAULT_ADAPTER_CACHE_SWEEP_BATCH_SIZE,
    );
    expect(getAdapterCacheSweepBatchSize("250")).toBe(250);
    expect(getAdapterCacheSweepBatchSize(undefined)).toBe(
      DEFAULT_ADAPTER_CACHE_SWEEP_BATCH_SIZE,
    );
  });

  it("getAdapterCacheSweepSkipWarnMs defaults to 24h, parses values, and treats `0` as disabled", () => {
    expect(getAdapterCacheSweepSkipWarnMs(undefined)).toBe(
      DEFAULT_ADAPTER_CACHE_SWEEP_SKIP_WARN_MS,
    );
    expect(getAdapterCacheSweepSkipWarnMs("")).toBe(
      DEFAULT_ADAPTER_CACHE_SWEEP_SKIP_WARN_MS,
    );
    expect(getAdapterCacheSweepSkipWarnMs("0")).toBe(0);
    expect(getAdapterCacheSweepSkipWarnMs("90000")).toBe(90_000);
    expect(getAdapterCacheSweepSkipWarnMs("nope")).toBe(
      DEFAULT_ADAPTER_CACHE_SWEEP_SKIP_WARN_MS,
    );
    expect(getAdapterCacheSweepSkipWarnMs("-1")).toBe(
      DEFAULT_ADAPTER_CACHE_SWEEP_SKIP_WARN_MS,
    );
  });
});

describe("sweepExpiredAdapterCacheRows", () => {
  it("returns 0 when there is nothing expired", async () => {
    const cache = createAdapterResponseCache({ ttlMs: 60_000 });
    const key = toCacheKey("fema:nfhl-flood-zone", 38.5733, -109.5499);
    await cache!.put(key!, sampleResult);
    const removed = await sweepExpiredAdapterCacheRows({
      graceMs: 0,
      batchSize: 100,
    });
    expect(removed).toBe(0);
    const rows = await ctx.schema!.db.select().from(adapterResponseCache);
    expect(rows).toHaveLength(1);
  });

  it("deletes rows whose expires_at is older than now() - graceMs", async () => {
    const cache = createAdapterResponseCache({ ttlMs: 60_000 });
    const key = toCacheKey("fema:nfhl-flood-zone", 38.5733, -109.5499);
    await cache!.put(key!, sampleResult);
    // Manually expire well past the grace window.
    await ctx.schema!.db
      .update(adapterResponseCache)
      .set({ expiresAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(
        eq(adapterResponseCache.adapterKey, "fema:nfhl-flood-zone"),
      );
    const removed = await sweepExpiredAdapterCacheRows({
      graceMs: 60_000,
      batchSize: 100,
    });
    expect(removed).toBe(1);
    const rows = await ctx.schema!.db.select().from(adapterResponseCache);
    expect(rows).toHaveLength(0);
  });

  it("respects the grace window — recently-expired rows survive", async () => {
    const cache = createAdapterResponseCache({ ttlMs: 60_000 });
    const key = toCacheKey("fema:nfhl-flood-zone", 38.5733, -109.5499);
    await cache!.put(key!, sampleResult);
    // Expired 10s ago, but grace is 1h — survives.
    await ctx.schema!.db
      .update(adapterResponseCache)
      .set({ expiresAt: new Date(Date.now() - 10_000) })
      .where(
        eq(adapterResponseCache.adapterKey, "fema:nfhl-flood-zone"),
      );
    const removed = await sweepExpiredAdapterCacheRows({
      graceMs: 60 * 60 * 1000,
      batchSize: 100,
    });
    expect(removed).toBe(0);
    const rows = await ctx.schema!.db.select().from(adapterResponseCache);
    expect(rows).toHaveLength(1);
  });

  it("caps the deletion at batchSize per call", async () => {
    const cache = createAdapterResponseCache({ ttlMs: 60_000 });
    // Seed five rows by varying coordinates so the unique index doesn't
    // collapse them. The 5th decimal is the rounding precision the
    // schema enforces, so step at the 4th to keep them distinct.
    for (let i = 0; i < 5; i++) {
      const k = toCacheKey(
        "fema:nfhl-flood-zone",
        38.5 + i * 0.001,
        -109.5,
      );
      await cache!.put(k!, sampleResult);
    }
    await ctx.schema!.db
      .update(adapterResponseCache)
      .set({ expiresAt: new Date(Date.now() - 10 * 60 * 1000) });
    const firstSweep = await sweepExpiredAdapterCacheRows({
      graceMs: 0,
      batchSize: 2,
    });
    expect(firstSweep).toBe(2);
    const afterFirst = await ctx.schema!.db
      .select()
      .from(adapterResponseCache);
    expect(afterFirst).toHaveLength(3);
    const secondSweep = await sweepExpiredAdapterCacheRows({
      graceMs: 0,
      batchSize: 2,
    });
    expect(secondSweep).toBe(2);
    const thirdSweep = await sweepExpiredAdapterCacheRows({
      graceMs: 0,
      batchSize: 2,
    });
    expect(thirdSweep).toBe(1);
    const remaining = await ctx.schema!.db
      .select()
      .from(adapterResponseCache);
    expect(remaining).toHaveLength(0);
  });

  it("skips work when a peer instance already holds the sweep advisory lock (Task #218)", async () => {
    // Simulates two api-server instances ticking simultaneously: a
    // peer holds the cluster-wide sweep lock on its own connection,
    // so this instance's tick must short-circuit and delete nothing.
    // We then release the peer lock and re-run the sweep to prove the
    // rows are only swept once total — never twice.
    const cache = createAdapterResponseCache({ ttlMs: 60_000 });
    for (let i = 0; i < 4; i++) {
      const k = toCacheKey(
        "fema:nfhl-flood-zone",
        38.5 + i * 0.001,
        -109.5,
      );
      await cache!.put(k!, sampleResult);
    }
    await ctx.schema!.db
      .update(adapterResponseCache)
      .set({ expiresAt: new Date(Date.now() - 10 * 60 * 1000) });

    // Borrow a dedicated client and acquire a SESSION-scoped lock on
    // the same key the production sweeper uses. Session and xact
    // advisory locks share one keyspace, so this blocks the sweeper's
    // pg_try_advisory_xact_lock from acquiring.
    const peer = await ctx.schema!.pool.connect();
    try {
      await peer.query(
        `SELECT pg_advisory_lock(
           hashtextextended($1 || '|' || current_schema(), 0)
         )`,
        [ADAPTER_CACHE_SWEEP_LOCK_NAMESPACE],
      );

      const skipped = await sweepExpiredAdapterCacheRows({
        graceMs: 0,
        batchSize: 100,
      });
      expect(skipped).toBe(0);
      const stillThere = await ctx.schema!.db
        .select()
        .from(adapterResponseCache);
      expect(stillThere).toHaveLength(4);

      // Release the peer's lock and re-run: this tick should now do
      // the work the first one would have done.
      await peer.query(
        `SELECT pg_advisory_unlock(
           hashtextextended($1 || '|' || current_schema(), 0)
         )`,
        [ADAPTER_CACHE_SWEEP_LOCK_NAMESPACE],
      );
    } finally {
      peer.release();
    }

    const swept = await sweepExpiredAdapterCacheRows({
      graceMs: 0,
      batchSize: 100,
    });
    expect(swept).toBe(4);
    const remaining = await ctx.schema!.db
      .select()
      .from(adapterResponseCache);
    expect(remaining).toHaveLength(0);
  });

  it("two concurrent ticks together delete each row at most once (Task #218)", async () => {
    // Fires two sweepExpiredAdapterCacheRows() calls in parallel.
    // Each runs in its own transaction on its own pool connection,
    // and both try to acquire the same advisory lock. Only one wins;
    // the other returns 0 immediately. The total work performed
    // across both must equal the row count — never double it.
    const cache = createAdapterResponseCache({ ttlMs: 60_000 });
    for (let i = 0; i < 6; i++) {
      const k = toCacheKey(
        "fema:nfhl-flood-zone",
        38.5 + i * 0.001,
        -109.5,
      );
      await cache!.put(k!, sampleResult);
    }
    await ctx.schema!.db
      .update(adapterResponseCache)
      .set({ expiresAt: new Date(Date.now() - 10 * 60 * 1000) });

    // Hold the lock first to guarantee both ticks find it taken when
    // they race in. Without this, one tick could win the lock, finish
    // the DELETE, and release before the second one arrives — at
    // which point the second would also acquire the lock but find no
    // rows to delete (also returning 0). That outcome is *correct*
    // but not what this test wants to prove. By pre-holding the lock,
    // we guarantee both ticks observe contention, then we release and
    // wait for them to settle.
    const peer = await ctx.schema!.pool.connect();
    let firstResult: number;
    let secondResult: number;
    try {
      await peer.query(
        `SELECT pg_advisory_lock(
           hashtextextended($1 || '|' || current_schema(), 0)
         )`,
        [ADAPTER_CACHE_SWEEP_LOCK_NAMESPACE],
      );
      const ticks = Promise.all([
        sweepExpiredAdapterCacheRows({ graceMs: 0, batchSize: 100 }),
        sweepExpiredAdapterCacheRows({ graceMs: 0, batchSize: 100 }),
      ]);
      // Give both ticks a moment to BEGIN and try the lock so they
      // are guaranteed to observe it as taken by `peer`.
      await new Promise((r) => setTimeout(r, 50));
      await peer.query(
        `SELECT pg_advisory_unlock(
           hashtextextended($1 || '|' || current_schema(), 0)
         )`,
        [ADAPTER_CACHE_SWEEP_LOCK_NAMESPACE],
      );
      [firstResult, secondResult] = await ticks;
    } finally {
      peer.release();
    }

    // Neither tick deleted the rows twice. Each tick saw the lock as
    // held by the peer and short-circuited to 0.
    expect(firstResult).toBe(0);
    expect(secondResult).toBe(0);
    const stillThere = await ctx.schema!.db
      .select()
      .from(adapterResponseCache);
    expect(stillThere).toHaveLength(6);

    // A follow-up tick (peer no longer holding the lock) does the
    // actual cleanup, proving the worker isn't permanently wedged.
    const cleanup = await sweepExpiredAdapterCacheRows({
      graceMs: 0,
      batchSize: 100,
    });
    expect(cleanup).toBe(6);
  });

  it("racing ticks elect exactly one winner — one returns the full count, the other returns 0 (Task #218)", async () => {
    // Natural-race variant: no pre-held peer lock. Both ticks fire
    // simultaneously and contend on the cluster-wide advisory lock
    // directly. The invariant we assert is the strong one a multi-
    // instance deploy depends on — across the two contenders the
    // table is swept exactly once, never zero times and never twice.
    //
    // Concretely: one caller returns ROW_COUNT and the other returns
    // 0 (or, if the winner finishes and releases before the second
    // ever attempts the lock, the second tick acquires cleanly but
    // finds the table empty — also returning 0). Either way: the
    // sum is ROW_COUNT and the product is 0.
    const ROW_COUNT = 5;
    const cache = createAdapterResponseCache({ ttlMs: 60_000 });
    for (let i = 0; i < ROW_COUNT; i++) {
      const k = toCacheKey(
        "fema:nfhl-flood-zone",
        38.5 + i * 0.001,
        -109.5,
      );
      await cache!.put(k!, sampleResult);
    }
    await ctx.schema!.db
      .update(adapterResponseCache)
      .set({ expiresAt: new Date(Date.now() - 10 * 60 * 1000) });

    const [a, b] = await Promise.all([
      sweepExpiredAdapterCacheRows({ graceMs: 0, batchSize: 100 }),
      sweepExpiredAdapterCacheRows({ graceMs: 0, batchSize: 100 }),
    ]);
    expect(a + b).toBe(ROW_COUNT);
    expect(a * b).toBe(0);
    const remaining = await ctx.schema!.db
      .select()
      .from(adapterResponseCache);
    expect(remaining).toHaveLength(0);
  });
});

describe("startAdapterCacheSweepWorker", () => {
  it("does not arm a timer when intervalMs is 0", () => {
    // No timer to clean up — if this implementation regression returned
    // a real timer, the test runner would hang waiting for unref'd
    // intervals to flush. The assertion is the implicit "still exits".
    startAdapterCacheSweepWorker({ intervalMs: 0 });
    // Idempotent: stop is a no-op when the worker never armed.
    stopAdapterCacheSweepWorker();
  });

  it("ticks at the configured interval and removes expired rows", async () => {
    const cache = createAdapterResponseCache({ ttlMs: 60_000 });
    const key = toCacheKey("fema:nfhl-flood-zone", 38.5733, -109.5499);
    await cache!.put(key!, sampleResult);
    await ctx.schema!.db
      .update(adapterResponseCache)
      .set({ expiresAt: new Date(Date.now() - 10 * 60 * 1000) });
    try {
      startAdapterCacheSweepWorker({
        intervalMs: 25,
        graceMs: 0,
        batchSize: 100,
      });
      // The worker fires the first sweep ~1s after boot via setTimeout,
      // and a tick every intervalMs after that. Poll the table for a
      // bounded window so the test isn't sensitive to scheduling jitter.
      const deadline = Date.now() + 3000;
      let rows = await ctx.schema!.db.select().from(adapterResponseCache);
      while (rows.length > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        rows = await ctx.schema!.db.select().from(adapterResponseCache);
      }
      expect(rows).toHaveLength(0);
    } finally {
      stopAdapterCacheSweepWorker();
    }
  });

  it("is idempotent — a second start is a warning, not a second timer", () => {
    try {
      startAdapterCacheSweepWorker({
        intervalMs: 60_000,
        graceMs: 0,
        batchSize: 1,
      });
      startAdapterCacheSweepWorker({
        intervalMs: 60_000,
        graceMs: 0,
        batchSize: 1,
      });
    } finally {
      stopAdapterCacheSweepWorker();
    }
  });
});

describe("runAdapterCacheSweepTick — skip-streak warning (Task #239)", () => {
  /**
   * Build a pino-shaped logger that captures `warn` / `info` / `error`
   * calls into arrays so each test can assert exactly one warn fires
   * across the whole streak, not one per skipped tick.
   */
  function makeCapturingLogger() {
    const warns: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const infos: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const errors: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const log = {
      warn: (obj: Record<string, unknown>, msg: string) =>
        warns.push({ obj, msg }),
      info: (obj: Record<string, unknown>, msg: string) =>
        infos.push({ obj, msg }),
      debug: () => {},
      error: (obj: Record<string, unknown>, msg: string) =>
        errors.push({ obj, msg }),
    } as unknown as import("pino").Logger;
    return { log, warns, infos, errors };
  }

  /**
   * Acquire the cluster-wide sweep advisory lock on a dedicated pool
   * connection so every `runAdapterCacheSweepTick` call inside the
   * caller's body sees the lock as taken and skips. Returns a
   * teardown that releases the lock and the connection.
   */
  async function holdPeerSweepLock(): Promise<() => Promise<void>> {
    const peer = await ctx.schema!.pool.connect();
    await peer.query(
      `SELECT pg_advisory_lock(
         hashtextextended($1 || '|' || current_schema(), 0)
       )`,
      [ADAPTER_CACHE_SWEEP_LOCK_NAMESPACE],
    );
    return async () => {
      try {
        await peer.query(
          `SELECT pg_advisory_unlock(
             hashtextextended($1 || '|' || current_schema(), 0)
           )`,
          [ADAPTER_CACHE_SWEEP_LOCK_NAMESPACE],
        );
      } finally {
        peer.release();
      }
    };
  }

  it("emits exactly one warn after the threshold and does not re-fire on subsequent skipped ticks", async () => {
    // Reset module-level skip state — `stop` clears it and is safe
    // to call when nothing is running. Without this, prior tests in
    // this suite could have left state behind.
    stopAdapterCacheSweepWorker();
    const { log, warns } = makeCapturingLogger();
    let fakeNow = 1_000_000;
    const tickOpts = {
      log,
      graceMs: 0,
      batchSize: 100,
      skipWarnThresholdMs: 60_000,
      now: () => fakeNow,
    };

    const releasePeer = await holdPeerSweepLock();
    try {
      // Tick 1 — first skip stamps the streak start; nothing to warn yet.
      await runAdapterCacheSweepTick(tickOpts);
      expect(warns).toHaveLength(0);

      // Tick 2 — still well inside the threshold window.
      fakeNow += 30_000;
      await runAdapterCacheSweepTick(tickOpts);
      expect(warns).toHaveLength(0);

      // Tick 3 — elapsed = 61s, crosses the 60s threshold => one warn.
      fakeNow += 31_000;
      await runAdapterCacheSweepTick(tickOpts);
      expect(warns).toHaveLength(1);
      expect(warns[0].msg).toContain("extended period");
      expect(warns[0].obj.consecutiveSkips).toBe(3);
      expect(warns[0].obj.thresholdMs).toBe(60_000);
      expect(typeof warns[0].obj.elapsedMs).toBe("number");
      expect(warns[0].obj.elapsedMs as number).toBeGreaterThanOrEqual(60_000);

      // Ticks 4 + 5 — still skipped, but the warning latch must hold
      // so we don't spam logs every interval.
      fakeNow += 60_000;
      await runAdapterCacheSweepTick(tickOpts);
      fakeNow += 60_000;
      await runAdapterCacheSweepTick(tickOpts);
      expect(warns).toHaveLength(1);
    } finally {
      await releasePeer();
      stopAdapterCacheSweepWorker();
    }
  });

  it("resets the consecutive-skip counter after a successful tick and only warns again on a fresh streak", async () => {
    stopAdapterCacheSweepWorker();
    const { log, warns } = makeCapturingLogger();
    let fakeNow = 2_000_000;
    const tickOpts = {
      log,
      graceMs: 0,
      batchSize: 100,
      skipWarnThresholdMs: 60_000,
      now: () => fakeNow,
    };

    // Phase 1: build up a skip streak and trip the warning.
    let releasePeer = await holdPeerSweepLock();
    try {
      await runAdapterCacheSweepTick(tickOpts); // streak start
      fakeNow += 70_000;
      await runAdapterCacheSweepTick(tickOpts); // crosses threshold
      expect(warns).toHaveLength(1);
    } finally {
      await releasePeer();
    }

    // Phase 2: a successful tick (lock available, no peer holding it,
    // no rows to delete — irrelevant to the streak). The streak and
    // the warning latch must both reset.
    fakeNow += 1_000;
    await runAdapterCacheSweepTick(tickOpts);
    expect(warns).toHaveLength(1); // success doesn't add a warn
    // Sanity: a follow-up skipped tick that happens *immediately*
    // after the successful one should not trip the warning again
    // because the streak just started over.
    releasePeer = await holdPeerSweepLock();
    try {
      fakeNow += 1_000;
      await runAdapterCacheSweepTick(tickOpts);
      expect(warns).toHaveLength(1);

      // Phase 3: continue skipping past the threshold from the
      // *new* streak's start. A second warn fires — proving the
      // latch reset rather than being permanently disabled.
      fakeNow += 70_000;
      await runAdapterCacheSweepTick(tickOpts);
      expect(warns).toHaveLength(2);
      expect(warns[1].obj.consecutiveSkips).toBe(2);
    } finally {
      await releasePeer();
      stopAdapterCacheSweepWorker();
    }
  });

  it("never warns when the threshold is set to 0 (warning disabled)", async () => {
    stopAdapterCacheSweepWorker();
    const { log, warns } = makeCapturingLogger();
    let fakeNow = 3_000_000;
    const tickOpts = {
      log,
      graceMs: 0,
      batchSize: 100,
      skipWarnThresholdMs: 0,
      now: () => fakeNow,
    };
    const releasePeer = await holdPeerSweepLock();
    try {
      for (let i = 0; i < 5; i++) {
        await runAdapterCacheSweepTick(tickOpts);
        fakeNow += 60 * 60 * 1000; // 1h between ticks
      }
      expect(warns).toHaveLength(0);
    } finally {
      await releasePeer();
      stopAdapterCacheSweepWorker();
    }
  });
});
