import { createHash } from "node:crypto";

export const GTM_MCP_EVENT_TYPES = [
  "mcp_tool_call",
  "mcp_connect",
  "mcp_error",
  "mcp_docs_clicked",
] as const;

export type GtmMcpEventType = (typeof GTM_MCP_EVENT_TYPES)[number];

export const GTM_SOURCE_SURFACES = [
  "extension",
  "api",
  "mcp",
  "docs",
  "share_page",
] as const;

export type GtmSourceSurface = (typeof GTM_SOURCE_SURFACES)[number];

export function isGtmMcpEventType(value: string): value is GtmMcpEventType {
  return (GTM_MCP_EVENT_TYPES as readonly string[]).includes(value);
}

export function isGtmSourceSurface(value: string): value is GtmSourceSurface {
  return (GTM_SOURCE_SURFACES as readonly string[]).includes(value);
}

/** SHA-256 prefix for steward digest — never store raw API keys. */
export function hashApiKeyPrefix(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

export function isInternalApiKeyHash(
  keyHash: string | undefined,
  envKeys: string[],
): boolean {
  if (!keyHash) return false;
  return envKeys.some((k) => hashApiKeyPrefix(k) === keyHash);
}

/** Operator / service keys — customer keys in BROKERAGE_API_KEYS are external for GTM. */
export function loadInternalGtmApiKeys(): string[] {
  const keys: string[] = [];
  for (const envName of ["BROKERAGE_DEV_API_KEY", "SERVICE_API_KEY"]) {
    const raw = process.env[envName]?.trim();
    if (!raw) continue;
    for (const part of raw.split(",")) {
      const k = part.trim();
      if (k) keys.push(k);
    }
  }
  return keys;
}
