import { SERVER_NAME, SERVER_VERSION, SMARTSITE_MCP_TOOLS } from "./constants.js";
import {
  loadHauskaMcpConfig,
  probeHauskaMcpHealth,
  type HauskaDepHealth,
} from "./hauska-client.js";

export type HealthReport = {
  status: "ok" | "degraded";
  service: "smartsite-mcp";
  name: typeof SERVER_NAME;
  version: typeof SERVER_VERSION;
  authConfigured: boolean;
  cortexConfigured: boolean;
  revision: string;
  /** Smart Site liveness only; Hauska MCP is on GET /health/dependencies. */
  failureDomain: "smartsite-mcp";
};

export type DependenciesHealthReport = {
  service: "smartsite-mcp-dependencies";
  dependencies: {
    hauska_mcp: HauskaDepHealth;
  };
};

export function buildHealthReport(): HealthReport {
  const authConfigured =
    process.env.SMARTSITE_MCP_DEV_MODE === "true" ||
    Boolean(process.env.WORKOS_CLIENT_ID && process.env.WORKOS_JWKS_URI);
  const cortexConfigured = Boolean(
    process.env.CORTEX_API_BASE_URL && process.env.SERVICE_API_KEY,
  );

  return {
    status: authConfigured && cortexConfigured ? "ok" : "degraded",
    service: "smartsite-mcp",
    name: SERVER_NAME,
    version: SERVER_VERSION,
    authConfigured,
    cortexConfigured,
    revision: process.env.K_REVISION ?? "local",
    failureDomain: "smartsite-mcp",
  };
}

export async function buildDependenciesHealthReport(): Promise<DependenciesHealthReport> {
  const hauskaConfig = loadHauskaMcpConfig();
  const hauska_mcp = await probeHauskaMcpHealth(hauskaConfig);
  return {
    service: "smartsite-mcp-dependencies",
    dependencies: { hauska_mcp },
  };
}

export function renderLlmsTxt(publicHost = "https://mcp.smartsite.cloud"): string {
  const toolLines = SMARTSITE_MCP_TOOLS.map(
    (t) =>
      `- ${t.title} (\`${t.name}\`)${t.readiness === "blocked" ? " — not ready" : ""}: ${t.description}`,
  ).join("\n");

  return `# Smart Site MCP

Smart Site is the Empressa property intelligence product. This MCP server exposes Smart Site jobs at the caller's Stripe tier.

Endpoint: ${publicHost}/mcp
Protocol: Streamable HTTP (MCP 2025-03-26)
Authorization: OAuth 2.1 + PKCE against the Smart Site account (WorkOS AuthKit). Bearer-without-OAuth is refused.

Tools (13):
${toolLines}

Hauska MCP (mcp.hauska.dev) remains the developer catalog gate. This server is product-owned and lists only Smart Site tools.
`;
}
