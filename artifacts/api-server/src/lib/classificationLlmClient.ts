/**
 * Submission-classification LLM client (Track 1). Mirrors the
 * findingLlmClient / sheetContentLlmClient pattern verbatim: a
 * `getClassificationLlmClient()` lazily resolves a process-wide
 * singleton off `CLASSIFICATION_LLM_MODE` and tests can override via
 * `setClassificationLlmClient()`.
 *
 *   - `mock` (default): no client at all — `classifySubmission` runs
 *     the deterministic mock classifier (default project-type +
 *     defensive empty disciplines/codes) and never opens a network
 *     socket. This is what dev / CI / pre-Empressa-approval use.
 *   - `anthropic`: returns the workspace's lazily-constructed
 *     Anthropic SDK client (Claude Sonnet 4.5). Requires the AI
 *     Integrations Anthropic env vars
 *     `AI_INTEGRATIONS_ANTHROPIC_API_KEY` + `..._BASE_URL`.
 *
 * The mock branch is represented as `null` (rather than a stub object)
 * so the classifier's "no client → mock pass" branch fires on a single
 * null check.
 */

import { logger } from "./logger";

export type ClassificationLlmMode = "mock" | "anthropic";

type AnthropicClient = Awaited<
  ReturnType<
    typeof import("@workspace/integrations-anthropic-ai")["createAnthropicClient"]
  >
>;

let cached: AnthropicClient | null = null;
let cachedFromEnv = true;
let cachedMode: ClassificationLlmMode = "mock";
let cacheInitialized = false;

export function resolveClassificationLlmMode(): ClassificationLlmMode {
  const raw = (process.env["CLASSIFICATION_LLM_MODE"] ?? "mock").toLowerCase();
  return raw === "anthropic" ? "anthropic" : "mock";
}

export async function getClassificationLlmClient(): Promise<AnthropicClient | null> {
  if (cacheInitialized) return cached;
  const mode = resolveClassificationLlmMode();
  cachedMode = mode;
  cachedFromEnv = true;
  if (mode === "anthropic") {
    const integrations = await import("@workspace/integrations-anthropic-ai");
    cached = integrations.createAnthropicClient();
    cacheInitialized = true;
    logger.info(
      { mode: "anthropic" },
      "classification LLM client wired to Anthropic Claude Sonnet 4.5",
    );
  } else {
    cached = null;
    cacheInitialized = true;
    logger.info(
      { mode: "mock" },
      "classification LLM client wired in mock mode (no network calls)",
    );
  }
  return cached;
}

export function setClassificationLlmClient(
  client: AnthropicClient | null,
): void {
  if (client === null) {
    cached = null;
    cacheInitialized = false;
    cachedFromEnv = true;
    cachedMode = resolveClassificationLlmMode();
    return;
  }
  cached = client;
  cacheInitialized = true;
  cachedFromEnv = false;
  cachedMode = "anthropic";
}

export function getClassificationLlmMode(): ClassificationLlmMode {
  if (!cacheInitialized) {
    cachedMode = resolveClassificationLlmMode();
  }
  return cachedMode;
}

/** Test-only: reports whether the cached client came from the env factory. */
export function __classificationLlmClientIsFromEnvForTests(): boolean {
  return cachedFromEnv;
}

export function validateClassificationEnvAtBoot(): void {
  const mode = resolveClassificationLlmMode();
  if (mode !== "anthropic") return;
  const apiKey = process.env["AI_INTEGRATIONS_ANTHROPIC_API_KEY"];
  const baseUrl = process.env["AI_INTEGRATIONS_ANTHROPIC_BASE_URL"];
  if (!apiKey || !baseUrl) {
    const missing: string[] = [];
    if (!apiKey) missing.push("AI_INTEGRATIONS_ANTHROPIC_API_KEY");
    if (!baseUrl) missing.push("AI_INTEGRATIONS_ANTHROPIC_BASE_URL");
    throw new Error(
      `CLASSIFICATION_LLM_MODE=anthropic requires ${missing.join(" and ")} to be set`,
    );
  }
}
