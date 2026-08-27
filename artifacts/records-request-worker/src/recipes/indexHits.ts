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

  const instrumentCell =
    cells.find((c) => /^[\d-]{5,}$/.test(c.trim()) && /\d/.test(c)) ??
    cells.find((c) => /\d{5,}/.test(c)) ??
    null;
  if (!instrumentCell) return null;

  const ref = instrumentCell.trim();
  const dateCell = cells.find((c) =>
    /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(c.trim()) ||
    /^\d{4}-\d{2}-\d{2}$/.test(c.trim()),
  );
  const typeCell = cells.find(
    (c) =>
      c.trim().length > 3 &&
      c.trim() !== ref &&
      c.trim() !== dateCell &&
      !/^\d+$/.test(c.trim()) &&
      !/^view$/i.test(c.trim()),
  );

  return {
    recordingRef: ref,
    documentType: typeCell?.trim() ?? null,
    recordingDate: dateCell?.trim() ?? null,
    parties:
      cells.length > 3
        ? cells
            .filter(
              (c) =>
                c.trim() !== ref &&
                c.trim() !== dateCell &&
                c.trim() !== typeCell &&
                !/^\d+$/.test(c.trim()) &&
                !/^view$/i.test(c.trim()),
            )
            .join(" | ")
        : null,
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

/** Rehydrate index hits stored on scope_searched for acquisition-only resume. */
export function parseIndexHitsFromScope(
  scope: Record<string, unknown> | null | undefined,
): IndexSearchHit[] {
  if (!scope || typeof scope !== "object") return [];
  const raw = scope.indexHits;
  if (!Array.isArray(raw)) return [];
  const hits: IndexSearchHit[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const o = row as Record<string, unknown>;
    hits.push({
      recordingRef:
        typeof o.recordingRef === "string" ? o.recordingRef : null,
      documentType:
        typeof o.documentType === "string" ? o.documentType : null,
      recordingDate:
        typeof o.recordingDate === "string" ? o.recordingDate : null,
      parties: typeof o.parties === "string" ? o.parties : null,
      detailUrl: typeof o.detailUrl === "string" ? o.detailUrl : null,
    });
  }
  return dedupeIndexHits(hits);
}
