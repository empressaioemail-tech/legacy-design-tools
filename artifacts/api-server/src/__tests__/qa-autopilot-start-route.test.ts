/**
 * Regression: POST /api/qa/autopilot/runs must return 201 with a runId
 * and persist a row in `autopilot_runs`. The runner is mocked so the
 * fire-and-forget orchestration never spawns real subprocesses.
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
        throw new Error("qa-autopilot-start-route.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

// Stub the runner so the background orchestration kicked off by
// startAutopilotRun never spawns real test subprocesses.
vi.mock("../lib/qa/runner", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/qa/runner")>(
      "../lib/qa/runner",
    );
  return {
    ...actual,
    QA_REPO_ROOT: "/tmp",
    runSuiteToCompletion: vi.fn(async () => ({
      runId: "00000000-0000-0000-0000-000000000000",
      outcome: {
        status: "passed" as const,
        exitCode: 0,
        durationMs: 1,
        log: "",
      },
    })),
  };
});

const { setupRouteTests } = await import("./setup");
const { autopilotRuns } = await import("@workspace/db");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

describe("POST /api/qa/autopilot/runs", () => {
  it("returns 201 with a runId and inserts an autopilot_runs row", async () => {
    const res = await request(getApp())
      .post("/api/qa/autopilot/runs")
      .send({ trigger: "manual" })
      .set("content-type", "application/json");

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      runId: expect.any(String),
      startedAt: expect.any(String),
    });

    const rows = await ctx.schema!.db.select().from(autopilotRuns);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(res.body.runId);
    expect(rows[0]!.trigger).toBe("manual");
    // Status is "running" at insert time but the fire-and-forget
    // orchestrator (with the mocked runner above) may flip it to
    // "completed" before this assertion runs. Either is a healthy
    // start outcome — what matters is the row exists.
    expect(["running", "completed"]).toContain(rows[0]!.status);
  });
});
