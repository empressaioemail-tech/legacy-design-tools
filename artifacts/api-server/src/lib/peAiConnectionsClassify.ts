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
 * TWO PREFIXES, and the second one was MEASURED, not guessed. The first cut of
 * this function matched only `claude`, reasoning from the names I knew:
 * `claude-ai`, `claude-code`, `Claude Desktop`. Then a real connect was
 * observed on 2026-08-31 and wrote THREE rows for one account:
 *
 *   claude-ai           v0.1.0
 *   Anthropic/ClaudeAI  v1.0.0
 *   Anthropic/Toolbox   v1.0.0
 *
 * Two of the three do not begin with "claude". Today that is masked, because
 * the same connect also writes `claude-ai` and one match is enough. It is
 * still a live false-negative: a surface that announced only `Anthropic/...`
 * would read as "no Claude connected" while the connector was working, and the
 * card would show setup instructions to someone already set up.
 *
 * `anthropic/` carries the SLASH deliberately. It is what makes this a vendor
 * namespace rather than a word: "anthropicity" or a third party calling itself
 * "Anthropic Helper" does not match, but every first-party `Anthropic/X`
 * client does, including ones not yet named here.
 *
 * Both are PREFIXES, never substrings: a substring match would accept any
 * client that merely mentions Claude or Anthropic somewhere in its name.
 */
export function isClaudeClient(clientName: string): boolean {
  const n = clientName.trim().toLowerCase();
  return n.startsWith("claude") || n.startsWith("anthropic/");
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
