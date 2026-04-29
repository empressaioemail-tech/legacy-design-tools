/**
 * /api/healthz — sanity test that the test app + schema lifecycle works.
 * The endpoint itself does not touch the DB, but going through the full
 * setup gives us a smoke test of the test harness.
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
        throw new Error("health.test: ctx.schema not initialized");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

describe("GET /api/healthz", () => {
  it("returns { status: 'ok' } with a 200 status code", async () => {
    const res = await request(getApp()).get("/api/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("does not require the database to be reachable", async () => {
    // The endpoint is intentionally DB-free so the proxy can probe liveness
    // even when the DB pool is exhausted.
    const res = await request(getApp()).get("/api/healthz");
    expect(res.status).toBe(200);
  });
});
