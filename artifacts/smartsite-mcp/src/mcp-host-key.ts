/**
 * P-456b. Bucket key for render metrics: the MCP host product, not a user id.
 */

export type McpRenderHostKey =
  | "claude.ai"
  | "claude-chrome"
  | "claude-desktop"
  | "other";

/** Map initialize clientInfo.name to a stable host bucket. */
export function mcpRenderHostKeyFromClientName(clientName: string): McpRenderHostKey {
  const n = clientName.trim().toLowerCase();
  if (!n) return "other";
  if (n === "claude-ai" || n.startsWith("claude-ai/")) return "claude.ai";
  if (n.includes("chrome") && (n.startsWith("claude") || n.includes("claude"))) {
    return "claude-chrome";
  }
  if (n === "claude" || n === "claude-desktop" || n.startsWith("claude-desktop")) {
    return "claude-desktop";
  }
  if (n.startsWith("claude") || n.startsWith("anthropic/")) return "claude.ai";
  return "other";
}
