/**
 * Product-spec recommendation LLM client (QA-55).
 * Mirrors sheet-content / finding client wiring.
 */

import { logger } from "./logger";

export type ProductSpecRecommendationsLlmMode = "mock" | "anthropic";

type AnthropicClient = Awaited<
  ReturnType<
    typeof import("@workspace/integrations-anthropic-ai")["createAnthropicClient"]
  >
>;

let cached: AnthropicClient | null = null;
let cacheInitialized = false;
let cachedMode: ProductSpecRecommendationsLlmMode = "mock";

export function resolveProductSpecRecommendationsLlmMode(): ProductSpecRecommendationsLlmMode {
  const raw = (
    process.env.PRODUCT_SPEC_RECOMMENDATIONS_LLM_MODE ?? "mock"
  ).toLowerCase();
  return raw === "anthropic" ? "anthropic" : "mock";
}

export async function getProductSpecRecommendationsLlmClient(): Promise<AnthropicClient | null> {
  if (cacheInitialized) return cached;
  const mode = resolveProductSpecRecommendationsLlmMode();
  cachedMode = mode;
  if (mode === "anthropic") {
    const integrations = await import("@workspace/integrations-anthropic-ai");
    cached = integrations.createAnthropicClient();
    cacheInitialized = true;
    logger.info(
      { mode: "anthropic" },
      "product-spec recommendations LLM wired to Anthropic",
    );
  } else {
    cached = null;
    cacheInitialized = true;
    logger.info(
      { mode: "mock" },
      "product-spec recommendations LLM in mock mode",
    );
  }
  return cached;
}

export function getProductSpecRecommendationsLlmMode(): ProductSpecRecommendationsLlmMode {
  if (!cacheInitialized) {
    cachedMode = resolveProductSpecRecommendationsLlmMode();
  }
  return cachedMode;
}

/** Test-only override — pass null to reset to env-derived client. */
export function setProductSpecRecommendationsLlmClient(
  client: AnthropicClient | null,
): void {
  if (client === null) {
    cached = null;
    cacheInitialized = false;
    cachedMode = resolveProductSpecRecommendationsLlmMode();
    return;
  }
  cached = client;
  cacheInitialized = true;
  cachedMode = "anthropic";
}
