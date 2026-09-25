/**
 * P-447. Whether the MCP host can render MCP Apps (`io.modelcontextprotocol/ui`).
 * Read from initialize; remembered per (account, client name) for stateless HTTP.
 */

import { readClientIdentity } from "./connection-record.js";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Pure: does this initialize body advertise the MCP Apps UI extension? */
export function readUiExtensionFromInitialize(body: unknown): boolean | null {
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    const m = asRecord(message);
    if (!m || m.method !== "initialize") continue;
    const params = asRecord(m.params);
    if (!params) return false;
    const caps = asRecord(params.capabilities);
    if (!caps) return false;
    const experimental = caps.experimental;
    if (experimental === true) return true;
    const ext = caps.extensions;
    if (asRecord(ext)?.["io.modelcontextprotocol/ui"] !== undefined) return true;
    if (caps["io.modelcontextprotocol/ui"] !== undefined) return true;
    if (Array.isArray(experimental)) {
      if (experimental.some((e) => String(e).includes("io.modelcontextprotocol/ui"))) {
        return true;
      }
    }
    return false;
  }
  return null;
}

export type HostSessionSnapshot = {
  clientName: string | null;
  uiCapable: boolean;
};

const memory = new Map<string, HostSessionSnapshot>();

function sessionKey(userId: string, clientName: string | null): string {
  const client = clientName?.trim() || "unnamed-client";
  return `${userId.trim() || "unknown-user"}:${client}`;
}

/** Update memory from an MCP POST body; returns the session in force for this call. */
export function ingestHostSessionFromBody(
  userId: string,
  body: unknown,
): HostSessionSnapshot {
  const identity = readClientIdentity(body);
  const uiFromInit = readUiExtensionFromInitialize(body);
  const clientName = identity?.name ?? null;

  if (uiFromInit !== null && clientName) {
    const snap: HostSessionSnapshot = { clientName, uiCapable: uiFromInit };
    memory.set(sessionKey(userId, clientName), snap);
    return snap;
  }

  if (clientName) {
    const prior = memory.get(sessionKey(userId, clientName));
    if (prior) return prior;
  }

  for (const [key, snap] of memory) {
    if (key.startsWith(`${userId.trim() || "unknown-user"}:`)) return snap;
  }

  return { clientName, uiCapable: false };
}

/** Test hook */
export function resetHostSessionsForTests(): void {
  memory.clear();
}

export function hostKeyFromSession(session: HostSessionSnapshot, userId: string): string {
  return session.clientName?.trim() || userId.trim() || "unknown-host";
}
