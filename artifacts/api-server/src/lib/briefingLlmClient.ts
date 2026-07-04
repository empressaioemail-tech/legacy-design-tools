/**
 * Briefing-engine LLM client. Mirrors the {@link findingLlmClient}
 * pattern: lazy singleton off `BRIEFING_LLM_MODE`.
 *
 *   - `mock` (must be explicit — unset env fails loud): null —
 *     deterministic mock generator.
 *   - `grok`: xAI Grok via `@workspace/integrations-xai-grok`.
 *   - `anthropic`: Anthropic Claude Sonnet 4.5 (Spec 51 / DA-PI-3).
 *
 * AI chat (`routes/chat.ts`) stays on Anthropic regardless of briefing mode.
 */

import {
  resolveBriefingLlmMode,
  type BriefingLlmMode,
} from "@workspace/briefing-engine";
import type { GrokClient } from "@workspace/integrations-xai-grok";
import { logger } from "./logger";

type AnthropicClient = Awaited<
  ReturnType<
    typeof import("@workspace/integrations-anthropic-ai")["createAnthropicClient"]
  >
>;

export type BriefingLlmClientBundle =
  | { kind: "grok"; client: GrokClient }
  | { kind: "anthropic"; client: AnthropicClient }
  | null;

let cachedGrok: GrokClient | null = null;
let cachedAnthropic: AnthropicClient | null = null;
let cachedFromEnv = true;
let cachedMode: BriefingLlmMode = "mock";
let cacheInitialized = false;

export async function getBriefingLlmClient(): Promise<BriefingLlmClientBundle> {
  if (cacheInitialized) {
    if (cachedMode === "grok" && cachedGrok) {
      return { kind: "grok", client: cachedGrok };
    }
    if (cachedMode === "anthropic" && cachedAnthropic) {
      return { kind: "anthropic", client: cachedAnthropic };
    }
    return null;
  }
  const mode = resolveBriefingLlmMode();
  cachedMode = mode;
  cachedFromEnv = true;

  if (mode === "grok") {
    const { createGrokClient } = await import("@workspace/integrations-xai-grok");
    cachedGrok = createGrokClient();
    cachedAnthropic = null;
    cacheInitialized = true;
    logger.info(
      {
        mode: "grok",
        model:
          process.env.XAI_BRIEFING_MODEL ??
          process.env.XAI_MODEL ??
          "grok-3-mini",
      },
      "briefing LLM client wired to xAI Grok",
    );
    return { kind: "grok", client: cachedGrok };
  }

  if (mode === "anthropic") {
    const integrations = await import("@workspace/integrations-anthropic-ai");
    cachedAnthropic = integrations.createAnthropicClient();
    cachedGrok = null;
    cacheInitialized = true;
    logger.info(
      { mode: "anthropic" },
      "briefing LLM client wired to Anthropic Claude Sonnet 4.5",
    );
    return { kind: "anthropic", client: cachedAnthropic };
  }

  cachedGrok = null;
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
    cachedGrok = null;
    cachedAnthropic = null;
    cacheInitialized = false;
    cachedFromEnv = true;
    cachedMode = resolveBriefingLlmMode();
    return;
  }
  if ("kind" in bundle) {
    if (bundle.kind === "grok") {
      cachedGrok = bundle.client;
      cachedAnthropic = null;
      cachedMode = "grok";
    } else {
      cachedAnthropic = bundle.client;
      cachedGrok = null;
      cachedMode = "anthropic";
    }
    cacheInitialized = true;
    cachedFromEnv = false;
    return;
  }
  cachedAnthropic = bundle;
  cachedGrok = null;
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
  const mode = resolveBriefingLlmMode();
  if (mode === "grok") {
    if (!process.env.XAI_API_KEY?.trim()) {
      throw new Error(
        "BRIEFING_LLM_MODE=grok requires XAI_API_KEY to be set",
      );
    }
    return;
  }
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
