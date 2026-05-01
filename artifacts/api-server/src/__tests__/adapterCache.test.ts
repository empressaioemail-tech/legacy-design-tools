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
const { createAdapterResponseCache, getAdapterCacheTtlMs } = await import(
  "../lib/adapterCache"
);
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
