/**
 * Substrate retrieval-api client — spine code search through the gate seam.
 *
 * Used when `BRIEF_CODE_RETRIEVAL=gate|mcp`, when brokerage brief gate cut is on,
 * or when `BRIEF_RETRIEVAL_API_URL` is mounted (prod default: substrate-first
 * over stale Neon warmup for jurisdictions like Bastrop BDC).
 * Calls retrieval-api `GET /search` (same contract the MCP gate proxies).
 */

import type { OrchestratorLogger } from "./orchestrator";
import type { RetrievedAtom } from "./retrieval";

export interface SubstrateSearchOptions {
  jurisdictionKey: string;
  question: string;
  limit?: number;
  logger?: OrchestratorLogger;
}

export type SubstrateRetrievalFailureReason =
  | "not_configured"
  | "unreachable"
  | "http_error"
  | "invalid_response";

/** Distinguishes substrate failure from a successful search with zero hits. */
export class SubstrateRetrievalError extends Error {
  readonly name = "SubstrateRetrievalError";

  constructor(
    readonly reason: SubstrateRetrievalFailureReason,
    message: string,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export function isSubstrateRetrievalError(
  error: unknown,
): error is SubstrateRetrievalError {
  return error instanceof SubstrateRetrievalError;
}

function resolveSubstrateBaseUrl(): string | null {
  const testOverride = process.env.__TEST_SUBSTRATE_BASE__?.trim();
  if (testOverride) return testOverride.replace(/\/$/, "");
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

/** True when cortex-api can reach retrieval-api (prod mounts BRIEF_RETRIEVAL_API_URL). */
export function isSubstrateRetrievalConfigured(): boolean {
  return resolveSubstrateBaseUrl() !== null;
}

function resolveSubstrateApiKey(): string | null {
  const testOverride = process.env.__TEST_SUBSTRATE_KEY__?.trim();
  if (testOverride) return testOverride;
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

/** Strip `did:hauska:code-section:` prefix; prefer stable entityId for citations. */
function substrateCitationId(hit: {
  atomDid?: string;
  entityId?: string;
}): string {
  const entityId = String(hit.entityId ?? "").trim();
  if (entityId) return entityId;
  const rawDid = String(hit.atomDid ?? "").trim();
  const prefix = "did:hauska:code-section:";
  if (rawDid.startsWith(prefix)) return rawDid.slice(prefix.length);
  return rawDid;
}

function sectionLabelFromEntityId(entityId: string): {
  sectionNumber: string | null;
  codeBook: string;
  edition: string;
} {
  const slash = entityId.indexOf("/");
  if (slash === -1) {
    return { sectionNumber: null, codeBook: entityId, edition: entityId };
  }
  const edition = entityId.slice(0, slash);
  const sectionNumber = entityId.slice(slash + 1) || null;
  const bdcIdx = edition.indexOf("-bdc-");
  const codeBook =
    bdcIdx >= 0 ? "BDC" : edition.includes("b3-code") ? "B3" : edition;
  return { sectionNumber, codeBook, edition };
}

function mapSubstrateHit(
  hit: {
    atomDid?: string;
    entityId?: string;
    snippet?: string;
    score?: number;
    sectionNumber?: string | null;
    jurisdictionTenant?: string;
  },
  jurisdictionKey: string,
): RetrievedAtom {
  const id = substrateCitationId(hit);
  const snippet = String(hit.snippet ?? "").trim();
  const parsed = sectionLabelFromEntityId(id);
  const sectionNumber = hit.sectionNumber ?? parsed.sectionNumber;
  const sectionTitle = sectionNumber ? `§${sectionNumber}` : null;
  return {
    id,
    sourceName: "substrate",
    jurisdictionKey: hit.jurisdictionTenant?.trim() || jurisdictionKey,
    codeBook: parsed.codeBook,
    edition: parsed.edition,
    sectionNumber,
    sectionTitle,
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
    throw new SubstrateRetrievalError(
      "not_configured",
      "Code retrieval substrate is not configured",
    );
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

  const jurisdictionTenant = process.env.BROKERAGE_GATE_JURISDICTION_TENANT?.trim();
  if (jurisdictionTenant) {
    headers["x-hauska-jurisdiction-tenant"] = jurisdictionTenant;
  }

  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  } catch (cause) {
    opts.logger?.warn?.(
      { err: cause, jurisdictionKey: opts.jurisdictionKey },
      "substrate retrieval: unreachable",
    );
    throw new SubstrateRetrievalError(
      "unreachable",
      "Code retrieval substrate is unreachable",
      undefined,
      { cause },
    );
  }
  if (!res.ok) {
    opts.logger?.warn?.(
      { status: res.status, jurisdictionKey: opts.jurisdictionKey },
      "substrate retrieval: HTTP error",
    );
    throw new SubstrateRetrievalError(
      "http_error",
      `Code retrieval substrate returned HTTP ${res.status}`,
      res.status,
    );
  }

  let body: {
    results?: Array<{
      atomDid?: string;
      entityId?: string;
      snippet?: string;
      score?: number;
      sectionNumber?: string | null;
      jurisdictionTenant?: string;
    }>;
  };
  try {
    body = (await res.json()) as typeof body;
  } catch (cause) {
    opts.logger?.warn?.(
      { err: cause, jurisdictionKey: opts.jurisdictionKey },
      "substrate retrieval: invalid JSON response",
    );
    throw new SubstrateRetrievalError(
      "invalid_response",
      "Code retrieval substrate returned invalid JSON",
      res.status,
      { cause },
    );
  }

  if (!Array.isArray(body.results)) {
    opts.logger?.warn?.(
      { jurisdictionKey: opts.jurisdictionKey },
      "substrate retrieval: response missing results array",
    );
    throw new SubstrateRetrievalError(
      "invalid_response",
      "Code retrieval substrate response is missing results",
      res.status,
    );
  }

  return body.results
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
