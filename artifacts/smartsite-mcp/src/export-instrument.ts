import type { ToolResult } from "./tools-types.js";
import {
  callHauskaMcpTool,
  isHauskaMcpReachable,
  loadHauskaMcpConfig,
  probeHauskaMcpHealth,
  type HauskaDepHealth,
  type HauskaMcpConfig,
  type HauskaMcpToolResult,
} from "./hauska-client.js";

export type ExportKind = "brief" | "siteplan" | "terrain" | "dossier";

/**
 * Kinds hauska-mcp-server actually serves. There is no upstream "brief"
 * kind (A-074, confirmed live 2026-09-02) — callers with kind "brief" are
 * refused before this module is ever reached; see tools.ts's
 * export_instrument case and `exportKindNotAvailableResult` below.
 */
export type UpstreamExportKind = Exclude<ExportKind, "brief">;

/** Maps a connector `kind` to the upstream tool-name segment (snake_case). */
const UPSTREAM_EXPORT_KIND_SEGMENT: Record<UpstreamExportKind, string> = {
  siteplan: "site_plan",
  terrain: "terrain",
  dossier: "dossier",
};

export type ExportInstrumentArgs = {
  parcelNodeId: string;
  kind: UpstreamExportKind;
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

/**
 * Declared refusal for kind "brief" — hauska-mcp-server has no upstream
 * brief export tool (no `refresh_parcel_brief_export`); it never existed,
 * this is not an outage. `brief` stays a schema-accepted kind (so a caller
 * gets this explanation instead of a bare validation error) but always
 * routes here, before any config load or network attempt (P-110).
 */
export type ExportKindNotAvailablePayload = {
  status: "kind_not_available";
  tool: "export_instrument";
  kind: "brief";
  reason: "no_upstream_brief_export";
  message: string;
};

export function buildExportKindNotAvailablePayload(): ExportKindNotAvailablePayload {
  return {
    status: "kind_not_available",
    tool: "export_instrument",
    kind: "brief",
    reason: "no_upstream_brief_export",
    message:
      "Brief export is not available: Hauska's export contract has no brief kind (site plan, terrain, and dossier only).",
  };
}

export function exportKindNotAvailableResult(): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(buildExportKindNotAvailablePayload()),
      },
    ],
    isError: true,
  };
}

export type ExportInstrumentDeps = {
  loadConfig?: () => HauskaMcpConfig | null;
  probeHealth?: (config: HauskaMcpConfig | null) => Promise<HauskaDepHealth>;
  /** Calls one upstream Hauska MCP tool. Defaults to a real MCP round-trip. */
  callTool?: (
    config: HauskaMcpConfig,
    name: string,
    args: Record<string, unknown>,
  ) => Promise<HauskaMcpToolResult>;
};

/**
 * Real two-hop export: refresh (generates the artifact upstream, one SDK
 * meter charged here) then download (fetches the bytes; not separately
 * metered — mirrors hauska-map's already-live BFF, e.g.
 * apps/property-explorer/api/pe-terrain-export.ts, "One SDK meter is
 * consumed at refresh, not here"). No poll/retry loop: the proven
 * reference implementation treats refresh as synchronous, not an async job
 * to poll — see the same file. Both hops always run; we do not attempt to
 * detect an inline artifact on the refresh response and skip the download,
 * since download costs nothing extra and guessing at an inline-payload
 * shape we have not verified live risks silently dropping the artifact.
 */
export async function executeExportInstrument(
  args: ExportInstrumentArgs,
  deps: ExportInstrumentDeps = {},
): Promise<ToolResult> {
  const loadConfig = deps.loadConfig ?? loadHauskaMcpConfig;
  const probeHealth = deps.probeHealth ?? probeHauskaMcpHealth;
  const callTool = deps.callTool ?? callHauskaMcpTool;

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

  const upstreamKind = UPSTREAM_EXPORT_KIND_SEGMENT[args.kind];
  const toolArgs: Record<string, unknown> = { parcel_node_id: args.parcelNodeId };

  let refreshed: HauskaMcpToolResult;
  try {
    refreshed = await callTool(
      config,
      `refresh_parcel_${upstreamKind}_export`,
      toolArgs,
    );
  } catch (err) {
    return upstreamThrewResult(err);
  }
  if (refreshed.isError) {
    return {
      content: [{ type: "text", text: JSON.stringify(refreshed.data) }],
      isError: true,
    };
  }

  let downloaded: HauskaMcpToolResult;
  try {
    downloaded = await callTool(
      config,
      `download_parcel_${upstreamKind}_export`,
      toolArgs,
    );
  } catch (err) {
    return upstreamThrewResult(err);
  }
  return {
    content: [{ type: "text", text: JSON.stringify(downloaded.data) }],
    isError: downloaded.isError,
  };
}

/**
 * Raw, undeclared error text — deliberately not wrapped in a status
 * envelope here. tools.ts's export_instrument case wraps every result in
 * `ensureDeclaredError`, which detects undeclared error text and wraps it
 * (declareUpstreamNonOk("unmeasured", ...)) exactly as it already does for
 * every other proxied tool's thrown errors. Mirrors the pre-P-109 shape.
 */
function upstreamThrewResult(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
