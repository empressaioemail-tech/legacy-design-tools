/**
 * Briefing-engine LLM client. Mirrors the {@link findingLlmClient}
 * pattern: lazy singleton off `BRIEFING_LLM_MODE`.
 *
 *   - `mock` (must be explicit — unset env fails loud): null —
 *     deterministic mock generator.
 *   - `anthropic`: Anthropic Claude Sonnet 4.5 (Spec 51 / DA-PI-3) — the
 *     only LLM provider (G-309 A20).
 *   - `grok`: rejected — `resolveBriefingLlmMode` throws a config error.
 *
 * AI chat (`routes/chat.ts`) stays on Anthropic regardless of briefing mode.
 */

import {
  resolveBriefingLlmMode,
  type BriefingLlmMode,
} from "@workspace/briefing-engine";
import { logger } from "./logger";

type AnthropicClient = Awaited<
  ReturnType<
    typeof import("@workspace/integrations-anthropic-ai")["createAnthropicClient"]
  >
>;

export type BriefingLlmClientBundle =
  | { kind: "anthropic"; client: AnthropicClient }
  | null;

let cachedAnthropic: AnthropicClient | null = null;
let cachedFromEnv = true;
let cachedMode: BriefingLlmMode = "mock";
let cacheInitialized = false;

export async function getBriefingLlmClient(): Promise<BriefingLlmClientBundle> {
  if (cacheInitialized) {
    if (cachedMode === "anthropic" && cachedAnthropic) {
      return { kind: "anthropic", client: cachedAnthropic };
    }
    return null;
  }
  const mode = resolveBriefingLlmMode();
  cachedMode = mode;
  cachedFromEnv = true;

  if (mode === "anthropic") {
    const integrations = await import("@workspace/integrations-anthropic-ai");
    cachedAnthropic = integrations.createAnthropicClient();
    cacheInitialized = true;
    logger.info(
      { mode: "anthropic" },
      "briefing LLM client wired to Anthropic Claude Sonnet 4.5",
    );
    return { kind: "anthropic", client: cachedAnthropic };
  }

  cachedAnthropic = null;
  cacheInitialized = true;
  logger.info(
    { mode: "mock" },
    "briefing LLM client wired in mock mode (no network calls)",
  );
  return null;
}

export function setBriefingLlmClient(
  bundle: BriefingLlmClientBundle | AnthropicClient | null,
): void {
  if (bundle === null) {
    cachedAnthropic = null;
    cacheInitialized = false;
    cachedFromEnv = true;
    cachedMode = resolveBriefingLlmMode();
    return;
  }
  if ("kind" in bundle) {
    cachedAnthropic = bundle.client;
    cachedMode = "anthropic";
    cacheInitialized = true;
    cachedFromEnv = false;
    return;
  }
  cachedAnthropic = bundle;
  cachedMode = "anthropic";
  cacheInitialized = true;
  cachedFromEnv = false;
}

export function getBriefingLlmMode(): BriefingLlmMode {
  if (!cacheInitialized) {
    cachedMode = resolveBriefingLlmMode();
  }
  return cachedMode;
}

export function __briefingLlmClientIsFromEnvForTests(): boolean {
  return cachedFromEnv;
}

export function validateBriefingEngineEnvAtBoot(): void {
  // resolveBriefingLlmMode throws on BRIEFING_LLM_MODE=grok (G-309 A20).
  const mode = resolveBriefingLlmMode();
  if (mode !== "anthropic") return;
  const apiKey = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
  const baseUrl = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
  if (!apiKey || !baseUrl) {
    const missing: string[] = [];
    if (!apiKey) missing.push("AI_INTEGRATIONS_ANTHROPIC_API_KEY");
    if (!baseUrl) missing.push("AI_INTEGRATIONS_ANTHROPIC_BASE_URL");
    throw new Error(
      `BRIEFING_LLM_MODE=anthropic requires ${missing.join(" and ")} to be set`,
    );
  }
}
