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

/**
 * Live-measured 2026-09-04 against the real server: `download_parcel_site_
 * plan_export` rejects a call with no `format` (MCP error -32602, "Required"
 * at path ["format"]) — refresh succeeded without it, only download failed.
 * The connector's export_instrument tool takes no format argument at all
 * (a calling agent has no way to discover the upstream format enum), so we
 * default per kind exactly the way hauska-map's own proven BFF does
 * (apps/property-explorer/api/pe-site-plan-export.ts:
 * `parseSitePlanFormat(body?.format) ?? 'pdf-site-plan'`; pe-terrain-
 * export.ts: `?? 'glb'`; dossier's refresh hardcodes 'pdf-dossier').
 *
 * `includeOnDownload` mirrors an upstream asymmetry, not a guess: site plan
 * and terrain each have several possible artifact formats, so their
 * download tools require `format` to disambiguate which one to fetch (the
 * same value used at refresh). Dossier has exactly one shape, and
 * hauska-map's own dossier download call
 * (`callMcpTool('download_parcel_dossier_export', { parcel_node_id })`)
 * omits `format` entirely — so we do too, rather than sending a field nothing
 * downstream has verified is accepted there.
 */
const UPSTREAM_EXPORT_FORMAT: Record<
  UpstreamExportKind,
  { value: string; includeOnDownload: boolean }
> = {
  siteplan: { value: "pdf-site-plan", includeOnDownload: true },
  terrain: { value: "glb", includeOnDownload: true },
  dossier: { value: "pdf-dossier", includeOnDownload: false },
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
  const format = UPSTREAM_EXPORT_FORMAT[args.kind];
  const baseArgs: Record<string, unknown> = { parcel_node_id: args.parcelNodeId };
  const refreshArgs: Record<string, unknown> = { ...baseArgs, format: format.value };
  const downloadArgs: Record<string, unknown> = format.includeOnDownload
    ? { ...baseArgs, format: format.value }
    : baseArgs;

  let refreshed: HauskaMcpToolResult;
  try {
    refreshed = await callTool(
      config,
      `refresh_parcel_${upstreamKind}_export`,
      refreshArgs,
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
      downloadArgs,
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
