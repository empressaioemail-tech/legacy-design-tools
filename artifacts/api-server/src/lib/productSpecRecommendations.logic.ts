/**
 * Pure validation for AI-generated product-spec recommendation payloads.
 */

import { ESR_NUMBER_RE } from "@workspace/atoms-l-surface";

export interface ProductSpecRecommendation {
  product: { name: string; manufacturer: string };
  esrNumber: string;
  reasoning: string;
  /** Optional sheet or note the model tied the suggestion to. */
  sheetHint: string | null;
}

const MAX_RECOMMENDATIONS = 12;

function optionalString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parse a JSON array the LLM returned. Drops invalid rows instead of
 * failing the whole batch so a single hallucinated ESR does not 500.
 */
export function parseProductSpecRecommendationsJson(
  raw: unknown,
): ProductSpecRecommendation[] {
  if (!Array.isArray(raw)) return [];
  const out: ProductSpecRecommendation[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const product = isRecord(item.product) ? item.product : null;
    const name = product ? optionalString(product.name) : null;
    const manufacturer = product ? optionalString(product.manufacturer) : null;
    const esrNumber = optionalString(item.esrNumber);
    const reasoning = optionalString(item.reasoning);
    if (!name || !manufacturer || !esrNumber || !reasoning) continue;
    if (!ESR_NUMBER_RE.test(esrNumber)) continue;
    out.push({
      product: { name, manufacturer },
      esrNumber,
      reasoning,
      sheetHint: optionalString(item.sheetHint),
    });
    if (out.length >= MAX_RECOMMENDATIONS) break;
  }
  return out;
}
