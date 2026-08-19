/**
 * POST /api/county-ledger/recompute (SS-W7 / P-44) — the write side the
 * county ledger never had.
 *
 * Before this route the snapshot could only be refreshed by someone running
 * countyLedgerMaterializeCli --apply by hand, which is why the deployed
 * ledger sat materialized at 2026-08-14T17:41:22.500Z while work landed for
 * days afterwards and every reader saw a grid that predated it.
 *
 * THE TEST THIS FILE EXISTS FOR is "reports the store as UNMOVED under
 * dryRun". A recompute always stamps a fresh computedAt, so a route that
 * checked the object it had just built in memory would report success on a
 * write that never landed — the vacuous-verify shape. Under dryRun nothing
 * is written, so a verify that genuinely reads the STORE must say so. If
 * that assertion ever passes with the store reported as moved, the verify
 * has gone vacuous.
 *
 * Uses the real-PG route harness (withTestSchema via setup.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";
import {
  db,
  countyFacetCoverage,
  countyManifest,
  countyRail,
  countyLedgerSnapshot,
} from "@workspace/db";
import { truncateAll } from "@workspace/db/testing";

vi.mock("@workspace/db/manifest", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db/manifest")>(
      "@workspace/db/manifest",
    );
  return {
    ...actual,
    buildEffectiveCountyRailDeclaration: (
      opts?: Parameters<typeof actual.buildEffectiveCountyRailDeclaration>[0],
    ) =>
      actual.buildEffectiveCountyRailDeclaration({
        ...actual.manifestReadProbeOptions(),
        ...opts,
      }),
  };
});

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) {
        throw new Error("countyLedgerRecompute.test: ctx.schema not set");
      }
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { __resetServiceApiKeyCacheForTests } = await import("../lib/serviceToken");
const { COUNTY_LEDGER_RECOMPUTE_LOCK } = await import("../routes/countyLedger");

const TEST_SERVICE_TOKEN = "test-recompute-service-token-xyz";
const serviceAuth = { Authorization: `Bearer ${TEST_SERVICE_TOKEN}` };
const RECOMPUTE_PATH = "/api/county-ledger/recompute";

/** Mirrors withClusterSweepLock's own hash derivation, exactly. */
const LOCK_HASH_SQL = `hashtextextended($1 || '|' || current_schema(), 0)`;

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

beforeEach(() => {
  process.env.SERVICE_API_KEY = TEST_SERVICE_TOKEN;
  __resetServiceApiKeyCacheForTests();
});

afterEach(async () => {
  if (!ctx.schema) return;
  await truncateAll(ctx.schema.pool, [
    "county_facet_coverage",
    "county_manifest",
    "county_rail",
    "county_ledger_snapshot",
  ]);
});

async function seedFootprintRail(): Promise<void> {
  await db.insert(countyRail).values({
    railKey: "footprint",
    displayName: "Building footprints",
    ordinal: 8,
    kind: "derived",
    thresholdPct: "90",
    atomFamilyState: "present",
    hasWriter: true,
    declaredSource: "ML-derived default statewide",
  });
  await db.insert(countyManifest).values({
    countyFips: "48021",
    countyName: "Bastrop",
    parcelCountEst: 62399,
    rosterSchemaVersion: "test-v1",
    rosterGeneratedAt: new Date("2026-08-05T00:00:00.000Z"),
  });
}

async function storedComputedAt(): Promise<string | null> {
  const rows = (await db.select().from(countyLedgerSnapshot)) as Array<{
    computedAt: Date;
  }>;
  return rows[0]?.computedAt.toISOString() ?? null;
}

describe("POST /api/county-ledger/recompute, auth and arguments", () => {
  it("requires the service token — a heavy scan is not anonymous-triggerable", async () => {
    const res = await request(getApp()).post(RECOMPUTE_PATH).send({});
    expect(res.status).toBe(401);
    expect(await storedComputedAt()).toBeNull();
  });

  it("rejects an unknown probe mode rather than guessing one", async () => {
    const res = await request(getApp())
      .post(RECOMPUTE_PATH)
      .set(serviceAuth)
      .query({ probe: "sorta" })
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_probe");
  });
});

