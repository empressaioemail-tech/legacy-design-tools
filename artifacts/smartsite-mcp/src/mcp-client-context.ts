/**
 * P-456b. Last named MCP client per Smart Site user (from initialize clientInfo).
 */

import { readClientIdentity } from "./connection-record.js";
import {
  mcpRenderHostKeyFromClientName,
  type McpRenderHostKey,
} from "./mcp-host-key.js";

const lastHostByUserId = new Map<string, McpRenderHostKey>();

export function noteMcpClientFromInitializeBody(
  userId: string,
  body: unknown,
): void {
  const identity = readClientIdentity(body);
  if (!identity) return;
  const key = mcpRenderHostKeyFromClientName(identity.name);
  lastHostByUserId.set(userId.trim(), key);
}

export function renderHostKeyForUser(userId: string): McpRenderHostKey {
  return lastHostByUserId.get(userId.trim()) ?? "other";
}

/** Test hook. */
export function resetMcpClientContextForTests(): void {
  lastHostByUserId.clear();
}
