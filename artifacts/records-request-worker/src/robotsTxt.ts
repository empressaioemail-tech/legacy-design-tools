/**
 * Fetch and parse robots.txt for a clerk portal origin (plain fetch, not Playwright).
 */

const BODY_SNIPPET_MAX = 2000;

export interface RobotsTxtSuccess {
  ok: true;
  url: string;
  status: number;
  bodySnippet: string;
  fetchedAt: string;
  disallowRules: string[];
}

export interface RobotsTxtError {
  ok: false;
  url: string;
  fetchedAt: string;
  errorMessage: string;
}

export type RobotsTxtResult = RobotsTxtSuccess | RobotsTxtError;

export function originFromPortalUrl(entryUrl: string): string {
  const parsed = new URL(entryUrl);
  return parsed.origin;
}

export function robotsTxtUrlForOrigin(origin: string): string {
  return `${origin.replace(/\/$/, "")}/robots.txt`;
}

export function parseDisallowRules(body: string): string[] {
  const rules: string[] = [];
  let activeForAllAgents = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const agentMatch = /^user-agent:\s*(.+)$/i.exec(line);
    if (agentMatch) {
      activeForAllAgents = agentMatch[1].trim() === "*";
      continue;
    }
    const disallowMatch = /^disallow:\s*(.*)$/i.exec(line);
    if (disallowMatch && activeForAllAgents) {
      rules.push(disallowMatch[1].trim());
    }
  }

  return rules;
}

function snippet(body: string): string {
  return body.length <= BODY_SNIPPET_MAX
    ? body
    : `${body.slice(0, BODY_SNIPPET_MAX)}…`;
}

export async function fetchRobotsTxt(
  entryUrl: string,
  deps?: { fetchFn?: typeof fetch; now?: () => number },
): Promise<RobotsTxtResult> {
  const fetchFn = deps?.fetchFn ?? fetch;
  const fetchedAt = new Date(deps?.now?.() ?? Date.now()).toISOString();
  let robotsUrl: string;
  try {
    robotsUrl = robotsTxtUrlForOrigin(originFromPortalUrl(entryUrl));
  } catch (err) {
    return {
      ok: false,
      url: entryUrl,
      fetchedAt,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const response = await fetchFn(robotsUrl, {
      method: "GET",
      headers: {
        Accept: "text/plain,*/*",
        "User-Agent":
          "RecordsRequestWorker/1.0 (Smart Site; +https://smartsite.cloud/records-request)",
      },
    });
    const body = await response.text();
    return {
      ok: true,
      url: robotsUrl,
      status: response.status,
      bodySnippet: snippet(body),
      fetchedAt,
      disallowRules: parseDisallowRules(body),
    };
  } catch (err) {
    return {
      ok: false,
      url: robotsUrl,
      fetchedAt,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

export function robotsTxtScopeRecord(
  result: RobotsTxtResult,
): Record<string, unknown> {
  if (result.ok) {
    return {
      url: result.url,
      status: result.status,
      bodySnippet: result.bodySnippet,
      fetchedAt: result.fetchedAt,
      disallowRules: result.disallowRules,
    };
  }
  return {
    url: result.url,
    fetchedAt: result.fetchedAt,
    errorMessage: result.errorMessage,
  };
}
