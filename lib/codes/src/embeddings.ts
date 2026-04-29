/**
 * Lightweight OpenAI embeddings client.
 *
 * Model: text-embedding-3-small (1536-dim) — matches code_atoms.embedding type.
 *
 * Designed to be safe in environments where OPENAI_API_KEY is unset:
 *   - embedTexts() returns nulls (one per input) instead of throwing.
 *   - We log a single warning per BACKOFF_MS window (default 1h) so the
 *     warmup loop doesn't spam logs.
 *   - Atoms are still upserted; the orchestrator records embeddedAt=null and
 *     a later pass can backfill once the key is provisioned.
 */

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;

const OPENAI_BASE = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const BACKOFF_MS = 60 * 60 * 1000; // 1 hour

let lastMissingKeyWarnAt = 0;

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
}

export interface EmbedResult {
  /** Same length as input; entries may be null if embedding was skipped. */
  vectors: Array<number[] | null>;
  /** True when at least one vector was produced. */
  embeddedAny: boolean;
  /** Reason for skipping, when applicable. */
  skipReason?: "no_api_key" | "request_failed";
}

export function isEmbeddingAvailable(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

function maybeWarnMissingKey(logger?: { warn: (obj: unknown, msg: string) => void }) {
  const now = Date.now();
  if (now - lastMissingKeyWarnAt < BACKOFF_MS) return;
  lastMissingKeyWarnAt = now;
  const msg =
    "OPENAI_API_KEY not set — skipping atom embedding. Atoms will be stored without vectors and can be backfilled later.";
  if (logger) logger.warn({ model: EMBEDDING_MODEL }, msg);
  else console.warn(msg);
}

export interface EmbedTextsOptions {
  logger?: {
    warn: (obj: unknown, msg: string) => void;
    error?: (obj: unknown, msg: string) => void;
  };
  /**
   * TEST-ONLY. When provided, used in place of the global `fetch` to call
   * OpenAI. Production code must NOT pass this. Used by api-server route
   * tests to deterministically simulate embedding responses without
   * network access.
   */
  fetcher?: typeof fetch;
}

export async function embedTexts(
  inputs: string[],
  opts: EmbedTextsOptions = {},
): Promise<EmbedResult> {
  if (inputs.length === 0) {
    return { vectors: [], embeddedAny: false };
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    maybeWarnMissingKey(opts.logger);
    return {
      vectors: inputs.map(() => null),
      embeddedAny: false,
      skipReason: "no_api_key",
    };
  }

  // OpenAI requires non-empty strings; clamp aggressively because some PDF
  // chunks can be huge. ~32k chars ≈ 8k tokens which is well under the
  // text-embedding-3-small 8191-token cap with margin.
  const safeInputs = inputs.map((s) => (s ?? "").slice(0, 32000) || " ");

  const fetchImpl = opts.fetcher ?? fetch;

  try {
    const res = await fetchImpl(`${OPENAI_BASE}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: safeInputs,
        dimensions: EMBEDDING_DIMENSIONS,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const msg = `OpenAI /embeddings -> HTTP ${res.status}: ${body.slice(0, 200)}`;
      if (opts.logger?.error) opts.logger.error({ status: res.status }, msg);
      else console.error(msg);
      return { vectors: inputs.map(() => null), embeddedAny: false, skipReason: "request_failed" };
    }
    const json = (await res.json()) as OpenAIEmbeddingResponse;
    const out: Array<number[] | null> = inputs.map(() => null);
    for (const row of json.data) {
      out[row.index] = row.embedding;
    }
    return { vectors: out, embeddedAny: out.some((v) => v !== null) };
  } catch (err) {
    const msg = `OpenAI /embeddings request failed: ${err instanceof Error ? err.message : String(err)}`;
    if (opts.logger?.error) opts.logger.error({ err }, msg);
    else console.error(msg);
    return { vectors: inputs.map(() => null), embeddedAny: false, skipReason: "request_failed" };
  }
}

export async function embedQuery(
  q: string,
  opts: EmbedTextsOptions = {},
): Promise<number[] | null> {
  const r = await embedTexts([q], opts);
  return r.vectors[0] ?? null;
}
