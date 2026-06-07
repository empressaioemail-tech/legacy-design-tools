/**
 * Steward digest MCP scoreboard metrics (79a weekly moat scoreboard).
 */

import { and, eq, gte, sql } from "drizzle-orm";
import { db, gtmEvents } from "@workspace/db";
import { isInternalApiKeyHash, loadInternalGtmApiKeys } from "./gtmMcpEvents";

export type GtmScoreboardMetrics = {
  external_callers: number;
  mcp_tool_calls: number;
  mcp_error_rate: number;
};

export async function computeGtmScoreboardMetrics(
  since: Date,
): Promise<GtmScoreboardMetrics> {
  const internalKeys = loadInternalGtmApiKeys();

  const toolCallRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(gtmEvents)
    .where(
      and(
        gte(gtmEvents.createdAt, since),
        eq(gtmEvents.eventType, "mcp_tool_call"),
      ),
    );

  const errorRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(gtmEvents)
    .where(
      and(
        gte(gtmEvents.createdAt, since),
        eq(gtmEvents.eventType, "mcp_error"),
      ),
    );

  const mcpToolCalls = toolCallRows[0]?.count ?? 0;
  const mcpErrors = errorRows[0]?.count ?? 0;
  const denominator = mcpToolCalls + mcpErrors;
  const mcp_error_rate =
    denominator === 0 ? 0 : Math.round((mcpErrors / denominator) * 1000) / 1000;

  const hashRows = await db
    .select({
      hash: sql<string>`payload_json ->> 'api_key_hash'`,
    })
    .from(gtmEvents)
    .where(
      and(
        gte(gtmEvents.createdAt, since),
        eq(gtmEvents.sourceSurface, "mcp"),
        sql`payload_json ->> 'api_key_hash' IS NOT NULL`,
      ),
    );

  const externalHashes = new Set<string>();
  for (const row of hashRows) {
    const hash = row.hash;
    if (!hash || isInternalApiKeyHash(hash, internalKeys)) continue;
    externalHashes.add(hash);
  }

  return {
    external_callers: externalHashes.size,
    mcp_tool_calls: mcpToolCalls,
    mcp_error_rate,
  };
}
