import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildEngineGateHeaders, loadEngineApiConfig } from "../src/engine-client.js";

const ENV_KEYS = [
  "HAUSKA_ENGINE_API_URL",
  "ENGINE_API_URL",
  "HAUSKA_ENGINE_API_KEY",
  "ENGINE_API_GATE_TOKEN",
] as const;

describe("engine-client (P-119 / OPS-16 A-103)", () => {
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  it("loadEngineApiConfig returns null when neither base URL nor gate token is configured — the starved shape (mirrors P-109's HAUSKA_MCP_BASE_URL finding)", () => {
    expect(loadEngineApiConfig()).toBeNull();
  });

  it("returns null when only the URL is set (a gate token is still required)", () => {
    process.env.HAUSKA_ENGINE_API_URL = "https://engine.test";
    expect(loadEngineApiConfig()).toBeNull();
  });

  it("returns null when only the gate token is set (a base URL is still required)", () => {
    process.env.HAUSKA_ENGINE_API_KEY = "key-123";
    expect(loadEngineApiConfig()).toBeNull();
  });

  it("resolves with both HAUSKA_-prefixed names set, and trims a trailing slash", () => {
    process.env.HAUSKA_ENGINE_API_URL = "https://engine.test/";
    process.env.HAUSKA_ENGINE_API_KEY = "key-123";
    expect(loadEngineApiConfig()).toEqual({
      baseUrl: "https://engine.test",
      gateToken: "key-123",
    });
  });

  it("falls back to hauska-map's own env var names (ENGINE_API_URL / ENGINE_API_GATE_TOKEN) when the HAUSKA_-prefixed ones are absent — the same credential provisioned for one BFF clears the other", () => {
    process.env.ENGINE_API_URL = "https://engine-fallback.test";
    process.env.ENGINE_API_GATE_TOKEN = "fallback-key";
    expect(loadEngineApiConfig()).toEqual({
      baseUrl: "https://engine-fallback.test",
      gateToken: "fallback-key",
    });
  });

  it("buildEngineGateHeaders carries the pinned gate-front header shape with a stable connector credential id", () => {
    const headers = buildEngineGateHeaders({ packageId: "feasibility-export" });
    expect(headers).toMatchObject({
      "x-hauska-product": "cortex",
      "x-hauska-tenant-id": "public-catalog",
      "x-hauska-package-id": "feasibility-export",
      "x-hauska-access-tier": "public-paid",
      "x-hauska-gate-credential-id": "smartsite-mcp-feasibility",
    });
    expect(headers["x-hauska-request-id"]).toBeTruthy();
  });

  it("a supplied requestId is used verbatim instead of generating one", () => {
    const headers = buildEngineGateHeaders({
      packageId: "feasibility-export",
      requestId: "req-fixed-1",
    });
    expect(headers["x-hauska-request-id"]).toBe("req-fixed-1");
  });

  it("two calls with no requestId supplied generate distinct ids", () => {
    const a = buildEngineGateHeaders({ packageId: "feasibility-export" });
    const b = buildEngineGateHeaders({ packageId: "feasibility-export" });
    expect(a["x-hauska-request-id"]).not.toBe(b["x-hauska-request-id"]);
  });
});