describe("POST /api/county-ledger/recompute, the write actually lands", () => {
  it("materializes the snapshot and verifies it by reading the STORE back", async () => {
    await seedFootprintRail();
    const res = await request(getApp())
      .post(RECOMPUTE_PATH)
      .set(serviceAuth)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.applied).toBe(true);
    expect(res.body.store.persistedAsComputed).toBe(true);
    expect(res.body.store.computedAtAfter).toBe(res.body.computedAt);
    // Not the route's own word for it: read the row directly.
    expect(await storedComputedAt()).toBe(res.body.computedAt);
  });

  it("makes the ledger GET serve the freshly computed snapshot", async () => {
    await seedFootprintRail();
    const before = await request(getApp()).get("/api/county-ledger");
    expect(before.status).toBe(503);

    const recompute = await request(getApp())
      .post(RECOMPUTE_PATH)
      .set(serviceAuth)
      .send({});
    expect(recompute.status).toBe(200);

    const after = await request(getApp()).get("/api/county-ledger");
    expect(after.status).toBe(200);
    expect(after.body.summary.computedAt).toBe(recompute.body.computedAt);
  });

  it("reports the staleness it replaced, measured from the store", async () => {
    await seedFootprintRail();
    await db.insert(countyLedgerSnapshot).values({
      id: "current",
      computedAt: new Date("2026-08-14T17:41:22.500Z"),
      payload: {
        counties: [],
        manifestCells: [],
        railCapabilities: [],
        summary: {},
      },
    });
    const res = await request(getApp())
      .post(RECOMPUTE_PATH)
      .set(serviceAuth)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.store.computedAtBefore).toBe("2026-08-14T17:41:22.500Z");
    expect(res.body.store.computedAtMovedInStore).toBe(true);
    expect(res.body.store.stalenessBeforeMs).toBeGreaterThan(0);
  });
});

describe("POST /api/county-ledger/recompute, a re-read never masquerades as a recompute", () => {
  it("dryRun reports the store UNMOVED while computedAt is fresh", async () => {
    await seedFootprintRail();
    const seeded = new Date("2026-08-14T17:41:22.500Z");
    await db.insert(countyLedgerSnapshot).values({
      id: "current",
      computedAt: seeded,
      payload: { counties: [], manifestCells: [], railCapabilities: [], summary: {} },
    });

    const res = await request(getApp())
      .post(RECOMPUTE_PATH)
      .set(serviceAuth)
      .query({ dryRun: "1" })
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(false);
    expect(res.body.dryRun).toBe(true);
    // The in-memory stamp is fresh...
    expect(Date.parse(res.body.computedAt)).toBeGreaterThan(seeded.getTime());
    // ...and the STORE is untouched. A verify that compared the computed
    // object with itself would report this as moved.
    expect(res.body.store.computedAtBefore).toBe(seeded.toISOString());
    expect(res.body.store.computedAtAfter).toBe(seeded.toISOString());
    expect(res.body.store.computedAtMovedInStore).toBe(false);
    expect(res.body.store.persistedAsComputed).toBe(false);
    expect(await storedComputedAt()).toBe(seeded.toISOString());
  });

  it("a second recompute with nothing changed reports an all-zero delta, not a win", async () => {
    await seedFootprintRail();
    const first = await request(getApp()).post(RECOMPUTE_PATH).set(serviceAuth).send({});
    expect(first.status).toBe(200);
    const second = await request(getApp()).post(RECOMPUTE_PATH).set(serviceAuth).send({});
    expect(second.status).toBe(200);

    // computedAt moved: a job ran.
    expect(second.body.computedAt).not.toBe(first.body.computedAt);
    expect(second.body.store.computedAtMovedInStore).toBe(true);
    // And nothing else did. Reported as what it is.
    expect(second.body.delta.payloadChanged).toBe(false);
    expect(second.body.delta.cells.changed).toBe(0);
    expect(second.body.delta.cells.added).toBe(0);
    expect(second.body.delta.cells.removed).toBe(0);
    expect(second.body.delta.cells.byRailKey).toEqual({});
    expect(second.body.delta.summaryChanges).toEqual([]);
  });
});

