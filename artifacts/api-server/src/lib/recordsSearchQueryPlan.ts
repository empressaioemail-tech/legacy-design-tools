/**
 * P-85 item 5 — parse subdivision / block / lot hints from CAD legal text.
 * Mirror: artifacts/records-request-worker/src/recipes/searchQueryPlan.ts
 */

export function parseSubdivisionLotBlockFromLegal(legal: string | null): {
  subdivision: string | null;
  block: string | null;
  lot: string | null;
} {
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
