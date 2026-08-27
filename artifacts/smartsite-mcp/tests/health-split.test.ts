import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSmartsiteMcpApp } from "../src/app.js";
import { buildHealthReport } from "../src/health.js";
import { withHttpServer } from "./http-helper.js";

describe("P-87 item 17 health split", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.CORTEX_API_BASE_URL = "https://cortex.test";
    process.env.SERVICE_API_KEY = "svc-test";
    process.env.WORKOS_CLIENT_ID = "client_test";
    process.env.WORKOS_JWKS_URI = "https://authkit.test/jwks";
    process.env.HAUSKA_MCP_BASE_URL = "https://hauska-mcp.test";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("GET /health stays ok when Hauska MCP probe would fail", async () => {
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("hauska-mcp.test")) {
        throw new Error("ECONNREFUSED");
      }
      return originalFetch(input, init);
    });

    const report = buildHealthReport();
    expect(report.status).toBe("ok");
    expect(report.failureDomain).toBe("smartsite-mcp");
    expect(report).not.toHaveProperty("dependencies");

    const app = createSmartsiteMcpApp({
      authConfig: {
        workosClientId: "client_test",
        workosIssuer: "https://authkit.test",
        jwksUri: "https://authkit.test/jwks",
        devMode: false,
      },
    });

    await withHttpServer(app, async (base) => {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.service).toBe("smartsite-mcp");
      expect(body).not.toHaveProperty("dependencies");
    });
  });

  it("GET /health/dependencies reports Hauska MCP down separately", async () => {
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("hauska-mcp.test")) {
        throw new Error("ECONNREFUSED");
      }
      return originalFetch(input, init);
    });

    const app = createSmartsiteMcpApp({
      authConfig: {
        workosClientId: "client_test",
        workosIssuer: "https://authkit.test",
        jwksUri: "https://authkit.test/jwks",
        devMode: false,
      },
    });

    await withHttpServer(app, async (base) => {
      const res = await fetch(`${base}/health/dependencies`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.service).toBe("smartsite-mcp-dependencies");
      expect(body.dependencies.hauska_mcp.state).toBe("down");
      expect(body.dependencies.hauska_mcp.detail).toContain("ECONNREFUSED");
    });
  });

  it("GET /health/dependencies marks Hauska skipped when unset", async () => {
    delete process.env.HAUSKA_MCP_BASE_URL;

    const app = createSmartsiteMcpApp({
      authConfig: {
        workosClientId: "client_test",
        workosIssuer: "https://authkit.test",
        jwksUri: "https://authkit.test/jwks",
        devMode: false,
      },
    });

    await withHttpServer(app, async (base) => {
      const res = await fetch(`${base}/health/dependencies`);
      const body = await res.json();
      expect(body.dependencies.hauska_mcp.state).toBe("skipped");
    });
  });
});
