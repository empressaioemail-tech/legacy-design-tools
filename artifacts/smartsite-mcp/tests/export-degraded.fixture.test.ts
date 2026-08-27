import { describe, expect, it } from "vitest";

import {
  buildExportHauskaDegradedPayload,
  executeExportInstrument,
  exportHauskaDegradedResult,
} from "../src/export-instrument.js";

/** WDLL P-87 item 17 export-degraded fixture — Hauska down, Smart Site otherwise healthy. */
export const EXPORT_DEGRADED_FIXTURE = {
  hauskaHealth: {
    state: "down" as const,
    latency_ms: 12,
    detail: "ECONNREFUSED",
  },
  expectedPayload: {
    status: "degraded" as const,
    tool: "export_instrument" as const,
    reason: "hauska_mcp_unavailable" as const,
    dependency: "hauska-mcp" as const,
    message:
      "Export is temporarily unavailable because Hauska MCP is unreachable. Other Smart Site tools remain available.",
    hauska: {
      state: "down" as const,
      detail: "ECONNREFUSED",
    },
  },
};

describe("export-degraded fixture (P-87 item 17)", () => {
  it("buildExportHauskaDegradedPayload matches the canonical fixture", () => {
    const payload = buildExportHauskaDegradedPayload(
      EXPORT_DEGRADED_FIXTURE.hauskaHealth,
    );
    expect(payload).toEqual(EXPORT_DEGRADED_FIXTURE.expectedPayload);
  });

  it("exportHauskaDegradedResult is tool-scoped, not server-wide down", () => {
    const result = exportHauskaDegradedResult(
      EXPORT_DEGRADED_FIXTURE.hauskaHealth,
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toEqual(EXPORT_DEGRADED_FIXTURE.expectedPayload);
    expect(parsed).not.toHaveProperty("service");
    expect(parsed.tool).toBe("export_instrument");
  });

  it("executeExportInstrument returns degraded when Hauska probe is down", async () => {
    const result = await executeExportInstrument(
      { parcelNodeId: "48021:34137", kind: "brief" },
      {
        loadConfig: () => ({
          baseUrl: "https://hauska-mcp.test",
          serviceKey: "hauska-key",
        }),
        probeHealth: async () => EXPORT_DEGRADED_FIXTURE.hauskaHealth,
        fetchHauska: async () => {
          throw new Error("fetch must not run when Hauska is down");
        },
      },
    );

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toEqual(EXPORT_DEGRADED_FIXTURE.expectedPayload);
  });

  it("executeExportInstrument proxies Hauska when reachable", async () => {
    const result = await executeExportInstrument(
      { parcelNodeId: "48021:34137", kind: "dossier" },
      {
        loadConfig: () => ({ baseUrl: "https://hauska-mcp.test" }),
        probeHealth: async () => ({
          state: "ok",
          latency_ms: 4,
          detail: "HTTP 200",
        }),
        fetchHauska: async () =>
          new Response(JSON.stringify({ exportId: "exp-1", status: "started" }), {
            status: 200,
          }),
      },
    );

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      exportId: "exp-1",
      status: "started",
    });
  });
});
