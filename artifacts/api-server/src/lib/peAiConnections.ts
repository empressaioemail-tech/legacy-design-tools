/**
 * P-87 Claude Sync — the read half of the connected signal.
 *
 * The Smart Site MCP server records one row per (account, MCP client name)
 * when a client names itself on `initialize`. This module answers the only
 * question the PE card asks: is Claude among them, and when was it last seen.
 *
 * The CLASSIFIER lives in ./peAiConnectionsClassify, which imports no database
 * and is therefore testable without one. This file is the query.
 *
 * WHY THE RAW ROWS SHIP TOO. `connections` carries every client verbatim, so a
 * connection that exists but does not classify as Claude is visible as itself
 * rather than disappearing into a false negative. A read that returns
 * `claude: null` with a non-empty `connections` array is a DIFFERENT fact from
 * one that returns both empty, and the difference is diagnosable from outside.
 */

import { desc, eq } from "drizzle-orm";
import { db, peAiConnections } from "@workspace/db";

import {
  pickClaude,
  toIso,
  type PeAiConnectionView,
  type PeAiConnectionsRead,
} from "./peAiConnectionsClassify";

export {
  isClaudeClient,
  pickClaude,
  type PeAiConnectionView,
  type PeAiConnectionsRead,
} from "./peAiConnectionsClassify";

export async function readAiConnections(
  ownerUserId: string,
): Promise<PeAiConnectionsRead> {
  const rows = await db
    .select({
      client: peAiConnections.clientName,
      clientVersion: peAiConnections.clientVersion,
      firstSeenAt: peAiConnections.firstSeenAt,
      lastSeenAt: peAiConnections.lastSeenAt,
    })
    .from(peAiConnections)
    .where(eq(peAiConnections.ownerUserId, ownerUserId))
    .orderBy(desc(peAiConnections.lastSeenAt));

  const connections: PeAiConnectionView[] = rows.map((r) => ({
    client: r.client,
    clientVersion: r.clientVersion ?? null,
    firstSeenAt: toIso(r.firstSeenAt),
    lastSeenAt: toIso(r.lastSeenAt),
  }));

  return { connections, claude: pickClaude(connections) };
}
