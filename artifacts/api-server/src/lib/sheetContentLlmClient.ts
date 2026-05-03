/**
 * Sheet-content LLM client (Task #477). Mirrors the briefing/finding
 * client pattern verbatim: a `getSheetContentLlmClient()` lazily resolves
 * a process-wide singleton off `SHEET_CONTENT_LLM_MODE` and tests can
 * override via `setSheetContentLlmClient()`.
 *
 *   - `mock` (default): no client at all — the extractor returns null
 *     and the sheet row's `content_body` stays whatever the metadata
 *     supplied (typically null). This is what dev / CI use until a
 *     deploy explicitly opts in to the vision pass.
 *   - `anthropic`: returns the workspace's lazily-constructed Anthropic
 *     SDK client (Claude Sonnet 4.5). Requires the AI Integrations
 *     Anthropic env vars `AI_INTEGRATIONS_ANTHROPIC_API_KEY` +
 *     `..._BASE_URL`.
 *
 * The mock branch is represented as `null` (rather than a stub object)
 * so the extractor's "no client → mock pass" branch fires on a single
 * null check.
 */

import { logger } from "./logger";

export type SheetContentLlmMode = "mock" | "anthropic";

type AnthropicClient = Awaited<
  ReturnType<
    typeof import("@workspace/integrations-anthropic-ai")["createAnthropicClient"]
  >
>;

let cached: AnthropicClient | null = null;
let cachedFromEnv = true;
let cachedMode: SheetContentLlmMode = "mock";
let cacheInitialized = false;

/** Read the mode from env, defaulting to `mock` for safety. */
export function resolveSheetContentLlmMode(): SheetContentLlmMode {
  const raw = (process.env["SHEET_CONTENT_LLM_MODE"] ?? "mock").toLowerCase();
  return raw === "anthropic" ? "anthropic" : "mock";
}

/**
 * Returns the Anthropic SDK client when `SHEET_CONTENT_LLM_MODE=anthropic`,
 * `null` otherwise.
 */
export async function getSheetContentLlmClient(): Promise<AnthropicClient | null> {
  if (cacheInitialized) return cached;
  const mode = resolveSheetContentLlmMode();
  cachedMode = mode;
  cachedFromEnv = true;
  if (mode === "anthropic") {
    const integrations = await import("@workspace/integrations-anthropic-ai");
    cached = integrations.createAnthropicClient();
    cacheInitialized = true;
    logger.info(
      { mode: "anthropic" },
      "sheet-content LLM client wired to Anthropic Claude Sonnet 4.5",
    );
  } else {
    cached = null;
    cacheInitialized = true;
    logger.info(
      { mode: "mock" },
      "sheet-content LLM client wired in mock mode (no network calls)",
    );
  }
  return cached;
}

/**
 * Test-only override. Pass `null` to reset to the env-derived client
 * (the next `getSheetContentLlmClient()` call re-reads
 * `SHEET_CONTENT_LLM_MODE`).
 */
export function setSheetContentLlmClient(
  client: AnthropicClient | null,
): void {
  if (client === null) {
    cached = null;
    cacheInitialized = false;
    cachedFromEnv = true;
    cachedMode = resolveSheetContentLlmMode();
    return;
  }
  cached = client;
  cacheInitialized = true;
  cachedFromEnv = false;
  cachedMode = "anthropic";
}

/** Returns the resolved mode for log lines / status payloads. */
export function getSheetContentLlmMode(): SheetContentLlmMode {
  if (!cacheInitialized) {
    cachedMode = resolveSheetContentLlmMode();
  }
  return cachedMode;
}

/** Test-only: reports whether the cached client came from the env factory. */
export function __sheetContentLlmClientIsFromEnvForTests(): boolean {
  return cachedFromEnv;
}

/**
 * Boot-time fail-fast: when `SHEET_CONTENT_LLM_MODE=anthropic`, refuse
 * to start if the AI Integrations env vars are missing. Mirrors the
 * other engine boot validators.
 */
export function validateSheetContentEnvAtBoot(): void {
  const mode = resolveSheetContentLlmMode();
  if (mode !== "anthropic") return;
  const apiKey = process.env["AI_INTEGRATIONS_ANTHROPIC_API_KEY"];
  const baseUrl = process.env["AI_INTEGRATIONS_ANTHROPIC_BASE_URL"];
  if (!apiKey || !baseUrl) {
    const missing: string[] = [];
    if (!apiKey) missing.push("AI_INTEGRATIONS_ANTHROPIC_API_KEY");
    if (!baseUrl) missing.push("AI_INTEGRATIONS_ANTHROPIC_BASE_URL");
    throw new Error(
      `SHEET_CONTENT_LLM_MODE=anthropic requires ${missing.join(" and ")} to be set`,
    );
  }
}
