import type { ToolResult } from "./tools-types.js";
import {
  hauskaMcpFetch,
  isHauskaMcpReachable,
  loadHauskaMcpConfig,
  probeHauskaMcpHealth,
  type HauskaDepHealth,
  type HauskaMcpConfig,
} from "./hauska-client.js";

export type ExportKind = "brief" | "siteplan" | "terrain" | "dossier";

export type ExportInstrumentArgs = {
  parcelNodeId: string;
  kind: ExportKind;
};

/** Canonical export-degraded fixture when Hauska MCP is the proxy and is down. */
export type ExportHauskaDegradedPayload = {
  status: "degraded";
  tool: "export_instrument";
  reason: "hauska_mcp_unavailable";
  dependency: "hauska-mcp";
  message: string;
  hauska: Pick<HauskaDepHealth, "state" | "detail">;
};

export function buildExportHauskaDegradedPayload(
  hauska: HauskaDepHealth,
): ExportHauskaDegradedPayload {
  return {
    status: "degraded",
    tool: "export_instrument",
    reason: "hauska_mcp_unavailable",
    dependency: "hauska-mcp",
    message:
      "Export is temporarily unavailable because Hauska MCP is unreachable. Other Smart Site tools remain available.",
    hauska: {
      state: hauska.state,
      ...(hauska.detail ? { detail: hauska.detail } : {}),
    },
  };
}

export function exportHauskaDegradedResult(hauska: HauskaDepHealth): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(buildExportHauskaDegradedPayload(hauska)),
      },
    ],
    isError: true,
  };
}

export type ExportInstrumentDeps = {
  loadConfig?: () => HauskaMcpConfig | null;
  probeHealth?: (config: HauskaMcpConfig | null) => Promise<HauskaDepHealth>;
  fetchHauska?: typeof hauskaMcpFetch;
};

export async function executeExportInstrument(
  args: ExportInstrumentArgs,
  deps: ExportInstrumentDeps = {},
): Promise<ToolResult> {
  const loadConfig = deps.loadConfig ?? loadHauskaMcpConfig;
  const probeHealth = deps.probeHealth ?? probeHauskaMcpHealth;
  const fetchHauska = deps.fetchHauska ?? hauskaMcpFetch;

  const config = loadConfig();
  const hauskaHealth = await probeHealth(config);
  if (!isHauskaMcpReachable(hauskaHealth)) {
    return exportHauskaDegradedResult(hauskaHealth);
  }
  if (!config) {
    return exportHauskaDegradedResult({
      state: "skipped",
      latency_ms: null,
      detail: "HAUSKA_MCP_BASE_URL not configured",
    });
  }

  const res = await fetchHauska(
    config,
    `/tools/export_instrument`,
    {
      method: "POST",
      body: JSON.stringify({
        parcelNodeId: args.parcelNodeId,
        kind: args.kind,
      }),
    },
  );
  const body = await res.text();
  if (!res.ok) {
    return {
      content: [{ type: "text", text: body }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: body }],
    isError: false,
  };
}
