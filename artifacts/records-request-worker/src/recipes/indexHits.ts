/**
 * P-85 item 5/6 — index search hit shape and generic table extraction.
 */

import type { RecordsRecipeBrowser } from "./types.js";

export interface IndexSearchHit {
  recordingRef: string | null;
  documentType: string | null;
  recordingDate: string | null;
  parties: string | null;
  detailUrl: string | null;
}

/** Max instruments acquired per run (fail closed on overflow). */
export const MAX_INSTRUMENTS_PER_RUN = 25;

export function normalizeIndexHit(raw: {
  cells?: string[];
  link?: string | null;
}): IndexSearchHit | null {
  const cells = raw.cells?.filter((c) => c.trim()) ?? [];
  if (cells.length === 0) return null;

  return {
    recordingRef: cells[0] ?? null,
    documentType: cells.length > 1 ? cells[1]! : null,
    recordingDate: cells.length > 2 ? cells[2]! : null,
    parties: cells.length > 3 ? cells.slice(3).join(" | ") : null,
    detailUrl: raw.link ?? null,
  };
}

export async function extractIndexHitsFromPage(
  browser: RecordsRecipeBrowser,
): Promise<IndexSearchHit[]> {
  const rawRows = await browser.extractResultRows();
  const hits: IndexSearchHit[] = [];
  for (const row of rawRows) {
    const hit = normalizeIndexHit(row);
    if (hit) hits.push(hit);
  }
  return hits.slice(0, MAX_INSTRUMENTS_PER_RUN);
}

export function dedupeIndexHits(hits: IndexSearchHit[]): IndexSearchHit[] {
  const seen = new Set<string>();
  const out: IndexSearchHit[] = [];
  for (const hit of hits) {
    const key =
      hit.recordingRef?.trim() ||
      [hit.documentType, hit.recordingDate, hit.parties].filter(Boolean).join("|");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
    if (out.length >= MAX_INSTRUMENTS_PER_RUN) break;
  }
  return out;
}
