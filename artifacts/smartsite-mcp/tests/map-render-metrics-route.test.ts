import { describe, expect, it, beforeEach } from "vitest";

import { createSmartsiteMcpApp } from "../src/app.js";
import {
  recordMapRenderSent,
  resetMapRenderMetricsForTests,
} from "../src/render-metrics.js";
import { mintMapRenderReportToken } from "../src/seat-metrics-auth.js";
import { withHttpServer } from "./http-helper.js";

describe("map render metrics routes (P-456b)", () => {
  beforeEach(() => {
    resetMapRenderMetricsForTests();
    process.env.SERVICE_API_KEY = "seat-route-key";
  });

  const app = createSmartsiteMcpApp({
    authConfig: {
      workosClientId: "client_test",
      workosIssuer: "https://happy-asteroid-26.authkit.app",
      jwksUri: "https://happy-asteroid-26.authkit.app/oauth2/jwks",
      devMode: false,
    },
  });

  it("refuses GET /internal/map-render-metrics without the seat key", async () => {
    await withHttpServer(app, async (base) => {
      const res = await fetch(`${base}/internal/map-render-metrics`);
      expect(res.status).toBe(401);
    });
  });

  it("returns the same in-process store the recorder writes", async () => {
    recordMapRenderSent("claude.ai", "get_smart_site", "ok");
    await withHttpServer(app, async (base) => {
      const res = await fetch(`${base}/internal/map-render-metrics`, {
        headers: { Authorization: "Bearer seat-route-key" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        hosts: Record<string, { sent: number; unconfirmed: number }>;
      };
      expect(body.hosts["claude.ai"]?.sent).toBe(1);
      expect(body.hosts["claude.ai"]?.unconfirmed).toBe(1);
    });
  });

  it("accepts card report via HMAC report token", async () => {
    const id = recordMapRenderSent("claude.ai", "get_smart_site", "ok");
    const token = mintMapRenderReportToken(id)!;
    await withHttpServer(app, async (base) => {
      const post = await fetch(`${base}/internal/map-render-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          correlationId: id,
          reportToken: token,
          outcome: "drawn",
          reasonCode: "ok",
        }),
      });
      expect(post.status).toBe(204);
      const snap = await fetch(`${base}/internal/map-render-metrics`, {
        headers: { Authorization: "Bearer seat-route-key" },
      });
      const body = (await snap.json()) as {
        hosts: Record<string, { drawn: number; unconfirmed: number }>;
      };
      expect(body.hosts["claude.ai"]?.drawn).toBe(1);
      expect(body.hosts["claude.ai"]?.unconfirmed).toBe(0);
    });
  });
});
