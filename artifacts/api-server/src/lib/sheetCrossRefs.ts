/**
 * Sheet cross-reference extractor (PLR-8). Parses sheet-content text
 * for inter-sheet references like "SEE A-301" or "5/A-501" and emits
 * a structured `crossRefs` array. Pure / stateless.
 */

export interface SheetCrossRef {
  /** The original substring as it appeared in the source text. */
  raw: string;
  /** Normalized sheet number (uppercased, whitespace stripped). */
  sheetNumber: string;
  /** Detail number when the reference is the `<detail>/<sheet>` form. */
  detailNumber?: string;
}

/** `<detail>/<sheet>` form — captures detail and sheet numbers separately. */
const DETAIL_ON_SHEET_RE =
  /\b(\d{1,3})\/([A-Z][A-Z0-9]*-?\d{1,4}(?:\.\d{1,3})?)\b/g;

/** Keyword + sheet form — captures the sheet number only. */
const KEYWORD_SHEET_RE =
  /\b(?:SEE|REF\.?|REFER\s+TO|DETAIL|DET\.?|DWG\.?)\s+(?:SHEET\s+)?([A-Z][A-Z0-9]*-?\d{1,4}(?:\.\d{1,3})?)\b/gi;

interface MatchSpan {
  start: number;
  end: number;
  ref: SheetCrossRef;
}

/**
 * Extract all cross-references from a free-text body. Returns refs in
 * the order they appear in the source text. Overlapping matches are
 * resolved in favour of the longer match; exact duplicates (same
 * substring at the same offset) are de-duplicated.
 */
export function extractSheetCrossRefs(text: string): SheetCrossRef[] {
  if (!text) return [];
  const spans: MatchSpan[] = [];

  for (const m of text.matchAll(DETAIL_ON_SHEET_RE)) {
    const raw = m[0];
    const detail = m[1];
    const sheet = m[2];
    if (raw === undefined || detail === undefined || sheet === undefined)
      continue;
    const start = m.index ?? 0;
    spans.push({
      start,
      end: start + raw.length,
      ref: {
        raw,
        sheetNumber: sheet.toUpperCase(),
        detailNumber: detail,
      },
    });
  }

  for (const m of text.matchAll(KEYWORD_SHEET_RE)) {
    const raw = m[0];
    const sheet = m[1];
    if (raw === undefined || sheet === undefined) continue;
    const start = m.index ?? 0;
    spans.push({
      start,
      end: start + raw.length,
      ref: { raw, sheetNumber: sheet.toUpperCase() },
    });
  }

  // Sort by start offset; on tie prefer the longer span. Then drop any
  // span that is fully contained inside an already-kept span so a
  // "SEE 5/A-501" line doesn't yield both "5/A-501" and the keyword
  // form that overlaps it.
  spans.sort((a, b) => a.start - b.start || b.end - a.end - (a.end - b.end));
  const kept: MatchSpan[] = [];
  for (const s of spans) {
    const overlapsExisting = kept.some(
      (k) => s.start < k.end && s.end > k.start,
    );
    if (!overlapsExisting) kept.push(s);
  }

  return kept.map((s) => s.ref);
}
