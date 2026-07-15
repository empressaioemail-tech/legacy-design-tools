/**
 * Operator run-state status endpoint — the command center's Run Monitor
 * backing API.
 *
 * Asserts the honest contract:
 *   - `/api/internal/qa/run-state` is Bearer-gated (anonymous / wrong key → 401).
 *   - `/api/brokerage/v1/operator/warming/status` serves the same projection
 *     via the brokerageV1 service-token path.
 *   - With NO run-state (empty report_run + empty place_layer_snapshots) the
 *     projection is honestly empty: status "empty", harness "not-scheduled",
 *     compute cost null (never a fabricated number).
 *   - Real report_run rows surface as `recentRuns` and drive status "ok".
 *   - place_layer_snapshots distinct places drive `parcelsWarmed`; error-status
 *     report_run rows drive `adapterFailures`.
 *
 * Uses the real-PG route harness (withTestSchema via setup.ts). Requires
 * TEST_DATABASE_URL / DATABASE_URL — CI-authoritative when unset.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";
import { db, placeLayerSnapshots } from "@workspace/db";
import {
  markReportRunError,
  markReportRunOk,
  markReportRunRunning,
} from "../lib/reportRunState";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) {
        throw new Error("operatorRunState.test: ctx.schema not set");
      }
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { __resetServiceApiKeyCacheForTests } = await import(
  "../lib/serviceToken"
);

const TEST_SERVICE_TOKEN = "test-run-state-service-token-xyz";

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

const INTERNAL_PATH = "/api/internal/qa/run-state";
const BROKERAGE_PATH = "/api/brokerage/v1/operator/warming/status";
const serviceAuth = { Authorization: `Bearer ${TEST_SERVICE_TOKEN}` };

beforeEach(() => {
  process.env.SERVICE_API_KEY = TEST_SERVICE_TOKEN;
  __resetServiceApiKeyCacheForTests();
});

async function seedSnapshot(placeKey: string, adapterKey: string): Promise<void> {
  await db.insert(placeLayerSnapshots).values({
    placeKey,
    adapterKey,
    latRounded: "30.10000",
    lngRounded: "-97.30000",
    payloadJson: { warmed: true },
    contentHash: `${placeKey}:${adapterKey}`,
  });
}

describe("GET /api/internal/qa/run-state — auth gate", () => {
  it("rejects an anonymous request with 401", async () => {
    const res = await request(getApp()).get(INTERNAL_PATH);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
  });

  it("rejects a wrong bearer token with 401", async () => {
    const res = await request(getApp())
      .get(INTERNAL_PATH)
      .set({ Authorization: "Bearer not-the-token" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
  });

  it("accepts the correct service bearer token with 200", async () => {
    const res = await request(getApp()).get(INTERNAL_PATH).set(serviceAuth);
    expect(res.status).toBe(200);
  });
});

describe("run-state projection — honest empty when nothing runs", () => {
  it("reports empty status + not-scheduled harness + null compute cost", async () => {
    const res = await request(getApp()).get(INTERNAL_PATH).set(serviceAuth);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("empty");
    expect(res.body.harness).toMatchObject({
      scheduled: false,
      status: "not-scheduled",
      lastRunAt: null,
    });
    // Compute cost is never fabricated — null when no per-run cost is recorded.
    expect(res.body.computeCostUsd).toBeNull();
    expect(res.body.computeBudgetUsd).toBeNull();
    expect(res.body.parcelsWarmed).toBe(0);
    expect(res.body.adapterFailures).toBe(0);
    expect(res.body.recentRuns).toEqual([]);
  });
});

describe("run-state projection — real report_run rows drive recentRuns", () => {
  const engagementId = "11111111-1111-4111-8111-111111111111";

  beforeEach(async () => {
    await markReportRunRunning(
      engagementId,
      "drainage",
      "gen-run-1",
      Date.now(),
      ctx.schema!.db,
    );
    await markReportRunOk(
      engagementId,
      "subsurface",
      "gen-ok-1",
      { status: "ok" },
      {},
      ctx.schema!.db,
    );
    await markReportRunError(
      engagementId,
      "topography",
      "no-geocode",
      "address did not geocode",
      "gen-err-1",
      ctx.schema!.db,
    );
  });

  it("surfaces the three runs and flips status to ok", async () => {
    const res = await request(getApp()).get(INTERNAL_PATH).set(serviceAuth);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.recentRuns).toHaveLength(3);

    const byType = Object.fromEntries(
      (res.body.recentRuns as { reportType: string; status: string }[]).map(
        (r) => [r.reportType, r.status],
      ),
    );
    expect(byType).toEqual({
      drainage: "running",
      subsurface: "ok",
      topography: "error",
    });

    // The one error row is the only adapterFailure; triage counts mirror it.
    expect(res.body.adapterFailures).toBe(1);
    expect(res.body.triageCounts).toEqual({ running: 1, ok: 1, error: 1 });

    // Each recentRun carries its composite id + real generation id.
    const drainage = (res.body.recentRuns as { reportType: string }[]).find(
      (r) => r.reportType === "drainage",
    ) as Record<string, unknown>;
    expect(drainage.id).toBe(`${engagementId}:drainage`);
    expect(drainage.runId).toBe("gen-run-1");
  });

  it("serves the identical projection via the brokerageV1 operator path", async () => {
    const res = await request(getApp()).get(BROKERAGE_PATH).set(serviceAuth);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.recentRuns).toHaveLength(3);
    expect(res.body.harness.status).toBe("not-scheduled");
  });
});

describe("run-state projection — place_layer_snapshots drive parcelsWarmed", () => {
  it("counts DISTINCT places (not rows) and flips status to ok", async () => {
    // Two places, one with two adapter rows → distinct place count is 2.
    await seedSnapshot("coord:30.1000,-97.3000", "cotality:parcels");
    await seedSnapshot("coord:30.1000,-97.3000", "cotality:zoning");
    await seedSnapshot("coord:30.2000,-97.4000", "cotality:parcels");

    const res = await request(getApp()).get(INTERNAL_PATH).set(serviceAuth);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.parcelsWarmed).toBe(2);
    expect(res.body.parcelsTracked).toBe(2);
    expect(res.body.parcelsWarmedPct).toBe(100);
    // No report_run rows seeded here → recentRuns still honestly empty.
    expect(res.body.recentRuns).toEqual([]);
  });
});
