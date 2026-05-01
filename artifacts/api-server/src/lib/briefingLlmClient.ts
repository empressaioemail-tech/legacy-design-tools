/**
 * Briefing-engine LLM client. Mirrors the {@link converterClient} pattern:
 * a `getBriefingLlmClient()` lazily resolves a process-wide singleton off
 * `BRIEFING_LLM_MODE` and tests can override via `setBriefingLlmClient()`.
 *
 *   - `mock` (default): no client at all — `generateBriefing` runs the
 *     deterministic mock generator and never opens a network socket.
 *     This is what dev / CI / pre-Empressa-approval use.
 *   - `anthropic`: returns the workspace's lazily-constructed Anthropic
 *     SDK client (Claude Sonnet 4.5 per Spec 51 / DA-PI-3 locked
 *     decision #2). Requires the AI Integrations Anthropic env vars
 *     `AI_INTEGRATIONS_ANTHROPIC_API_KEY` + `..._BASE_URL`.
 *
 * The mock branch is represented as `null` (rather than a stub object)
 * so the engine's "no anthropic client → mock generator" branch can
 * fire on a single null check instead of a sentinel-instance check.
 *
 * The function is async because the integrations module's top-level
 * code throws when its env vars are missing — we MUST defer the import
 * until we've confirmed we're on the anthropic branch.
 */

import {
  resolveBriefingLlmMode,
  type BriefingLlmMode,
} from "@workspace/briefing-engine";
import { logger } from "./logger";

// The Anthropic SDK is only a transitive dep (via
// @workspace/integrations-anthropic-ai). Rather than add it to api-server's
// direct deps just for the return type, we read the return type off the
// integration's `createAnthropicClient` factory — that keeps us insulated
// from SDK version churn.
type AnthropicClient = Awaited<
  ReturnType<
    typeof import("@workspace/integrations-anthropic-ai")["createAnthropicClient"]
  >
>;

let cached: AnthropicClient | null = null;
let cachedFromEnv = true;
let cachedMode: BriefingLlmMode = "mock";
let cacheInitialized = false;

/**
 * Returns the Anthropic SDK client when `BRIEFING_LLM_MODE=anthropic`,
 * `null` otherwise. The route hands the result straight to the engine
 * via the `anthropicClient` option.
 */
export async function getBriefingLlmClient(): Promise<AnthropicClient | null> {
  if (cacheInitialized) return cached;
  const mode = resolveBriefingLlmMode();
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
      "briefing LLM client wired to Anthropic Claude Sonnet 4.5",
    );
  } else {
    cached = null;
    cacheInitialized = true;
    logger.info(
      { mode: "mock" },
      "briefing LLM client wired in mock mode (no network calls)",
    );
  }
  return cached;
}

/**
 * Test-only override. Pass `null` to reset to the env-derived client
 * (the next `getBriefingLlmClient()` call re-reads `BRIEFING_LLM_MODE`).
 */
export function setBriefingLlmClient(client: AnthropicClient | null): void {
  if (client === null) {
    cached = null;
    cacheInitialized = false;
    cachedFromEnv = true;
    cachedMode = resolveBriefingLlmMode();
    return;
  }
  cached = client;
  cacheInitialized = true;
  cachedFromEnv = false;
  cachedMode = "anthropic";
}

/** Returns the resolved engine mode for log lines / status payloads. */
export function getBriefingLlmMode(): BriefingLlmMode {
  if (!cacheInitialized) {
    cachedMode = resolveBriefingLlmMode();
  }
  return cachedMode;
}

/** Test-only: tells you whether the cached client came from the env factory. */
export function __briefingLlmClientIsFromEnvForTests(): boolean {
  return cachedFromEnv;
}
