/**
 * Hauska substrate client — reads the live Hauska code catalog so Cortex
 * surfaces (the Code Library, QA-17) can list every ingested jurisdiction
 * instead of only the two with a cortex-prod-local `code_atoms` corpus.
 *
 * Picks an implementation off `HAUSKA_SUBSTRATE_MODE`:
 *   - `mock` (default): returns a hermetic fixture catalog so dev/CI run
 *     without a live substrate or an authenticated key.
 *   - `mcp`: calls the deployed Hauska MCP server's `list_jurisdictions`
 *     tool over the Model Context Protocol Streamable HTTP transport,
 *     authenticated with a Cortex product key in the `X-Hauska-Key`
 *     header. Throws at first use if either env var is missing.
 *
 * Why the MCP server and not the hauska-engine retrieval API directly:
 * QA-17's dispatch recommended it, and doc 28 (MCP-first product design)
 * makes it the principle — Cortex consumes the same MCP surface external
 * agents use rather than reaching past it. It is also where the ADR-017
 * `accessPolicy` visibility partition lives: `list_jurisdictions`
 * forwards a per-tier `accessPolicies` filter to the engine, so an
 * authenticated Cortex key sees the `platform-internal` jurisdictions
 * (Bastrop County, Elgin, Hutto) while an unauthenticated caller sees
 * only the `public-free` ones. See `44_mcp_cortex_architecture_map.md`
 * and `50_hauska_mcp_server.md` in the doc repo.
 *
 * This is the framework-proving first pass: it proves the cortex-api →
 * Hauska-substrate wiring end to end. `mock` mode keeps CI green; the
 * operator flips `HAUSKA_SUBSTRATE_MODE=mcp` with a minted product key
 * for the live end-to-end verification.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { logger } from "./logger";

/**
 * ADR-017 atom access tier, per `@hauska/atom-contract@^1.1.0`. The
 * substrate stamps this on each `jurisdiction-corpus` atom; surfaces
 * that gate on visibility branch on it. A jurisdiction that omits the
 * field on the wire is treated as `"public-free"`.
 */
export type SubstrateAccessPolicy =
  | "public-free"
  | "public-paid"
  | "platform-internal"
  | "tenant-private";

const ACCESS_POLICIES: ReadonlySet<string> = new Set<SubstrateAccessPolicy>([
  "public-free",
  "public-paid",
  "platform-internal",
  "tenant-private",
]);

function isAccessPolicy(v: unknown): v is SubstrateAccessPolicy {
  return typeof v === "string" && ACCESS_POLICIES.has(v);
}

/** One jurisdiction as the Code Library renders it. */
export interface SubstrateJurisdiction {
  /** Stable jurisdiction tenant slug from the substrate, e.g. `bastrop-tx`. */
  key: string;
  /** Human display name. Falls back to `key` when the wire omits it. */
  displayName: string;
  /** Atom count in the substrate corpus for this jurisdiction. */
  atomCount: number;
  /** ADR-017 access tier. Absent on the wire ⇒ `"public-free"`. */
  accessPolicy: SubstrateAccessPolicy;
  /** Eval-harness quality bar (`passing`, `failing`, `not-evaluated`, …). */
  qualityBar: string;
  /** Corpus drift status (`clean`, `amendments-pending`, `stale`). */
  driftStatus: string;
  /** ISO timestamp the corpus was last refreshed; null when never. */
  lastRefreshedAt: string | null;
}

export interface SubstrateCatalog {
  /**
   * `mcp` when the catalog came live from the Hauska MCP server;
   * `mock` for the hermetic fixture. Surfaced so the UI (and an
   * operator verifying QA-17) can tell a real call from the fixture.
   */
  source: "mcp" | "mock";
  jurisdictions: SubstrateJurisdiction[];
  /** Full catalog size before optional `states` / `keys` / `q` filter (v3). */
  total?: number;
  /** Rows returned after filter (v3). */
  filtered?: number;
}

/**
 * Surfaced verbatim by the route as `code`. `substrate_unreachable` is
 * operator-actionable (URL wrong, server down, key rejected at connect);
 * `substrate_rejected` means the MCP tool itself returned an error
 * envelope; `substrate_invalid_response` means a 200 came back in a
 * shape we don't trust.
 */
export class SubstrateError extends Error {
  constructor(
    public readonly code:
      | "substrate_unreachable"
      | "substrate_rejected"
      | "substrate_invalid_response"
      | "substrate_unknown",
    message: string,
  ) {
    super(message);
    this.name = "SubstrateError";
    Object.setPrototypeOf(this, SubstrateError.prototype);
  }
}

