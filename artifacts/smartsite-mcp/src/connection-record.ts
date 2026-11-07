/**
 * P-87 Claude Sync — the connected signal.
 *
 * The Smart Site MCP server resolved a real Smart Site user on every call and
 * then discarded it, so the product could not answer "is Claude connected to
 * this account". The Claude Sync card in PE needs that answer to choose
 * between its setup state and its sync state. This module is the write half.
 *
 * WHAT IS RECORDED, AND WHY ONLY THIS. `initialize` is the only JSON-RPC
 * message that carries `clientInfo`, and it is the message a host sends the
 * instant a custom connector finishes OAuth approval. So the row appears at
 * CONNECT time, not at first tool call, which is what makes the card flip when
 * the user finishes setup rather than after they remember to ask something.
 *
 * WHAT IS NOT RECORDED. An initialize whose `clientInfo.name` is missing,
 * blank, or not a string writes NOTHING. There is no "unknown" client row and
 * no default name. A row here flips a card to a Sync button, so a fabricated
 * name would render a working-looking control for a connection nobody made —
 * the exact defect class of a check that cannot fail. Unnamed stays absent,
 * the card stays on its setup instructions, and the user loses nothing but a
 * shortcut.
 *
 * THE NAME IS STORED RAW. Deciding what counts as "Claude" is a READ-side
 * question (see api-server peAiConnections). Normalising at write time would
 * destroy the only evidence of what the client actually called itself.
 */

import { eq, and } from "drizzle-orm";
import { db, peAiConnections } from "@workspace/db";

export type McpClientIdentity = {
  name: string;
  version: string | null;
};

export type RecordOutcome =
  | { kind: "recorded"; client: McpClientIdentity }
  /** Body was a valid message, just not an initialize. Nothing to record. */
  | { kind: "not-an-initialize" }
  /** An initialize that did not name its client. Deliberately not recorded. */
  | { kind: "unnamed" }
  /** The write itself failed. Loud, and never fatal to the MCP call. */
  | { kind: "write-failed"; error: unknown };

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * Pure. Pull the client identity out of a JSON-RPC body.
 *
 * Handles the batch form (a JSON array of messages) because the MCP spec
 * permits it and an initialize can arrive inside one. Returns null for any
 * body that is not an initialize, and for an initialize that does not name
 * itself — the caller distinguishes those two with `isInitialize`.
 */
export function readClientIdentity(body: unknown): McpClientIdentity | null {
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    const m = asRecord(message);
    if (!m || m.method !== "initialize") continue;
    const params = asRecord(m.params);
    const info = asRecord(params?.clientInfo);
    const rawName = info?.name;
    if (typeof rawName !== "string") continue;
    const name = rawName.trim();
    if (!name) continue;
    const rawVersion = info?.version;
    const version =
      typeof rawVersion === "string" && rawVersion.trim()
        ? rawVersion.trim()
        : null;
    return { name, version };
  }
  return null;
}

/** Pure. Does this body contain an initialize at all, named or not? */
export function isInitialize(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((message) => asRecord(message)?.method === "initialize");
}

/**
 * Upsert the (account, client) row.
 *
 * `clientVersion` is only written when the client supplied one, so a later
 * handshake that omits the version can never blank a version we already know.
 * Absent and known are different states and this keeps them that way.
 */
export async function recordMcpClient(
  userId: string,
  body: unknown,
): Promise<RecordOutcome> {
  const identity = readClientIdentity(body);
  if (!identity) {
    return isInitialize(body)
      ? { kind: "unnamed" }
      : { kind: "not-an-initialize" };
  }

  const set: { lastSeenAt: Date; clientVersion?: string } = {
    lastSeenAt: new Date(),
  };
  if (identity.version) set.clientVersion = identity.version;

  try {
    await db
      .insert(peAiConnections)
      .values({
        ownerUserId: userId,
        clientName: identity.name,
        clientVersion: identity.version,
      })
      .onConflictDoUpdate({
        target: [peAiConnections.ownerUserId, peAiConnections.clientName],
        set,
      });
    return { kind: "recorded", client: identity };
  } catch (error) {
    return { kind: "write-failed", error };
  }
}

/**
 * Fire the recorder without letting it touch the MCP response.
 *
 * A failed write is LOUD (stderr) and never fatal: this row is a convenience
 * signal for a card, not an authorisation fact, and the card's fallback on a
 * missing row is to show setup instructions — the safe direction. Refusing the
 * MCP call because a telemetry row would not write would break a working
 * connector to protect a shortcut.
 */
export function recordMcpClientDetached(userId: string, body: unknown): void {
  void recordMcpClient(userId, body).then((outcome) => {
    if (outcome.kind === "write-failed") {
      console.error(
        "[smartsite-mcp] pe_ai_connections write failed; the Claude Sync card will stay on its setup state for this account",
        outcome.error,
      );
    }
  });
}

/** Test seam: read one account's rows. */
export async function readMcpClients(userId: string) {
  return db
    .select()
    .from(peAiConnections)
    .where(eq(peAiConnections.ownerUserId, userId));
}

/** Test seam: read one (account, client) row. */
export async function readMcpClient(userId: string, clientName: string) {
  const [row] = await db
    .select()
    .from(peAiConnections)
    .where(
      and(
        eq(peAiConnections.ownerUserId, userId),
        eq(peAiConnections.clientName, clientName),
      ),
    )
    .limit(1);
  return row ?? null;
}
