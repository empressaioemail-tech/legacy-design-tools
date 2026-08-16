/**
 * G-60 remount proxy. Queue on cortex /api/plan-review hits plan-review
 * Cloud Run. Cortex-api is refused as the backend host. Not a 404.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

vi.mock("../middlewares/serviceAuth", () => ({
  requireServiceTokenOrSession: (
    _req: unknown,
    _res: unknown,
    next: () => void,
  ) => next(),
}));

const { default: planReviewProxyRouter, planReviewBackendUrl } = await import(
  "./planReviewProxy"
);

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/plan-review", planReviewProxyRouter);
  return app;
}

describe("planReviewBackendUrl", () => {
  afterEach(() => {
    delete process.env.PLAN_REVIEW_BACKEND_URL;
  });

  it("refuses cortex-api as the plan-review host", () => {
    process.env.PLAN_REVIEW_BACKEND_URL =
      "https://cortex-api-tds7av26va-uc.a.run.app";
    expect(() => planReviewBackendUrl()).toThrow(/refuses cortex-api/);
  });

  it("accepts the plan-review Cloud Run host", () => {
    process.env.PLAN_REVIEW_BACKEND_URL =
      "https://plan-review-ozx33wafia-ue.a.run.app";
    expect(planReviewBackendUrl()).toBe(
      "https://plan-review-ozx33wafia-ue.a.run.app",
    );
  });
});

describe("GET /api/plan-review/queue", () => {
  beforeEach(() => {
    process.env.PLAN_REVIEW_BACKEND_URL =
      "https://plan-review-ozx33wafia-ue.a.run.app";
    process.env.PLAN_REVIEW_API_KEY = "test-token";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PLAN_REVIEW_BACKEND_URL;
    delete process.env.PLAN_REVIEW_API_KEY;
  });

  it("proxies to plan-review and stamps x-plan-review-proxied", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ total: 2, Submitted: 2 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await request(buildApp()).get("/api/plan-review/queue");
    expect(res.status).toBe(200);
    expect(res.headers["x-plan-review-proxied"]).toBe("1");
    expect(res.body).toEqual({ total: 2, Submitted: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://plan-review-ozx33wafia-ue.a.run.app/api/plan-review/queue",
    );
    expect(init.method).toBe("GET");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-token");
    expect(headers["x-plan-review-source"]).toBe("cortex-proxy");
  });

  it("returns 503 when the backend URL is missing, not 404", async () => {
    delete process.env.PLAN_REVIEW_BACKEND_URL;
    const res = await request(buildApp()).get("/api/plan-review/queue");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("plan_review_unconfigured");
  });
});

describe("mount contract in index.ts", () => {
  it("remounts plan-review as the proxy and keeps Smart Files 404", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./index.ts", import.meta.url)),
      "utf8",
    );
    const proxySrc = readFileSync(
      fileURLToPath(new URL("./planReviewProxy.ts", import.meta.url)),
      "utf8",
    );
    expect(src).toMatch(/planReviewProxyRouter/);
    expect(src).toMatch(/router\.use\("\/plan-review", planReviewProxyRouter\)/);
    expect(src).not.toMatch(
      /router\.use\("\/plan-review", planReviewBffRouter\)/,
    );
    expect(src).toMatch(/error: "unmounted"/);
    expect(src).toMatch(/Smart Files is not served by cortex-api/);
    expect(proxySrc).toMatch(/requireServiceTokenOrSession/);
  });
});