export interface HauskaSubstrateClient {
  listJurisdictions(): Promise<SubstrateCatalog>;
}

// ---------------------------------------------------------------------------
// Mock client
// ---------------------------------------------------------------------------

/**
 * Hermetic fixture catalog: the five jurisdictions QA-17 expects the
 * Code Library to list once cortex-api is wired to the substrate — two
 * `public-free`, three `platform-internal`. Atom counts are illustrative
 * fixtures (Hutto's 1716 matches the QA-10 UDC ingest; the rest are
 * representative). REAL counts come from `mcp` mode against the live
 * substrate — `mock` mode exists to prove the wiring and the UI without
 * a minted product key.
 */
export const MOCK_SUBSTRATE_JURISDICTIONS: ReadonlyArray<SubstrateJurisdiction> =
  [
    {
      key: "grand-county-ut",
      displayName: "Grand County, UT",
      atomCount: 290,
      accessPolicy: "public-free",
      qualityBar: "passing",
      driftStatus: "clean",
      lastRefreshedAt: "2026-05-19T00:00:00.000Z",
    },
    {
      key: "bastrop-tx",
      displayName: "Bastrop, TX",
      atomCount: 412,
      accessPolicy: "public-free",
      qualityBar: "passing",
      driftStatus: "clean",
      lastRefreshedAt: "2026-05-19T00:00:00.000Z",
    },
    {
      key: "bastrop-county-tx",
      displayName: "Bastrop County, TX",
      atomCount: 357,
      accessPolicy: "platform-internal",
      qualityBar: "passing",
      driftStatus: "clean",
      lastRefreshedAt: "2026-05-19T00:00:00.000Z",
    },
    {
      key: "elgin-tx",
      displayName: "Elgin, TX",
      atomCount: 268,
      accessPolicy: "platform-internal",
      qualityBar: "passing",
      driftStatus: "clean",
      lastRefreshedAt: "2026-05-19T00:00:00.000Z",
    },
    {
      key: "hutto-tx",
      displayName: "Hutto, TX",
      atomCount: 1716,
      accessPolicy: "platform-internal",
      qualityBar: "passing",
      driftStatus: "clean",
      lastRefreshedAt: "2026-05-19T00:00:00.000Z",
    },
  ];

export interface MockHauskaSubstrateClientOptions {
  /** When set, `listJurisdictions` throws this instead of returning. */
  failWith?: SubstrateError;
  /** Override the fixture set (tests pin specific shapes). */
  jurisdictions?: ReadonlyArray<SubstrateJurisdiction>;
}

export class MockHauskaSubstrateClient implements HauskaSubstrateClient {
  constructor(private readonly opts: MockHauskaSubstrateClientOptions = {}) {}

