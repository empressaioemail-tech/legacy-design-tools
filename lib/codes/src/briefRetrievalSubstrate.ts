/**
 * Substrate retrieval-api client — spine code search through the gate seam.
 *
 * Used when `BRIEF_CODE_RETRIEVAL=gate|mcp` or brokerage brief gate cut is on.
 * Calls retrieval-api `GET /search` (same contract the MCP gate proxies).
 */

import type { OrchestratorLogger } from "./orchestrator";
import type { RetrievedAtom } from "./retrieval";

/** Gate-front context for platform-internal ICC corpus retrieval. */
export interface SubstrateGateContext {
  accessTier?: "platform-internal" | "public-free" | "public-paid" | "tenant-private";
  jurisdictionTenant?: string;
  /** Product/surface dimension for usage metering. */
  surfaceKey?: string;
}

export interface SubstrateSearchOptions {
  jurisdictionKey: string;
  question: string;
  limit?: number;
  logger?: OrchestratorLogger;
  gateContext?: SubstrateGateContext;
}

function resolveSubstrateBaseUrl(): string | null {
  for (const envName of [
    "BRIEF_RETRIEVAL_API_URL",
    "HAUSKA_BACKEND_URL",
    "HAUSKA_GATE_RETRIEVAL_URL",
  ]) {
    const raw = process.env[envName]?.trim();
    if (raw) return raw.replace(/\/$/, "");
  }
  return null;
}

function resolveSubstrateApiKey(): string | null {
  for (const envName of [
    "BRIEF_RETRIEVAL_API_KEY",
    "RETRIEVAL_API_KEY",
    "HAUSKA_ENGINE_API_KEY",
    "SERVICE_API_KEY",
  ]) {
    const raw = process.env[envName]?.trim();
    if (raw) return raw;
  }
  return null;
}

function mapSubstrateHit(
  hit: {
    atomDid?: string;
    snippet?: string;
    score?: number;
    sectionNumber?: string | null;
    jurisdictionTenant?: string;
  },
  jurisdictionKey: string,
): RetrievedAtom {
  const id = String(hit.atomDid ?? "").trim();
  const snippet = String(hit.snippet ?? "").trim();
  return {
    id,
    sourceName: "substrate",
    jurisdictionKey: hit.jurisdictionTenant?.trim() || jurisdictionKey,
    codeBook: "",
    edition: "",
    sectionNumber: hit.sectionNumber ?? null,
    sectionTitle: null,
    body: snippet,
    sourceUrl: "",
    score: Number(hit.score ?? 0),
    retrievalMode: "substrate-gate",
  };
}

export async function retrieveAtomsFromSubstrate(
  opts: SubstrateSearchOptions,
): Promise<RetrievedAtom[]> {
  const base = resolveSubstrateBaseUrl();
  if (!base) {
    opts.logger?.warn?.(
      { jurisdictionKey: opts.jurisdictionKey },
      "substrate retrieval: no BRIEF_RETRIEVAL_API_URL / HAUSKA_BACKEND_URL",
    );
    return [];
  }

  const limit = opts.limit ?? 8;
  const params = new URLSearchParams({
    q: opts.question,
    jurisdiction: opts.jurisdictionKey,
    limit: String(limit),
  });
  const url = `${base}/search?${params.toString()}`;

  const headers: Record<string, string> = { Accept: "application/json" };
  const apiKey = resolveSubstrateApiKey();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const jurisdictionTenant =
    opts.gateContext?.jurisdictionTenant?.trim() ||
    process.env.BROKERAGE_GATE_JURISDICTION_TENANT?.trim();
  if (jurisdictionTenant) {
    headers["x-hauska-jurisdiction-tenant"] = jurisdictionTenant;
  }

  const accessTier = opts.gateContext?.accessTier?.trim();
  if (accessTier) {
    headers["x-hauska-access-tier"] = accessTier;
  }

  const surfaceKey = opts.gateContext?.surfaceKey?.trim();
  if (surfaceKey) {
    headers["x-hauska-product"] = surfaceKey;
  }

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    opts.logger?.warn?.(
      { status: res.status, jurisdictionKey: opts.jurisdictionKey },
      "substrate retrieval: HTTP error",
    );
    return [];
  }

  const body = (await res.json()) as {
    results?: Array<{
      atomDid?: string;
      snippet?: string;
      score?: number;
      sectionNumber?: string | null;
      jurisdictionTenant?: string;
    }>;
  };

  const hits = Array.isArray(body.results) ? body.results : [];
  return hits
    .map((h) => mapSubstrateHit(h, opts.jurisdictionKey))
    .filter((a) => a.id.length > 0);
}

/** TEST-ONLY: override env resolution for unit tests. */
export function __testOnlySubstrateEnv(
  overrides: { baseUrl?: string; apiKey?: string } | null,
): void {
  if (!overrides) {
    delete process.env.__TEST_SUBSTRATE_BASE__;
    delete process.env.__TEST_SUBSTRATE_KEY__;
    return;
  }
  if (overrides.baseUrl !== undefined) {
    process.env.__TEST_SUBSTRATE_BASE__ = overrides.baseUrl;
  }
  if (overrides.apiKey !== undefined) {
    process.env.__TEST_SUBSTRATE_KEY__ = overrides.apiKey;
  }
}
