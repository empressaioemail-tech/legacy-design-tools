/**
 * Finding-engine LLM client. Mirrors the {@link briefingLlmClient}
 * pattern: lazy singleton off `AIR_FINDING_LLM_MODE`.
 *
 *   - `mock` (default): null — deterministic mock generator.
 *   - `grok`: xAI Grok via `@workspace/integrations-xai-grok`.
 *   - `anthropic` (legacy): Anthropic Claude — deprecated for new deploys.
 */

import {
  resolveFindingLlmMode,
  type FindingLlmMode,
} from "@workspace/finding-engine";
import type { GrokClient } from "@workspace/integrations-xai-grok";
import { logger } from "./logger";

type AnthropicClient = Awaited<
  ReturnType<
    typeof import("@workspace/integrations-anthropic-ai")["createAnthropicClient"]
  >
>;

export type FindingLlmClientBundle =
  | { kind: "grok"; client: GrokClient }
  | { kind: "anthropic"; client: AnthropicClient }
  | null;

let cachedGrok: GrokClient | null = null;
let cachedAnthropic: AnthropicClient | null = null;
let cachedFromEnv = true;
let cachedMode: FindingLlmMode = "mock";
let cacheInitialized = false;

export async function getFindingLlmClient(): Promise<FindingLlmClientBundle> {
  if (cacheInitialized) {
    if (cachedMode === "grok" && cachedGrok) {
      return { kind: "grok", client: cachedGrok };
    }
    if (cachedMode === "anthropic" && cachedAnthropic) {
      return { kind: "anthropic", client: cachedAnthropic };
    }
    return null;
  }
  const mode = resolveFindingLlmMode();
  cachedMode = mode;
  cachedFromEnv = true;

  if (mode === "grok") {
    const { createGrokClient } = await import("@workspace/integrations-xai-grok");
    cachedGrok = createGrokClient();
    cachedAnthropic = null;
    cacheInitialized = true;
    logger.info(
      { mode: "grok", model: process.env.XAI_MODEL ?? process.env.XAI_FINDING_MODEL },
      "finding LLM client wired to xAI Grok",
    );
    return { kind: "grok", client: cachedGrok };
  }

  if (mode === "anthropic") {
    logger.warn(
      { mode: "anthropic" },
      "AIR_FINDING_LLM_MODE=anthropic is legacy — prefer grok for plan review",
    );
    const integrations = await import("@workspace/integrations-anthropic-ai");
    cachedAnthropic = integrations.createAnthropicClient();
    cachedGrok = null;
    cacheInitialized = true;
    logger.info(
      { mode: "anthropic" },
      "finding LLM client wired to Anthropic Claude Sonnet 4.5",
    );
    return { kind: "anthropic", client: cachedAnthropic };
  }

  cachedGrok = null;
  cachedAnthropic = null;
  cacheInitialized = true;
  logger.info(
    { mode: "mock" },
    "finding LLM client wired in mock mode (no network calls)",
  );
  return null;
}

export function setFindingLlmClient(
  bundle: FindingLlmClientBundle | AnthropicClient | null,
): void {
  if (bundle === null) {
    cachedGrok = null;
    cachedAnthropic = null;
    cacheInitialized = false;
    cachedFromEnv = true;
    cachedMode = resolveFindingLlmMode();
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

export function getFindingLlmMode(): FindingLlmMode {
  if (!cacheInitialized) {
    cachedMode = resolveFindingLlmMode();
  }
  return cachedMode;
}

export function __findingLlmClientIsFromEnvForTests(): boolean {
  return cachedFromEnv;
}

export function validateFindingEngineEnvAtBoot(): void {
  const mode = resolveFindingLlmMode();
  if (mode === "grok") {
    if (!process.env.XAI_API_KEY?.trim()) {
      throw new Error(
        "AIR_FINDING_LLM_MODE=grok requires XAI_API_KEY to be set",
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
      `AIR_FINDING_LLM_MODE=anthropic requires ${missing.join(" and ")} to be set`,
    );
  }
}