  async listJurisdictions(): Promise<SubstrateCatalog> {
    if (this.opts.failWith) throw this.opts.failWith;
    return {
      source: "mock",
      jurisdictions: [
        ...(this.opts.jurisdictions ?? MOCK_SUBSTRATE_JURISDICTIONS),
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// MCP client
// ---------------------------------------------------------------------------

/**
 * The `list_jurisdictions` tool wraps the engine payload in the
 * atom-shape envelope (`atom-shape.ts` in hauska-mcp-server): the
 * jurisdiction list lives under `data.jurisdictions`. Each row is a
 * `JurisdictionStatusSnapshot`.
 */
interface RawSnapshot {
  jurisdictionTenant?: unknown;
  jurisdictionName?: unknown;
  atomCount?: unknown;
  accessPolicy?: unknown;
  qualityBar?: unknown;
  driftStatus?: unknown;
  lastRefreshedAt?: unknown;
}

/** Minimal view of an MCP `tools/call` result — see `@modelcontextprotocol/sdk`. */
interface ToolCallResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

function snapshotToJurisdiction(raw: RawSnapshot): SubstrateJurisdiction | null {
  const key =
    typeof raw.jurisdictionTenant === "string" && raw.jurisdictionTenant
      ? raw.jurisdictionTenant
      : null;
  if (!key) return null;
  return {
    key,
    displayName:
      typeof raw.jurisdictionName === "string" && raw.jurisdictionName
        ? raw.jurisdictionName
        : key,
    atomCount: typeof raw.atomCount === "number" ? raw.atomCount : 0,
    // ADR-017: an absent accessPolicy is treated as public-free, matching
    // the engine docstring and `@hauska/atom-contract` semantics.
    accessPolicy: isAccessPolicy(raw.accessPolicy)
      ? raw.accessPolicy
      : "public-free",
    qualityBar:
      typeof raw.qualityBar === "string" ? raw.qualityBar : "not-evaluated",
    driftStatus:
      typeof raw.driftStatus === "string" ? raw.driftStatus : "clean",
    lastRefreshedAt:
      typeof raw.lastRefreshedAt === "string" ? raw.lastRefreshedAt : null,
  };
}

/**
 * Parse an MCP `list_jurisdictions` tool result into substrate
 * jurisdictions. Exported for direct unit testing without a live server.
 *
 * The result carries one text content block holding the JSON-stringified
 * atom-shape envelope `{ data: { jurisdictions: [...] }, atoms, meta }`.
 */
export function parseListJurisdictionsResult(
  result: ToolCallResult,
): SubstrateJurisdiction[] {
  const text = result.content?.find((c) => c.type === "text")?.text;
  if (!text) {
    throw new SubstrateError(
      "substrate_invalid_response",
      "list_jurisdictions returned no text content block",
    );
  }
  // A tool-level error comes back with isError=true and a plain-string
  // message rather than the envelope JSON.
  if (result.isError) {
    throw new SubstrateError(
      "substrate_rejected",
      `list_jurisdictions tool error: ${text.slice(0, 300)}`,
    );
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new SubstrateError(
      "substrate_invalid_response",
      `list_jurisdictions returned non-JSON content: ${text.slice(0, 200)}`,
    );
  }

  const data = (envelope as { data?: unknown } | null)?.data;
  const rows = (data as { jurisdictions?: unknown } | null)?.jurisdictions;
  if (!Array.isArray(rows)) {
    throw new SubstrateError(
      "substrate_invalid_response",
      "list_jurisdictions envelope is missing data.jurisdictions[]",
    );
  }

  const out: SubstrateJurisdiction[] = [];
  for (const row of rows) {
    const j = snapshotToJurisdiction((row ?? {}) as RawSnapshot);
    if (j) out.push(j);
  }
  return out;
}

export interface McpHauskaSubstrateClientOptions {
  /** Full MCP endpoint URL including the `/mcp` path. */
  url: string;
  /** Cortex product key, sent as the `X-Hauska-Key` header. */
  key: string;
  /** Overall connect+call budget. Default 15 s. */
  timeoutMs?: number;
}

/**
 * Production client. Connects to the Hauska MCP server with the official
 * `@modelcontextprotocol/sdk` client — the same client an external agent
 * uses, so Cortex genuinely dogfoods the public surface — and calls the
 * `list_jurisdictions` tool. The stateless server builds a fresh
 * transport per request; the SDK handles the initialize handshake and
 * the Streamable HTTP framing. Mirrors `examples/catalog-agent` in the
 * hauska-mcp-server repo.
 */
export class McpHauskaSubstrateClient implements HauskaSubstrateClient {
  private readonly timeoutMs: number;

  constructor(private readonly opts: McpHauskaSubstrateClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async listJurisdictions(): Promise<SubstrateCatalog> {
    const transport = new StreamableHTTPClientTransport(new URL(this.opts.url), {
      requestInit: { headers: { "X-Hauska-Key": this.opts.key } },
    });
    const client = new Client({ name: "cortex-api", version: "0.1.0" });

    try {
      const jurisdictions = await withTimeout(
        this.timeoutMs,
        (async () => {
          await client.connect(transport);
          const result = (await client.callTool({
            name: "list_jurisdictions",
            arguments: { quality_bar_only: false },
          })) as ToolCallResult;
          return parseListJurisdictionsResult(result);
        })(),
      );
      logger.info(
        { mode: "mcp", count: jurisdictions.length },
        "hauska substrate: list_jurisdictions ok",
      );
      return { source: "mcp", jurisdictions };
    } catch (err) {
      if (err instanceof SubstrateError) throw err;
      // connect() / callTool() failures (server down, bad URL, key
      // rejected, transport error) all collapse to "unreachable" — the
      // operator-actionable bucket.
      throw new SubstrateError(
        "substrate_unreachable",
        `Hauska MCP server request failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      // Best-effort close; a failed close must not mask the real error.
      await client.close().catch(() => {});
    }
  }
}

function withTimeout<T>(ms: number, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new SubstrateError(
          "substrate_unreachable",
          `Hauska MCP server did not respond within ${ms} ms`,
        ),
      );
    }, ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Env factory + process-wide singleton
// ---------------------------------------------------------------------------

/** Lazily-resolved process-wide singleton; tests override via setHauskaSubstrateClient. */
let cached: HauskaSubstrateClient | null = null;
let cachedFromEnv = true;

let catalogCache: { fetchedAt: number; catalog: SubstrateCatalog } | null =
  null;

function catalogCacheTtlMs(): number {
  const raw = process.env.SUBSTRATE_CATALOG_CACHE_TTL_MS;
  const n = raw ? Number(raw) : 600_000;
  return Number.isFinite(n) && n > 0 ? n : 600_000;
}

class CachedHauskaSubstrateClient implements HauskaSubstrateClient {
  constructor(private readonly inner: HauskaSubstrateClient) {}

  async listJurisdictions(): Promise<SubstrateCatalog> {
    const ttl = catalogCacheTtlMs();
    if (catalogCache && Date.now() - catalogCache.fetchedAt < ttl) {
      logger.info(
        { mode: catalogCache.catalog.source, count: catalogCache.catalog.jurisdictions.length },
        "hauska substrate: cache hit",
      );
      return catalogCache.catalog;
    }
    const catalog = await this.inner.listJurisdictions();
    catalogCache = { fetchedAt: Date.now(), catalog };
    logger.info(
      { mode: catalog.source, count: catalog.jurisdictions.length },
      "hauska substrate: cache miss",
    );
    return catalog;
  }
}

export function clearHauskaSubstrateCatalogCache(): void {
  catalogCache = null;
}

/** Operator QA — substrate mode + cache snapshot (no MCP round-trip). */
export function getSubstrateHealthSnapshot(): {
  mode: string;
  mcpUrlConfigured: boolean;
  mcpKeyConfigured: boolean;
  cacheAgeMs: number | null;
  cachedJurisdictionCount: number | null;
  cachedSource: SubstrateCatalog["source"] | null;
} {
  const mode = (process.env.HAUSKA_SUBSTRATE_MODE ?? "mock").toLowerCase();
  return {
    mode,
    mcpUrlConfigured: Boolean(process.env.HAUSKA_MCP_URL?.trim()),
    mcpKeyConfigured: Boolean(process.env.HAUSKA_MCP_KEY?.trim()),
    cacheAgeMs: catalogCache
      ? Date.now() - catalogCache.fetchedAt
      : null,
    cachedJurisdictionCount: catalogCache?.catalog.jurisdictions.length ?? null,
    cachedSource: catalogCache?.catalog.source ?? null,
  };
}

export function getHauskaSubstrateClient(): HauskaSubstrateClient {
  if (cached) return cached;
  cached = new CachedHauskaSubstrateClient(buildFromEnv());
  cachedFromEnv = true;
  return cached;
}

export function setHauskaSubstrateClient(
  client: HauskaSubstrateClient | null,
): void {
  catalogCache = null;
  cached = client ? new CachedHauskaSubstrateClient(client) : null;
  cachedFromEnv = client === null;
}

function buildFromEnv(): HauskaSubstrateClient {
  const mode = (process.env.HAUSKA_SUBSTRATE_MODE ?? "mock").toLowerCase();
  if (mode === "mcp") {
    const url = process.env.HAUSKA_MCP_URL;
    const key = process.env.HAUSKA_MCP_KEY;
    if (!url || !key) {
      throw new Error(
        "HAUSKA_SUBSTRATE_MODE=mcp requires HAUSKA_MCP_URL and HAUSKA_MCP_KEY to be set",
      );
    }
    logger.info({ mode: "mcp", url }, "Hauska substrate client wired in MCP mode");
    return new McpHauskaSubstrateClient({ url, key });
  }
  if (mode !== "mock") {
    logger.warn(
      { mode },
      "HAUSKA_SUBSTRATE_MODE is not 'mcp' or 'mock' — falling back to mock client",
    );
  }
  logger.info({ mode: "mock" }, "Hauska substrate client wired in mock mode");
  return new MockHauskaSubstrateClient();
}

/**
 * Boot-time fail-fast: when HAUSKA_SUBSTRATE_MODE=mcp, refuse to start
 * unless HAUSKA_MCP_URL and HAUSKA_MCP_KEY are both set. Called from the
 * server entrypoint so a misconfigured deploy surfaces at boot rather
 * than at the first Code Library request. Mock mode (the default) boots
 * clean with no env config.
 */
export function validateHauskaSubstrateEnvAtBoot(): void {
  const mode = (process.env.HAUSKA_SUBSTRATE_MODE ?? "mock").toLowerCase();
  if (mode !== "mcp") return;
  const url = process.env.HAUSKA_MCP_URL;
  const key = process.env.HAUSKA_MCP_KEY;
  if (!url || !key) {
    throw new Error(
      "HAUSKA_SUBSTRATE_MODE=mcp requires HAUSKA_MCP_URL and HAUSKA_MCP_KEY to be set",
    );
  }
}

/** Test-only: tells you whether the cached client came from the env factory. */
export function __hauskaSubstrateClientIsFromEnvForTests(): boolean {
  return cachedFromEnv;
}
