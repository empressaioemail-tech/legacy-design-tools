import { describe, expect, it } from "vitest";

import { createSmartsiteMcpApp } from "../src/app.js";
import { SMARTSITE_MCP_TOOLS } from "../src/constants.js";
import { withHttpServer } from "./http-helper.js";

describe("smartsite-mcp HTTP surface", () => {
  const app = createSmartsiteMcpApp({
    authConfig: {
      workosClientId: "client_test",
      workosIssuer: "https://happy-asteroid-26.authkit.app",
      jwksUri: "https://happy-asteroid-26.authkit.app/oauth2/jwks",
      devMode: false,
    },
  });

  it("GET /health returns liveness JSON", async () => {
    await withHttpServer(app, async (base) => {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        service: "smartsite-mcp",
        name: "Smart Site",
        failureDomain: "smartsite-mcp",
      });
      expect(body.status).toMatch(/^(ok|degraded)$/);
      expect(body).not.toHaveProperty("dependencies");
    });
  });

  it("GET /health/dependencies exposes Hauska MCP separately", async () => {
    await withHttpServer(app, async (base) => {
      const res = await fetch(`${base}/health/dependencies`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.service).toBe("smartsite-mcp-dependencies");
      expect(body.dependencies).toHaveProperty("hauska_mcp");
    });
  });

  it("GET /llms.txt lists exactly thirteen tools", async () => {
    await withHttpServer(app, async (base) => {
      const res = await fetch(`${base}/llms.txt`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("Tools (13):");
      for (const tool of SMARTSITE_MCP_TOOLS) {
        expect(text).toContain(tool.name);
      }
      const toolNameMatches = text.match(/`([a-z_]+)`/g) ?? [];
      const listedNames = toolNameMatches.map((m) => m.replace(/`/g, ""));
      const catalogNames = SMARTSITE_MCP_TOOLS.map((t) => t.name);
      expect(
        listedNames.filter((n) =>
          catalogNames.includes(n as (typeof catalogNames)[number]),
        ),
      ).toHaveLength(13);
    });
  });

  it("GET /.well-known/oauth-protected-resource has required shape", async () => {
    await withHttpServer(app, async (base) => {
      const res = await fetch(`${base}/.well-known/oauth-protected-resource`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        resource: "https://mcp.smartsite.cloud/mcp",
        authorization_servers: ["https://happy-asteroid-26.authkit.app"],
        bearer_methods_supported: ["header"],
      });
    });
  });

  it("POST /mcp without bearer returns 401 fail-closed", async () => {
    await withHttpServer(app, async (base) => {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "probe", version: "0" },
          },
        }),
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("unauthorized");
      expect(body.reason).toBe("missing_bearer");
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
    });
  });
});
