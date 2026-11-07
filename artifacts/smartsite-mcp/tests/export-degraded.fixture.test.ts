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
      { parcelNodeId: "48021:34137", kind: "siteplan" },
      {
        loadConfig: () => ({
          baseUrl: "https://hauska-mcp.test",
          serviceKey: "hauska-key",
        }),
        probeHealth: async () => EXPORT_DEGRADED_FIXTURE.hauskaHealth,
        callTool: async () => {
          throw new Error("callTool must not run when Hauska is down");
        },
      },
    );

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toEqual(EXPORT_DEGRADED_FIXTURE.expectedPayload);
  });

  // P-110: the real two-hop contract — refresh then download, snake_case
  // upstream tool names, no poll loop (mirrors hauska-map's already-live
  // BFF, which treats refresh as synchronous rather than an async job).
  it("executeExportInstrument refreshes then downloads, and returns the download payload", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const result = await executeExportInstrument(
      { parcelNodeId: "48021:34137", kind: "dossier" },
      {
        loadConfig: () => ({ baseUrl: "https://hauska-mcp.test", serviceKey: "k" }),
        probeHealth: async () => ({ state: "ok", latency_ms: 4, detail: "HTTP 200" }),
        callTool: async (_config, name, args) => {
          calls.push({ name, args });
          if (name === "refresh_parcel_dossier_export") {
            return { data: { status: "refreshed" }, isError: false };
          }
          if (name === "download_parcel_dossier_export") {
            return { data: { exportId: "exp-1", base64: "AA==" }, isError: false };
          }
          throw new Error(`unexpected tool: ${name}`);
        },
      },
    );

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      exportId: "exp-1",
      base64: "AA==",
    });
    expect(calls.map((c) => c.name)).toEqual([
      "refresh_parcel_dossier_export",
      "download_parcel_dossier_export",
    ]);
    // Dossier's format is fixed and required on refresh, but hauska-map's own
    // dossier download call omits format entirely — only site plan and
    // terrain need it on download (see the live-bug test below).
    expect(calls[0]!.args).toEqual({
      parcel_node_id: "48021:34137",
      format: "pdf-dossier",
    });
    expect(calls[1]!.args).toEqual({ parcel_node_id: "48021:34137" });
  });

  it("executeExportInstrument maps siteplan to the site_plan upstream tool name", async () => {
    const names: string[] = [];
    await executeExportInstrument(
      { parcelNodeId: "48021:34137", kind: "siteplan" },
      {
        loadConfig: () => ({ baseUrl: "https://hauska-mcp.test", serviceKey: "k" }),
        probeHealth: async () => ({ state: "ok", latency_ms: 4, detail: "HTTP 200" }),
        callTool: async (_config, name) => {
          names.push(name);
          return { data: {}, isError: false };
        },
      },
    );
    expect(names).toEqual([
      "refresh_parcel_site_plan_export",
      "download_parcel_site_plan_export",
    ]);
  });

  // P-110 LIVE BUG (found 2026-09-04 against the real hauska-mcp-server,
  // parcel 48021:34137, kind siteplan): download_parcel_site_plan_export
  // rejected the call with MCP error -32602, "Invalid arguments ... format:
  // Required" — refresh had succeeded WITHOUT format, so the missing field
  // only surfaced on the second hop. export_instrument takes no format
  // argument from the calling agent (it has no way to discover the upstream
  // format enum), so both hops must default it per kind — matching
  // hauska-map's own proven defaults exactly (pe-site-plan-export.ts:
  // `?? 'pdf-site-plan'`; pe-terrain-export.ts: `?? 'glb'`). This test would
  // have caught the bug: the mocked callTool in the tests above never
  // enforced upstream schema strictness the way the real server does.
  it("executeExportInstrument sends the default format on BOTH hops for siteplan and terrain", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const callTool = async (
      _config: unknown,
      name: string,
      args: Record<string, unknown>,
    ) => {
      calls.push({ name, args });
      return { data: {}, isError: false };
    };
    const deps = {
      loadConfig: () => ({ baseUrl: "https://hauska-mcp.test", serviceKey: "k" }),
      probeHealth: async () => ({ state: "ok" as const, latency_ms: 4, detail: "HTTP 200" }),
      callTool,
    };

    await executeExportInstrument({ parcelNodeId: "48021:34137", kind: "siteplan" }, deps);
    expect(calls).toEqual([
      {
        name: "refresh_parcel_site_plan_export",
        args: { parcel_node_id: "48021:34137", format: "pdf-site-plan" },
      },
      {
        name: "download_parcel_site_plan_export",
        args: { parcel_node_id: "48021:34137", format: "pdf-site-plan" },
      },
    ]);

    calls.length = 0;
    await executeExportInstrument({ parcelNodeId: "48021:34137", kind: "terrain" }, deps);
    expect(calls).toEqual([
      {
        name: "refresh_parcel_terrain_export",
        args: { parcel_node_id: "48021:34137", format: "glb" },
      },
      {
        name: "download_parcel_terrain_export",
        args: { parcel_node_id: "48021:34137", format: "glb" },
      },
    ]);
  });

  it("executeExportInstrument stops at a refresh error and never calls download", async () => {
    const names: string[] = [];
    const result = await executeExportInstrument(
      { parcelNodeId: "48021:34137", kind: "terrain" },
      {
        loadConfig: () => ({ baseUrl: "https://hauska-mcp.test", serviceKey: "k" }),
        probeHealth: async () => ({ state: "ok", latency_ms: 4, detail: "HTTP 200" }),
        callTool: async (_config, name) => {
          names.push(name);
          return { data: { message: "public-paid X-Hauska-Key required" }, isError: true };
        },
      },
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      message: "public-paid X-Hauska-Key required",
    });
    expect(names).toEqual(["refresh_parcel_terrain_export"]);
  });

  it("executeExportInstrument surfaces a thrown transport error as raw undeclared text", async () => {
    const result = await executeExportInstrument(
      { parcelNodeId: "48021:34137", kind: "terrain" },
      {
        loadConfig: () => ({ baseUrl: "https://hauska-mcp.test", serviceKey: "k" }),
        probeHealth: async () => ({ state: "ok", latency_ms: 4, detail: "HTTP 200" }),
        callTool: async () => {
          throw new Error("Hauska MCP HTTP 503: cold start");
        },
      },
    );

    expect(result.isError).toBe(true);
    // Raw text, not a JSON envelope: tools.ts's ensureDeclaredError wraps
    // this at the case-handler boundary, same as every other proxied tool.
    expect(result.content[0]!.text).toBe("Hauska MCP HTTP 503: cold start");
  });
});
