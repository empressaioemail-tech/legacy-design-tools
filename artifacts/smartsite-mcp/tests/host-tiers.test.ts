import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { applyHostTierToResult } from "../src/host-tier-result.js";
import { resetHostSessionsForTests, ingestHostSessionFromBody } from "../src/host-ui-capability.js";
import { validateMcpCardToken } from "../src/mcp-card-link.js";
import { resetMapRenderMetricsForTests, snapshotMapRenderMetrics } from "../src/render-metrics.js";

describe("P-447 host tiers", () => {
  beforeEach(() => {
    process.env.PE_SHARE_SECRET = "test-share-secret";
    resetHostSessionsForTests();
    resetMapRenderMetricsForTests();
  });

  afterEach(() => {
    delete process.env.PE_SHARE_SECRET;
  });

  it("ui-capable session keeps resource_link and adds cardPageLink", () => {
    const session = ingestHostSessionFromBody("user-1", {
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        clientInfo: { name: "claude-ai" },
        capabilities: { extensions: { "io.modelcontextprotocol/ui": {} } },
      },
    });
    expect(session.uiCapable).toBe(true);

    const raw = JSON.stringify({
      parcelNodeId: "48021:34137",
      brief: {
        sections: [
          { id: "zoning", title: "Zoning", disposition: "present", data: { district: "SF-1" } },
        ],
      },
    });
    const result = applyHostTierToResult(
      "get_smart_site",
      {
        content: [
          { type: "text", text: raw },
          { type: "resource_link", uri: "ui://x", name: "board", mimeType: "text/html" },
        ],
      },
      session,
      "user-1",
    );
    const jsonPart = result.content.find(
      (p) => p.type === "text" && typeof p.text === "string" && p.text.includes("cardPageLink"),
    );
    expect(jsonPart).toBeTruthy();
    expect(result.content.some((p) => p.type === "resource_link")).toBe(true);
    const metrics = snapshotMapRenderMetrics();
    expect(metrics["claude-ai"]?.byUiCapable.true).toBe(1);
  });

  it("text-only session gets reading layout and no resource_link", () => {
    const session = ingestHostSessionFromBody("user-1", {
      jsonrpc: "2.0",
      method: "initialize",
      params: { clientInfo: { name: "mcp-inspector" }, capabilities: {} },
    });
    expect(session.uiCapable).toBe(false);

    const raw = JSON.stringify({
      parcelNodeId: "48021:34137",
      brief: {
        sections: [
          { id: "zoning", title: "Zoning", disposition: "present", data: { district: "SF-1" } },
        ],
      },
    });
    const result = applyHostTierToResult(
      "get_smart_site",
      {
        content: [{ type: "text", text: raw }, { type: "resource_link", uri: "ui://x" }],
      },
      session,
      "user-1",
    );
    expect(result.content[0]?.type).toBe("text");
    expect(String(result.content[0]?.text)).toContain("Open this answer as a web page");
    expect(result.content.some((p) => p.type === "resource_link")).toBe(false);
  });

  it("minted card token validates and refuses tamper by name", () => {
    const session = { clientName: "claude-ai", uiCapable: true };
    const raw = JSON.stringify({ parcelNodeId: "48021:34137" });
    const result = applyHostTierToResult(
      "get_smart_site",
      { content: [{ type: "text", text: raw }] },
      session,
      "user-1",
    );
    const enriched = result.content.find((p) => p.type === "text" && String(p.text).includes("cardPageLink"));
    const data = JSON.parse(String(enriched?.text)) as { cardPageLink: string };
    const token = data.cardPageLink.split("#")[1] ?? "";
    const ok = validateMcpCardToken(token, "test-share-secret");
    expect(ok.ok).toBe(true);
    const bad = validateMcpCardToken(`${token}x`, "test-share-secret");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe("tampered");
  });
});
