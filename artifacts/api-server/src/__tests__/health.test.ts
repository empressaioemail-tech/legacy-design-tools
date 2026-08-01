/**
 * /api/healthz remains process-only liveness. /api/health/ready verifies the
 * database and both spine dependencies used by cortex-api.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock("@workspace/db", () => {
  return { db: { execute: executeMock } };
});

const { default: healthRouter } = await import("../routes/health");
const app = express();
app.use("/api", healthRouter);

beforeEach(() => {
  executeMock.mockReset();
  executeMock.mockResolvedValue([{ ready: 1 }]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.BRIEF_RETRIEVAL_API_URL;
});

describe("GET /api/healthz", () => {
  it("returns { status: 'ok' } with a 200 status code", async () => {
    const res = await request(app).get("/api/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("does not require the database to be reachable", async () => {
    // The endpoint is intentionally DB-free so the proxy can probe liveness
    // even when the DB pool is exhausted.
    executeMock.mockRejectedValueOnce(new Error("database unavailable"));
    const res = await request(app).get("/api/healthz");
    expect(res.status).toBe(200);
    expect(executeMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/health/ready", () => {
  function configureDependencies(): void {
    process.env.ENGINE_API_URL = "https://engine.test";
    process.env.BRIEF_RETRIEVAL_API_URL = "https://retrieval.test";
  }

  it("returns component truth when the DB and both dependencies are healthy", async () => {
    configureDependencies();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"status":"ok"}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await request(app).get("/api/health/ready");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      service: "cortex-api",
      components: {
        database: { status: "ok" },
        engineApi: { status: "ok" },
        retrievalApi: { status: "ok" },
      },
    });
    expect(res.body.checkedAt).toEqual(expect.any(String));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://engine.test/health",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://retrieval.test/health",
      expect.any(Object),
    );
  });

  it("returns 503 and identifies a failed database query", async () => {
    configureDependencies();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 })),
    );
    executeMock.mockRejectedValueOnce(new Error("database unavailable"));

    const res = await request(app).get("/api/health/ready");

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      status: "error",
      components: {
        database: { status: "error", detail: "database query failed" },
        engineApi: { status: "ok" },
        retrievalApi: { status: "ok" },
      },
    });
  });

  it("returns 503 and identifies a failed spine dependency", async () => {
    configureDependencies();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = String(input);
        return new Response(null, {
          status: url.startsWith("https://retrieval.test") ? 502 : 200,
        });
      }),
    );

    const res = await request(app).get("/api/health/ready");

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      status: "error",
      components: {
        database: { status: "ok" },
        engineApi: { status: "ok" },
        retrievalApi: {
          status: "error",
          detail: "retrieval-api health returned HTTP 502",
        },
      },
    });
  });
});
