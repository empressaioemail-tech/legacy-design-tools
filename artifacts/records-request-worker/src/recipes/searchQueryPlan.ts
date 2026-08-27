/**
 * P-85 item 5 — planned clerk index queries from CAD-enriched search terms.
 */

import type { RecordsSearchTerms } from "./searchTerms.js";

export type SearchQueryKind =
  | "owner-name"
  | "legal-description"
  | "subdivision-lot-block";

export interface PlannedSearchQuery {
  kind: SearchQueryKind;
  query: string;
  /** Short label for capture artifacts. */
  captureLabel: string;
}

/** Parse subdivision / block / lot from a Texas-style legal when CAD has no columns. */
export function parseSubdivisionLotBlockFromLegal(
  legal: string | null,
): Pick<RecordsSearchTerms, "subdivision" | "block" | "lot"> {
  if (!legal?.trim()) {
    return { subdivision: null, block: null, lot: null };
  }
  const text = legal.trim();
  const lotMatch = text.match(/\bLOT\s+(\d+[A-Z]?)\b/i);
  const blockMatch = text.match(/\bBLK(?:OCK)?\.?\s+(\d+[A-Z]?)\b/i);
  const subMatch = text.match(
    /\b(?:SUBDIVISION|SUBD?\.?|PHASE)\s+([A-Z0-9][A-Z0-9\s.'-]{2,60})/i,
  );
  return {
    lot: lotMatch?.[1]?.trim() ?? null,
    block: blockMatch?.[1]?.trim() ?? null,
    subdivision: subMatch?.[1]?.trim() ?? null,
  };
}

export function buildSearchQueryPlan(
  terms: RecordsSearchTerms,
): PlannedSearchQuery[] {
  const plan: PlannedSearchQuery[] = [];
  const parsed = parseSubdivisionLotBlockFromLegal(terms.legalDescription);
  const subdivision = terms.subdivision ?? parsed.subdivision;
  const block = terms.block ?? parsed.block;
  const lot = terms.lot ?? parsed.lot;

  if (terms.ownerName?.trim()) {
    plan.push({
      kind: "owner-name",
      query: terms.ownerName.trim(),
      captureLabel: "owner-name-results",
    });
  }

  if (subdivision || (block && lot)) {
    const parts = [
      lot ? `LOT ${lot}` : null,
      block ? `BLK ${block}` : null,
      subdivision ? subdivision : null,
    ].filter(Boolean);
    plan.push({
      kind: "subdivision-lot-block",
      query: parts.join(" "),
      captureLabel: "subdivision-lot-block-results",
    });
  }

  if (terms.legalDescription?.trim()) {
    plan.push({
      kind: "legal-description",
      query: terms.legalDescription.trim(),
      captureLabel: "legal-description-results",
    });
  }

  return plan;
}
