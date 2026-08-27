import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { createSmartsiteMcpApp } from "../src/app.js";
import { withHttpServer } from "./http-helper.js";

const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "probe", version: "0" },
  },
};

function authApp() {
  return createSmartsiteMcpApp({
    authConfig: {
      workosClientId: "client_test",
      workosIssuer: "https://happy-asteroid-26.authkit.app",
      jwksUri: "https://happy-asteroid-26.authkit.app/oauth2/jwks",
      devMode: false,
    },
  });
}

/** 401 bodies must not leak a public MCP catalog (tools/list or serverInfo). */
function expectNoPublicCatalog(body: unknown): void {
  const text = JSON.stringify(body);
  expect(text).not.toMatch(/tools\/list|"tools"\s*:\s*\[/);
  expect(text).not.toMatch(/serverInfo|"protocolVersion"/);
  expect(text).not.toContain("find_parcel");
}

describe("Bearer-without-OAuth fail-closed (P-87 item 11)", () => {
  beforeEach(() => {
    vi.stubEnv("SMARTSITE_MCP_DEV_MODE", "false");
    vi.stubEnv("SMARTSITE_MCP_DEV_TOKEN", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("POST /mcp with Bearer-only non-OAuth token returns 401", async () => {
    const app = authApp();
    await withHttpServer(app, async (base) => {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer sk_live_not_oauth_jwt",
        },
        body: JSON.stringify(initializeBody),
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("unauthorized");
      expect(body.reason).toBe("invalid_oauth_token");
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
      expectNoPublicCatalog(body);
    });
  });

  it("POST /mcp with expired-looking JWT fragment returns 401", async () => {
    const app = authApp();
    await withHttpServer(app, async (base) => {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization:
            "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyIn0.revoked",
        },
        body: JSON.stringify(initializeBody),
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.reason).toBe("invalid_oauth_token");
      expectNoPublicCatalog(body);
    });
  });

  it("POST /mcp with service-style Bearer never falls through to public catalog", async () => {
    const app = authApp();
    await withHttpServer(app, async (base) => {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer mcp_product_key_placeholder",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        }),
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("unauthorized");
      expectNoPublicCatalog(body);
    });
  });

  it("POST /mcp without bearer returns missing_bearer 401", async () => {
    const app = authApp();
    await withHttpServer(app, async (base) => {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(initializeBody),
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.reason).toBe("missing_bearer");
      expectNoPublicCatalog(body);
    });
  });
});