describe("POST /api/county-ledger/recompute, the delta answers the question a timestamp cannot", () => {
  it("names the rail that moved when coverage lands after a materialization", async () => {
    await seedFootprintRail();
    const first = await request(getApp()).post(RECOMPUTE_PATH).set(serviceAuth).send({});
    expect(first.status).toBe(200);
    const footprintBefore = first.body.summary.satisfiedCells;

    // The shape of the operator's complaint: a writer lands coverage AFTER
    // the ledger was materialized, and the ledger keeps reporting not-yet.
    await db.insert(countyFacetCoverage).values({
      countyFips: "48021",
      facet: "footprint",
      honestCoveragePct: "97",
      integrityVerdict: "n/a",
      classification: "real-at-ceiling",
      railState: "satisfied-present",
      thresholdPct: "90",
    });

    const stale = await request(getApp()).get("/api/county-ledger");
    expect(stale.body.manifestCells[0].displayState).toBe("not-yet");

    const second = await request(getApp()).post(RECOMPUTE_PATH).set(serviceAuth).send({});
    expect(second.status).toBe(200);
    expect(second.body.delta.payloadChanged).toBe(true);
    expect(second.body.delta.cells.changed).toBe(1);
    expect(second.body.delta.cells.byRailKey.footprint).toBe(1);
    expect(second.body.summary.satisfiedCells).toBeGreaterThan(footprintBefore);

    const fresh = await request(getApp()).get("/api/county-ledger");
    expect(fresh.body.manifestCells[0].displayState).toBe("satisfied-present");
  });

  it("measures added and removed cells from the key sets, never by subtraction", async () => {
    await seedFootprintRail();
    const first = await request(getApp()).post(RECOMPUTE_PATH).set(serviceAuth).send({});
    expect(first.body.delta.cells.after).toBe(1);
    expect(first.body.delta.cells.before).toBe(0);
    expect(first.body.delta.cells.added).toBe(1);

    await db.insert(countyManifest).values({
      countyFips: "48453",
      countyName: "Travis",
      parcelCountEst: 804458,
      rosterSchemaVersion: "test-v1",
      rosterGeneratedAt: new Date("2026-08-05T00:00:00.000Z"),
    });
    const second = await request(getApp()).post(RECOMPUTE_PATH).set(serviceAuth).send({});
    expect(second.body.delta.cells.before).toBe(1);
    expect(second.body.delta.cells.after).toBe(2);
    expect(second.body.delta.cells.added).toBe(1);
    expect(second.body.delta.cells.removed).toBe(0);
    expect(second.body.delta.cells.changed).toBe(0);
  });
});

describe("POST /api/county-ledger/recompute, capability probe skip", () => {
  it("names the skip in the payload rather than carrying a stale value forward", async () => {
    await seedFootprintRail();
    const full = await request(getApp()).post(RECOMPUTE_PATH).set(serviceAuth).send({});
    expect(full.body.probe).toBe("full");
    expect(full.body.railCapabilitiesProbeReason).toBeNull();

    const skipped = await request(getApp())
      .post(RECOMPUTE_PATH)
      .set(serviceAuth)
      .query({ probe: "skip" })
      .send({});
    expect(skipped.status).toBe(200);
    expect(skipped.body.probe).toBe("skip");
    expect(skipped.body.railCapabilitiesProbeReason).toContain("skipped by request");

    // The absence is stamped into what a reader will actually be served.
    const served = await request(getApp()).get("/api/county-ledger");
    expect(served.body.railCapabilities).toBeNull();
    expect(served.body.railCapabilitiesProbeReason).toContain("skipped by request");
  });
});

describe("POST /api/county-ledger/recompute, one heavy scan at a time", () => {
  it("answers 409 when a peer holds the cluster lock, and writes nothing", async () => {
    await seedFootprintRail();
    const peer = await ctx.schema!.pool.connect();
    try {
      await peer.query(`SELECT pg_advisory_lock(${LOCK_HASH_SQL})`, [
        COUNTY_LEDGER_RECOMPUTE_LOCK,
      ]);
      const res = await request(getApp()).post(RECOMPUTE_PATH).set(serviceAuth).send({});
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("recompute_in_progress");
      expect(await storedComputedAt()).toBeNull();
      await peer.query(`SELECT pg_advisory_unlock(${LOCK_HASH_SQL})`, [
        COUNTY_LEDGER_RECOMPUTE_LOCK,
      ]);
    } finally {
      peer.release();
    }
  });

  it("succeeds once the peer releases — the 409 is contention, not a broken route", async () => {
    await seedFootprintRail();
    const res = await request(getApp()).post(RECOMPUTE_PATH).set(serviceAuth).send({});
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
  });
});

describe("/api/county-ledger/refresh is a named tombstone, not a second name", () => {
  it("answers a named 404 on GET instead of the SPA catch-all", async () => {
    const res = await request(getApp()).get("/api/county-ledger/refresh");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_such_route");
    expect(res.body.message).toContain("/api/county-ledger/recompute");
  });

  it("answers a named 404 on POST", async () => {
    const res = await request(getApp())
      .post("/api/county-ledger/refresh")
      .set(serviceAuth)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_such_route");
  });
});
