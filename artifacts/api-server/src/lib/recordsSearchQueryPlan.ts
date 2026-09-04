/**
 * P-85 item 5 — parse subdivision / block / lot hints from CAD legal text.
 * Mirror: artifacts/records-request-worker/src/recipes/searchQueryPlan.ts
 */

/** Retired pattern. Exported so the issued-job audit and the fixture share one definition. */
export const RETIRED_BLOCK_PATTERN = /\bBLK(?:OCK)?\.?\s+(\d+[A-Z]?)\b/i;

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
  /** Matches BLK, BLOCK, and BLKOCK spellings with a digit block id (P-85 audit CURRENT_BLOCK_PATTERN). */
  const blockMatch = text.match(/\bBL(?:OC)?K\.?\s+(\d+[A-Z]?)\b/i);
  const subMatch = text.match(
    /\b(?:SUBDIVISION|SUBD?\.?|PHASE)\s+([A-Z0-9][A-Z0-9\s.'-]{2,60})/i,
  );
  return {
    lot: lotMatch?.[1]?.trim() ?? null,
    block: blockMatch?.[1]?.trim() ?? null,
    subdivision: subMatch?.[1]?.trim() ?? null,
  };
}

/** True when the new parser extracts a block the retired pattern never saw. */
export function blockTermMissedByRetiredPattern(legal: string | null): boolean {
  if (!legal?.trim()) return false;
  const parsed = parseSubdivisionLotBlockFromLegal(legal);
  return parsed.block != null && !RETIRED_BLOCK_PATTERN.test(legal);
}
