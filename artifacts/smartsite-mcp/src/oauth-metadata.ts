const DEFAULT_RESOURCE = "https://mcp.smartsite.cloud/mcp";
const DEFAULT_AUTHKIT = "https://happy-asteroid-216.authkit.app";

export function mcpResourceUrl(): string {
  const base = process.env.SMARTSITE_MCP_PUBLIC_URL?.trim().replace(/\/$/, "");
  if (base) return `${base}/mcp`;
  return process.env.SMARTSITE_MCP_RESOURCE?.trim() || DEFAULT_RESOURCE;
}

export function authkitIssuer(): string {
  return process.env.WORKOS_ISSUER?.trim() || DEFAULT_AUTHKIT;
}

export function oauthProtectedResourceMetadata() {
  return {
    resource: mcpResourceUrl(),
    authorization_servers: [authkitIssuer()],
    bearer_methods_supported: ["header"],
  };
}

/** Host base for RFC 9728 metadata (no /mcp suffix). */
export function mcpPublicBaseUrl(): string {
  const base = process.env.SMARTSITE_MCP_PUBLIC_URL?.trim().replace(/\/$/, "");
  if (base) return base;
  return mcpResourceUrl().replace(/\/mcp$/, "") || "https://mcp.smartsite.cloud";
}

export function wwwAuthenticateHeader(): string {
  const base = mcpPublicBaseUrl();
  return [
    'Bearer error="unauthorized"',
    'error_description="Authorization needed"',
    `resource_metadata="${base}/.well-known/oauth-protected-resource"`,
  ].join(", ");
}
