/**
 * /api/admin/adapter-cache/* — operator-triggered cache surface.
 *
 * Covers the sweep endpoint (Task #217) and the read-side stats
 * endpoint (Task #234) together since they share the same auth gate
 * and the same schema-redirect plumbing.
 *
 * For each endpoint we exercise:
 *   1. The permission gate — a session without `settings:manage` gets
 *      a 403 before the handler runs (mirrors `reviewers.test.ts` /
 *      the `requireSettingsManage` pattern).
 *   2. The handler actually reflects the table state (deletes for
 *      the sweep, counts for the stats).
 *
 * Schema is wired the same way as `adapterCache.test.ts` — the route
 * imports `db` from `@workspace/db`, which we redirect at the module
 * boundary to the per-test schema on `ctx.schema.db`.
 */

import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("adapterCache-route.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { adapterResponseCache } = await import("@workspace/db");
const { eq } = await import("drizzle-orm");
const { toCacheKey } = await import("@workspace/adapters");
const { createAdapterResponseCache } = await import("../lib/adapterCache");
import type { AdapterResult } from "@workspace/adapters";

/**
 * Standing-in for an authenticated admin: the dev session middleware
 * honours `x-permissions` outside production, so attaching this header
 * is enough to satisfy the `settings:manage` gate without minting a
 * real cookie.
 */
const ADMIN_HEADERS = { "x-permissions": "settings:manage" } as const;

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

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

describe("POST /api/admin/adapter-cache/sweep — permission gate", () => {
  it("rejects a caller without the settings:manage claim", async () => {
    const res = await request(getApp()).post("/api/admin/adapter-cache/sweep");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Requires settings:manage permission");
  });

  it("rejects a caller with unrelated permissions only", async () => {
    // Guards against an over-broad check (e.g. truthy `permissions`
    // array) — the gate must look for the specific claim.
    const res = await request(getApp())
      .post("/api/admin/adapter-cache/sweep")
      .set("x-permissions", "users:manage,reviewers:manage");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Requires settings:manage permission");
  });
});

describe("POST /api/admin/adapter-cache/sweep — sweep behaviour", () => {
  it("returns 200 with deleted=0 when nothing is expired", async () => {
    // Seed a fresh row so we can also assert it survives the sweep.
    const cache = createAdapterResponseCache({ ttlMs: 60_000 });
    const key = toCacheKey("fema:nfhl-flood-zone", 38.5733, -109.5499);
    await cache!.put(key!, sampleResult);

    const res = await request(getApp())
      .post("/api/admin/adapter-cache/sweep")
      .set(ADMIN_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 0 });

    const rows = await ctx.schema!.db.select().from(adapterResponseCache);
    expect(rows).toHaveLength(1);
  });

  it("deletes expired rows past the grace window and returns the count", async () => {
    const cache = createAdapterResponseCache({ ttlMs: 60_000 });
    // Three distinct rows so the count assertion is meaningful (a
    // single-row case would still pass with an off-by-one bug that
    // returns "did anything happen?" rather than the actual count).
    for (let i = 0; i < 3; i++) {
      const k = toCacheKey(
        "fema:nfhl-flood-zone",
        38.5 + i * 0.001,
        -109.5,
      );
      await cache!.put(k!, sampleResult);
    }
    // Push every row well past the default 1h grace window so the
    // sweep — which we call without overrides, exercising the env
    // defaults — actually picks them up.
    await ctx.schema!.db
      .update(adapterResponseCache)
      .set({ expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000) });

    const res = await request(getApp())
      .post("/api/admin/adapter-cache/sweep")
      .set(ADMIN_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 3 });

    const rows = await ctx.schema!.db.select().from(adapterResponseCache);
    expect(rows).toHaveLength(0);
  });
});

describe("GET /api/admin/adapter-cache/stats — permission gate", () => {
  it("rejects a caller without the settings:manage claim", async () => {
    const res = await request(getApp()).get("/api/admin/adapter-cache/stats");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Requires settings:manage permission");
  });

  it("rejects a caller with unrelated permissions only", async () => {
    const res = await request(getApp())
      .get("/api/admin/adapter-cache/stats")
      .set("x-permissions", "users:manage,reviewers:manage");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Requires settings:manage permission");
  });
});

describe("GET /api/admin/adapter-cache/stats — counts", () => {
  it("returns zeroes when the cache table is empty", async () => {
    const res = await request(getApp())
      .get("/api/admin/adapter-cache/stats")
      .set(ADMIN_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 0, expired: 0 });
  });

  it("reports total and expired counts that reflect the table state", async () => {
    const cache = createAdapterResponseCache({ ttlMs: 60_000 });
    // Seed five fresh rows under distinct cache keys so the unique
    // index doesn't collapse them into one.
    for (let i = 0; i < 5; i++) {
      const k = toCacheKey(
        "fema:nfhl-flood-zone",
        38.5 + i * 0.001,
        -109.5,
      );
      await cache!.put(k!, sampleResult);
    }
    // Force two of them past their `expires_at` so the "currently-
    // expired" subset is non-trivial — the stats helper uses the same
    // `<= now()` boundary the read path does, not the grace window
    // the sweep applies, so backdating just `expires_at` is enough.
    const allRows = await ctx.schema!.db.select().from(adapterResponseCache);
    const past = new Date(Date.now() - 60_000);
    for (const row of allRows.slice(0, 2)) {
      await ctx.schema!.db
        .update(adapterResponseCache)
        .set({ expiresAt: past })
        .where(eq(adapterResponseCache.id, row.id));
    }

    const res = await request(getApp())
      .get("/api/admin/adapter-cache/stats")
      .set(ADMIN_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 5, expired: 2 });
  });
});
