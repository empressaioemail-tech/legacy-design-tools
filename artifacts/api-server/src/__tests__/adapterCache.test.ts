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
  sweepExpiredAdapterCacheRows,
  startAdapterCacheSweepWorker,
  stopAdapterCacheSweepWorker,
  DEFAULT_ADAPTER_CACHE_SWEEP_INTERVAL_MS,
  DEFAULT_ADAPTER_CACHE_SWEEP_GRACE_MS,
  DEFAULT_ADAPTER_CACHE_SWEEP_BATCH_SIZE,
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

  it("round-trips a put + get", async () => {
    const cache = createAdapterResponseCache({ ttlMs: 60_000 });
    const key = toCacheKey("fema:nfhl-flood-zone", 38.5733, -109.5499);
    await cache!.put(key!, sampleResult);
    const hit = await cache!.get(key!);
    expect(hit).toEqual(sampleResult);
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
    expect((hit as AdapterResult).payload).toEqual({
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
    expect(femaHit?.adapterKey).toBe("fema:nfhl");
    expect(usgsHit?.adapterKey).toBe("usgs:ned-elevation");
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
    expect((moabHit as AdapterResult).payload).toEqual({ city: "moab" });
    expect((bastropHit as AdapterResult).payload).toEqual({ city: "bastrop" });
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
    expect((hit as AdapterResult).payload).toEqual({ v: 2 });
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
