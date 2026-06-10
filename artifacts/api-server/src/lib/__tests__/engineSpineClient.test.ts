import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildSpineGateFrontContextFromTenant,
  EngineSpineError,
  postEngineSpine,
  SPINE_GATE_HEADERS,
} from "../engineSpineClient";

describe("engineSpineClient", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.ENGINE_API_URL = "https://engine.example.test";
    process.env.ENGINE_API_GATE_TOKEN = "test-token";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.ENGINE_API_URL;
    delete process.env.ENGINE_API_GATE_TOKEN;
  });

  it("buildSpineGateFrontContextFromTenant sets cortex product + tenant", () => {
    const ctx = buildSpineGateFrontContextFromTenant({
      packageId: "plan-review",
      jurisdictionTenant: "bastrop-tx",
    });
    expect(ctx.product).toBe("cortex");
    expect(ctx.tenantId).toBe("bastrop-tx");
    expect(ctx.packageId).toBe("plan-review");
  });

  it("postEngineSpine sends gate-front headers and bearer", async () => {
    global.fetch = vi.fn(async (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer test-token");
      expect(headers[SPINE_GATE_HEADERS.product]).toBe("cortex");
      expect(headers[SPINE_GATE_HEADERS.tenantId]).toBe("bastrop-tx");
      return new Response(JSON.stringify({ result: { findings: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const payload = await postEngineSpine<{ result: { findings: unknown[] } }>({
      path: "/v1/findings/generate",
      body: { input: {}, mode: "mock" },
      gateFront: buildSpineGateFrontContextFromTenant({
        packageId: "plan-review",
        jurisdictionTenant: "bastrop-tx",
      }),
    });

    expect(payload.result.findings).toEqual([]);
  });

  it("postEngineSpine throws when ENGINE_API_URL missing", async () => {
    delete process.env.ENGINE_API_URL;
    await expect(
      postEngineSpine({
        path: "/v1/findings/generate",
        body: {},
        gateFront: buildSpineGateFrontContextFromTenant({
          packageId: "plan-review",
          jurisdictionTenant: "default",
        }),
      }),
    ).rejects.toMatchObject({ code: "engine_api_not_configured" });
  });

  it("postEngineSpine maps 401 to EngineSpineError", async () => {
    global.fetch = vi.fn(async () => new Response("{}", { status: 401 })) as typeof fetch;

    await expect(
      postEngineSpine({
        path: "/v1/findings/generate",
        body: {},
        gateFront: buildSpineGateFrontContextFromTenant({
          packageId: "plan-review",
          jurisdictionTenant: "default",
        }),
      }),
    ).rejects.toBeInstanceOf(EngineSpineError);
  });
});
