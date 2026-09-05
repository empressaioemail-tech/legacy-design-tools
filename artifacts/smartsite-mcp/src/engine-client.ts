/**
 * Direct hauska-engine-api client (P-119 / OPS-16 A-103, Feasibility Study).
 *
 * There is no hauska-mcp-server tool for feasibility export — confirmed
 * live 2026-09-05: `git grep -i feasibility` across the current
 * hauska-mcp-server `main` (`3497f38`) returns zero hits, and P-32 wave 2's
 * own close notes why: "no MCP tool exists for feasibility-export, named
 * out of scope for this repo." hauska-map's own BFF does not go through
 * hauska-mcp-server for this report either — it calls hauska-engine-api
 * DIRECTLY with gate-front headers (the same transport
 * pe-flood-drainage-core.ts uses), because P-32 wave 1 (A-089) built
 * "minimal engine-api refresh/get/download routes" for feasibility that
 * this client mirrors exactly:
 *   POST /v1/property-nodes/{parcelNodeId}/feasibility-export/refresh
 *   GET  /v1/property-nodes/{parcelNodeId}/feasibility-export/download
 * (apps/property-explorer/api/_lib/pe-feasibility-export-handler.ts in
 * hauska-map, read 2026-09-05). Same env var names as hauska-map's BFF
 * (HAUSKA_ENGINE_API_KEY / ENGINE_API_GATE_TOKEN, HAUSKA_ENGINE_API_URL /
 * ENGINE_API_URL) so a credential already provisioned for one BFF clears
 * the other with no new secret to mint — though nothing confirms one is
 * actually configured on smartsite-mcp's own Cloud Run service today; see
 * feasibility-export.ts's not-configured path, mirroring the same honest
 * "starved" shape P-109 found for HAUSKA_MCP_BASE_URL before A-100 fixed it.
 *
 * NOT LIVE-SMOKE-TESTED against production engine-api: this sandboxed
 * session holds no HAUSKA_MCP_KEY-equivalent engine-api credential to
 * repeat A-100's live probe with. The route shapes and header contract
 * above are read directly from hauska-map's already-proven, already-live
 * caller, not guessed.
 */

import { randomUUID } from "node:crypto";

export type EngineApiConfig = {
  baseUrl: string;
  gateToken: string;
};

export function loadEngineApiConfig(): EngineApiConfig | null {
  const baseUrl = (
    process.env.HAUSKA_ENGINE_API_URL ?? process.env.ENGINE_API_URL ?? ""
  ).trim();
  const gateToken = (
    process.env.HAUSKA_ENGINE_API_KEY ?? process.env.ENGINE_API_GATE_TOKEN ?? ""
  ).trim();
  if (!baseUrl || !gateToken) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ""), gateToken };
}

/**
 * Gate-front headers engine-api requires on every non-health call. Mirrors
 * hauska-map's `buildFeasibilityEngineGateHeaders` / `buildSitePlanEngine
 * GateHeaders` shape with this connector's own credential id so gate-front
 * logging can tell the two callers (BFF vs. MCP connector) apart.
 */
export function buildEngineGateHeaders(opts: {
  packageId: string;
  requestId?: string;
}): Record<string, string> {
  const requestId = opts.requestId?.trim() || randomUUID();
  return {
    "x-hauska-product": "cortex",
    "x-hauska-tenant-id": "public-catalog",
    "x-hauska-package-id": opts.packageId,
    "x-hauska-access-tier": "public-paid",
    "x-hauska-gate-credential-id": "smartsite-mcp-feasibility",
    "x-hauska-request-id": requestId,
  };
}
