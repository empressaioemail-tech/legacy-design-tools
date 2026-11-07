/**
 * app.ts JSON error boundary. No /api route may answer with the finalhandler
 * HTML page: an MCP caller passes that page through verbatim with
 * isError: true, and outside production DrizzleQueryError embeds SQL and
 * params in it.
 *
 * Express is ^5 (resolved 5.2.1): a rejected async handler is forwarded to
 * the error stack by the framework, so the async case here proves no wrapper
 * is needed. The real router is replaced by three fixture routes; the module
 * side effects of app.ts (queue worker, sweeps, SPA static) are stubbed.
 */

import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import type { NextFunction, Request, Response } from "express";

const log = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("@workspace/codes", () => ({ startQueueWorker: () => {} }));
vi.mock("../lib/briefingGenerationJobsSweep", () => ({
  startBriefingGenerationJobsSweep: () => {},
}));
vi.mock("../lib/findingRunsSweep", () => ({ startFindingRunsSweep: () => {} }));
vi.mock("../lib/terrainGenerationJobsSweep", () => ({
  startTerrainJobsSweep: () => {},
}));
vi.mock("../lib/adapterCache", () => ({
  startAdapterCacheSweepWorker: () => {},
}));
vi.mock("../middlewares/session", () => ({
  DEFAULT_TENANT_ID: "default",
  sessionMiddleware: (_req: Request, _res: Response, next: NextFunction) =>
    next(),
}));
vi.mock("../middlewares/userRateLimit", () => ({
  userRateLimitMiddleware: (
    _req: Request,
    _res: Response,
    next: NextFunction,
  ) => next(),
}));
vi.mock("../middlewares/spaStatic", () => ({ mountSpaStatic: () => {} }));
vi.mock("../routes/brokerageBilling", () => ({
  stripeWebhookHandler: async () => {},
}));
vi.mock("pino-http", () => ({
  default: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock("../lib/logger", () => ({ logger: log }));
vi.mock("../routes", async () => {
  const { Router } = await import("express");
  const router = Router();
  router.get("/boundary-test/throws", () => {
    throw new Error("sync boom");
  });
  router.get("/boundary-test/rejects", async () => {
    await Promise.resolve();
    throw new Error("async boom");
  });
  router.post("/boundary-test/echo", (req: Request, res: Response) => {
    res.json({ got: req.body });
  });
  return { default: router };
});

const { default: app } = await import("../app");

describe("/api JSON error boundary", () => {
  it("a handler that throws answers 500 JSON internal_error, not HTML", async () => {
    log.error.mockClear();
    const res = await request(app).get("/api/boundary-test/throws");
    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: "internal_error" });
    expect(res.text).not.toMatch(/<html|<pre>/i);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]?.[0]).toMatchObject({
      path: "/api/boundary-test/throws",
      method: "GET",
    });
  });

  it("an async handler that rejects reaches the same boundary (Express 5 forwards it)", async () => {
    log.error.mockClear();
    const res = await request(app).get("/api/boundary-test/rejects");
    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: "internal_error" });
    expect(log.error.mock.calls[0]?.[0]).toMatchObject({
      path: "/api/boundary-test/rejects",
    });
  });

  it("a malformed JSON body stays a 400 and is JSON, never HTML and never a fabricated 500", async () => {
    const res = await request(app)
      .post("/api/boundary-test/echo")
      .set("content-type", "application/json")
      .send('{"bad json');
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: "bad_request", type: "entity.parse.failed" });
  });

  it("a healthy route is untouched", async () => {
    const res = await request(app)
      .post("/api/boundary-test/echo")
      .send({ ok: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ got: { ok: 1 } });
  });
});
