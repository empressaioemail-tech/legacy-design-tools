/**
 * Finding-engine LLM client. Mirrors the {@link briefingLlmClient}
 * pattern verbatim: a `getFindingLlmClient()` lazily resolves a
 * process-wide singleton off `AIR_FINDING_LLM_MODE` and tests can
 * override via `setFindingLlmClient()`.
 *
 *   - `mock` (default): no client at all — `generateFindings` runs
 *     the deterministic mock generator and never opens a network
 *     socket. This is what dev / CI / pre-Empressa-approval use.
 *   - `anthropic`: returns the workspace's lazily-constructed
 *     Anthropic SDK client (Claude Sonnet 4.5 per Phase 1A approval).
 *     Requires the AI Integrations Anthropic env vars
 *     `AI_INTEGRATIONS_ANTHROPIC_API_KEY` + `..._BASE_URL`.
 *
 * The mock branch is represented as `null` (rather than a stub
 * object) so the engine's "no anthropic client → mock generator"
 * branch can fire on a single null check instead of a sentinel-
 * instance check. Mirrors briefingLlmClient.ts:14-15.
 *
 * The function is async because the integrations module's top-level
 * code throws when its env vars are missing — we MUST defer the
 * import until we've confirmed we're on the anthropic branch.
 */

import {
  resolveFindingLlmMode,
  type FindingLlmMode,
} from "@workspace/finding-engine";
import { logger } from "./logger";

// The Anthropic SDK is only a transitive dep (via
// @workspace/integrations-anthropic-ai). Read the return type off the
// integration's `createAnthropicClient` factory — keeps us insulated
// from SDK version churn.
type AnthropicClient = Awaited<
  ReturnType<
    typeof import("@workspace/integrations-anthropic-ai")["createAnthropicClient"]
  >
>;

let cached: AnthropicClient | null = null;
let cachedFromEnv = true;
let cachedMode: FindingLlmMode = "mock";
let cacheInitialized = false;

/**
 * Returns the Anthropic SDK client when `AIR_FINDING_LLM_MODE=anthropic`,
 * `null` otherwise. The route hands the result straight to the engine
 * via the `anthropicClient` option.
 */
export async function getFindingLlmClient(): Promise<AnthropicClient | null> {
  if (cacheInitialized) return cached;
  const mode = resolveFindingLlmMode();
  cachedMode = mode;
  cachedFromEnv = true;
  if (mode === "anthropic") {
    // Dynamic import — keeps the integration module's env-var check
    // out of the load path when we're in mock mode.
    const integrations = await import("@workspace/integrations-anthropic-ai");
    cached = integrations.createAnthropicClient();
    cacheInitialized = true;
    logger.info(
      { mode: "anthropic" },
      "finding LLM client wired to Anthropic Claude Sonnet 4.5",
    );
  } else {
    cached = null;
    cacheInitialized = true;
    logger.info(
      { mode: "mock" },
      "finding LLM client wired in mock mode (no network calls)",
    );
  }
  return cached;
}

/**
 * Test-only override. Pass `null` to reset to the env-derived client
 * (the next `getFindingLlmClient()` call re-reads
 * `AIR_FINDING_LLM_MODE`).
 */
export function setFindingLlmClient(client: AnthropicClient | null): void {
  if (client === null) {
    cached = null;
    cacheInitialized = false;
    cachedFromEnv = true;
    cachedMode = resolveFindingLlmMode();
    return;
  }
  cached = client;
  cacheInitialized = true;
  cachedFromEnv = false;
  cachedMode = "anthropic";
}

/** Returns the resolved engine mode for log lines / status payloads. */
export function getFindingLlmMode(): FindingLlmMode {
  if (!cacheInitialized) {
    cachedMode = resolveFindingLlmMode();
  }
  return cachedMode;
}

/** Test-only: reports whether the cached client came from the env factory. */
export function __findingLlmClientIsFromEnvForTests(): boolean {
  return cachedFromEnv;
}

/**
 * Boot-time fail-fast: when `AIR_FINDING_LLM_MODE=anthropic`, refuse
 * to start if the AI Integrations env vars are missing. Surfaces at
 * boot rather than at the first finding-generation kickoff so a bad
 * deploy is caught immediately.
 *
 * Mock mode is the default and boots clean with no env config — the
 * mock client never reads the integration env vars.
 *
 * Mirrors `validateMnmlEnvAtBoot` / `validateConverterEnvAtBoot`.
 */
export function validateFindingEngineEnvAtBoot(): void {
  const mode = resolveFindingLlmMode();
  if (mode !== "anthropic") return;
  const apiKey = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
  const baseUrl = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
  if (!apiKey || !baseUrl) {
    const missing: string[] = [];
    if (!apiKey) missing.push("AI_INTEGRATIONS_ANTHROPIC_API_KEY");
    if (!baseUrl) missing.push("AI_INTEGRATIONS_ANTHROPIC_BASE_URL");
    throw new Error(
      `AIR_FINDING_LLM_MODE=anthropic requires ${missing.join(" and ")} to be set`,
    );
  }
}
