import { describe, expect, it, beforeEach } from "vitest";

import { noteMcpClientFromInitializeBody } from "../src/mcp-client-context.js";
import { resetMcpClientContextForTests } from "../src/mcp-client-context.js";
import {
  recordMapRenderCardReport,
  recordMapRenderNoMap,
  recordMapRenderSent,
  resetMapRenderMetricsForTests,
  snapshotMapRenderMetrics,
} from "../src/render-metrics.js";
import {
  mintMapRenderReportToken,
  verifyMapRenderReportToken,
} from "../src/seat-metrics-auth.js";

describe("map render metrics (P-456b)", () => {
  beforeEach(() => {
    resetMapRenderMetricsForTests();
    resetMcpClientContextForTests();
    process.env.SERVICE_API_KEY = "seat-test-key";
  });

  it("counts sent as unconfirmed until the card reports drawn", () => {
    const id = recordMapRenderSent("claude.ai", "get_smart_site", "ok");
    let snap = snapshotMapRenderMetrics();
    expect(snap["claude.ai"]?.sent).toBe(1);
    expect(snap["claude.ai"]?.unconfirmed).toBe(1);
    expect(snap["claude.ai"]?.drawn).toBe(0);

    recordMapRenderCardReport({
      correlationId: id,
      outcome: "drawn",
      reasonCode: "ok",
      tool: "get_smart_site",
    });
    snap = snapshotMapRenderMetrics();
    expect(snap["claude.ai"]?.unconfirmed).toBe(0);
    expect(snap["claude.ai"]?.drawn).toBe(1);
  });

  it("counts a planted widget failure with its reason", () => {
    const id = recordMapRenderSent("claude.ai", "find_parcel", "ok");
    recordMapRenderCardReport({
      correlationId: id,
      outcome: "failed",
      reasonCode: "render_threw",
    });
    const snap = snapshotMapRenderMetrics();
    expect(snap["claude.ai"]?.failed).toBe(1);
    expect(snap["claude.ai"]?.byReason["failed:render_threw"]).toBe(1);
  });

  it("leaves sent unconfirmed when the card never reports", () => {
    recordMapRenderSent("claude-desktop", "get_smart_site", "ok");
    const snap = snapshotMapRenderMetrics();
    expect(snap["claude-desktop"]?.sent).toBe(1);
    expect(snap["claude-desktop"]?.unconfirmed).toBe(1);
    expect(snap["claude-desktop"]?.drawn).toBe(0);
  });

  it("keys by real host from initialize clientInfo, not user id", () => {
    noteMcpClientFromInitializeBody("user-hash-abc", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "claude-ai", version: "0.1.0" },
      },
    });
    recordMapRenderSent("claude.ai", "get_smart_site", "ok");
    const snap = snapshotMapRenderMetrics();
    expect(snap["claude.ai"]?.sent).toBe(1);
    expect(snap["user-hash-abc"]).toBeUndefined();
  });

  it("records no_map without unconfirmed sent", () => {
    recordMapRenderNoMap("other", "find_parcel", "map_wiring_failed");
    const snap = snapshotMapRenderMetrics();
    expect(snap.other?.no_map).toBe(1);
    expect(snap.other?.sent).toBe(0);
    expect(snap.other?.unconfirmed).toBe(0);
  });

  it("mints a one-shot report token verifiable without exposing the seat key", () => {
    const id = recordMapRenderSent("claude.ai", "get_smart_site", "ok");
    const token = mintMapRenderReportToken(id);
    expect(token).toBeTruthy();
    expect(verifyMapRenderReportToken(id, token!)).toBe(true);
    expect(verifyMapRenderReportToken(id, "wrong")).toBe(false);
  });
});
