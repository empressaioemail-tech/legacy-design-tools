/**
 * Feasibility Study export (P-119 / OPS-16 A-103). Two-hop refresh-then-
 * download, mirroring export-instrument.ts's shape exactly — but against
 * hauska-engine-api directly (see engine-client.ts for why there is no
 * hauska-mcp-server tool to proxy here instead).
 */

import type { ToolResult } from "./tools-types.js";
import {
  buildEngineGateHeaders,
  loadEngineApiConfig,
  type EngineApiConfig,
} from "./engine-client.js";

const FEASIBILITY_PACKAGE_ID = "feasibility-export";
const REFRESH_TIMEOUT_MS = 55_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;

export type FeasibilityExportArgs = {
  parcelNodeId: string;
};

export type FeasibilityExportDeps = {
  loadConfig?: () => EngineApiConfig | null;
  fetchImpl?: typeof fetch;
};

/**
 * Declared "not configured" result — mirrors export-instrument.ts's
 * `exportHauskaDegradedResult` shape (status/tool/reason/message) so a
 * caller sees the same envelope family regardless of which upstream this
 * connector proxies. Honest about what IS built vs. what still needs an
 * operator to provision a secret (P-109's "starved" pattern).
 */
export function feasibilityNotConfiguredResult(): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "degraded",
          tool: "export_instrument",
          kind: "feasibility",
          reason: "engine_api_not_configured",
          dependency: "hauska-engine-api",
          message:
            "Feasibility Study export is not configured on this server: engine-api gate credentials are missing (set HAUSKA_ENGINE_API_KEY and HAUSKA_ENGINE_API_URL). The upstream engine-api route already exists (hauska-engine PR #380, P-32 wave 1) — this is a deploy-configuration gap on smartsite-mcp, not a missing capability upstream.",
        }),
      },
    ],
    isError: true,
  };
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function engineThrewResult(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

/**
 * AbortController + setTimeout, matching hauska-client.ts's own
 * `probeHauskaMcpHealth` pattern exactly — this package's tsconfig carries
 * no DOM lib, so `AbortSignal.timeout` (a lib.dom.d.ts-only static in some
 * TS/Node type combinations) is avoided in favor of the already-proven
 * pattern already shipping in this same package.
 */
function timeoutSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

export async function executeFeasibilityExport(
  args: FeasibilityExportArgs,
  deps: FeasibilityExportDeps = {},
): Promise<ToolResult> {
  const loadConfig = deps.loadConfig ?? loadEngineApiConfig;
  const fetchImpl = deps.fetchImpl ?? fetch;

  const config = loadConfig();
  if (!config) return feasibilityNotConfiguredResult();

  const parcelPath = `/v1/property-nodes/${encodeURIComponent(args.parcelNodeId)}/feasibility-export`;
  const headers = {
    Authorization: `Bearer ${config.gateToken}`,
    ...buildEngineGateHeaders({ packageId: FEASIBILITY_PACKAGE_ID }),
  };

  let refreshRes: Response;
  {
    const t = timeoutSignal(REFRESH_TIMEOUT_MS);
    try {
      refreshRes = await fetchImpl(`${config.baseUrl}${parcelPath}/refresh`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: "{}",
        signal: t.signal,
      });
    } catch (err) {
      return engineThrewResult(err);
    } finally {
      t.clear();
    }
  }

  if (refreshRes.status === 422) {
    // The engine's own honest refresh failure (e.g. no resolvable site
    // plan for this parcel) — pass the real reason through verbatim,
    // mirroring hauska-map's own handling of this exact status. Never a
    // fabricated report, never mapped onto a generic error.
    const body = await refreshRes.text();
    return {
      content: [
        {
          type: "text",
          text:
            body ||
            JSON.stringify({
              status: "error",
              tool: "export_instrument",
              kind: "feasibility",
              reason: "feasibility_export_failed",
              message: "Feasibility study could not be produced for this parcel.",
            }),
        },
      ],
      isError: true,
    };
  }
  const refreshBody = await refreshRes.text();
  if (!refreshRes.ok) {
    return {
      content: [
        {
          type: "text",
          text:
            refreshBody ||
            JSON.stringify({ status: "error", upstreamStatus: refreshRes.status }),
        },
      ],
      isError: true,
    };
  }
  const refreshed = asRecord((() => {
    try {
      return JSON.parse(refreshBody);
    } catch {
      return {};
    }
  })());

  let downloadRes: Response;
  {
    const t = timeoutSignal(DOWNLOAD_TIMEOUT_MS);
    try {
      downloadRes = await fetchImpl(`${config.baseUrl}${parcelPath}/download`, {
        headers,
        signal: t.signal,
      });
    } catch (err) {
      return engineThrewResult(err);
    } finally {
      t.clear();
    }
  }

  if (downloadRes.status === 404 || downloadRes.status === 410) {
    // Pinned contract (per hauska-map's own handler): 404 artifact_
    // unavailable, 410 artifact_evicted — honest cache-miss states, never
    // a fabricated download.
    const body = await downloadRes.text();
    return {
      content: [
        {
          type: "text",
          text:
            body ||
            JSON.stringify({
              status: "error",
              reason:
                downloadRes.status === 404 ? "artifact_unavailable" : "artifact_evicted",
            }),
        },
      ],
      isError: true,
    };
  }
  if (!downloadRes.ok) {
    const text = await downloadRes.text().catch(() => "");
    return {
      content: [
        {
          type: "text",
          text: text || JSON.stringify({ status: "error", upstreamStatus: downloadRes.status }),
        },
      ],
      isError: true,
    };
  }

  const arrayBuffer = await downloadRes.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "ok",
          tool: "export_instrument",
          kind: "feasibility",
          parcelNodeId: args.parcelNodeId,
          format: "pdf-feasibility",
          download: {
            format: "pdf-feasibility",
            contentType: "application/pdf",
            base64,
            byteCount: arrayBuffer.byteLength,
          },
          pageCount: refreshed.pageCount,
          feasibilityPageCount: refreshed.feasibilityPageCount,
          sitePlanAppended: refreshed.sitePlanAppended,
          sitePlanUnavailableReason: refreshed.sitePlanUnavailableReason,
          sectionCount: refreshed.sectionCount,
          openItemCount: refreshed.openItemCount,
          narrativeIsDeterministicSkeleton: refreshed.narrativeIsDeterministicSkeleton,
        }),
      },
    ],
    isError: false,
  };
}
