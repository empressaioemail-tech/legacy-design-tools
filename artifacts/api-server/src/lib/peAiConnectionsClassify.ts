/**
 * P-87 Claude Sync — the PURE half of the connected read.
 *
 * Split from peAiConnections.ts because that module imports `@workspace/db`,
 * which throws at IMPORT time without DATABASE_URL. A classifier that decides
 * whether an account counts as Claude-connected must be testable without
 * provisioning a database; when it was not, its test could not even load, and
 * an unloadable test is a dormant mechanism reported as coverage.
 */

export type PeAiConnectionView = {
  client: string;
  clientVersion: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
};

export type PeAiConnectionsRead = {
  connections: PeAiConnectionView[];
  /** The most recently seen Claude client, or null when none has connected. */
  claude: PeAiConnectionView | null;
};

/**
 * Does this client name identify a Claude host?
 *
 * Case-insensitive prefix on the trimmed name. Claude hosts announce
 * themselves as `claude-ai` (web and desktop), `claude-code`, and
 * `Claude Desktop` depending on surface, and a prefix covers all of them
 * without enumerating a list that goes stale the next time one is renamed.
 *
 * A PREFIX, not a substring: substring would match any client with "claude"
 * anywhere in its name, including a third-party tool that merely mentions it.
 */
export function isClaudeClient(clientName: string): boolean {
  return clientName.trim().toLowerCase().startsWith("claude");
}

/**
 * Pick the Claude row to present from a set of rows.
 *
 * Most recently seen wins when an account has connected from more than one
 * Claude surface. A row with no `lastSeenAt` never outranks one that has it.
 */
export function pickClaude(
  rows: PeAiConnectionView[],
): PeAiConnectionView | null {
  const claudes = rows.filter((r) => isClaudeClient(r.client));
  if (claudes.length === 0) return null;
  return claudes.reduce((best, row) => {
    if (!row.lastSeenAt) return best;
    if (!best.lastSeenAt) return row;
    return row.lastSeenAt > best.lastSeenAt ? row : best;
  });
}

export function toIso(v: Date | string | null): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
