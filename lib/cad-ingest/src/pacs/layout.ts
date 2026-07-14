/**
 * PACS "Appraisal Export Layout 8.0.x" fixed-width field offsets.
 *
 * Source of truth: the layout workbooks the CADs publish next to their
 * export drops —
 *  - Caldwell: "Appraisal Export Layout - 8.0.26.xlsx"
 *    (caldwellcad.org/publicly-available-data/)
 *  - Bastrop:  "Appraisal-Export-Layout-8.0.30.pdf"
 *    (bastropcad.org/exports-valuation-reports/)
 *  - Travis:   "Legacy8.0.33-AppraisalExportLayout.xlsx"
 *    (traviscad.org/publicinformation/)
 *
 * All offsets below were cross-checked between the 8.0.26 and 8.0.33
 * workbooks (start/end identical for every field we read; later layout
 * versions only APPEND fields, growing the record: 9067 chars in
 * 8.0.26, 9922 in 8.0.33; Caldwell's live 8.0.0.33-exported data is
 * 9659) and verified against real 2026 Caldwell data.
 *
 * Offsets are 1-based inclusive [start, end] exactly as the layout
 * docs print them; `slice(start - 1, end)` extracts the field.
 */

export interface FieldSpan {
  start: number;
  end: number;
}

/** APPRAISAL_INFO.TXT — one row per property (+owner for UDI splits). */
export const APPRAISAL_INFO = {
  propId: { start: 1, end: 12 },
  propTypeCd: { start: 13, end: 17 },
  propValYr: { start: 18, end: 22 },
  supNum: { start: 23, end: 34 },
  geoId: { start: 547, end: 596 },
  pyOwnerName: { start: 609, end: 678 },
  pyAddrLine1: { start: 694, end: 753 },
  pyAddrLine2: { start: 754, end: 813 },
  pyAddrLine3: { start: 814, end: 873 },
  pyAddrCity: { start: 874, end: 923 },
  pyAddrState: { start: 924, end: 973 },
  pyAddrZip: { start: 979, end: 983 },
  pyAddrZipCass: { start: 984, end: 987 },
  situsStreetPrefix: { start: 1040, end: 1049 },
  situsStreet: { start: 1050, end: 1099 },
  situsStreetSuffix: { start: 1100, end: 1109 },
  situsCity: { start: 1110, end: 1139 },
  situsZip: { start: 1140, end: 1149 },
  legalDesc: { start: 1150, end: 1404 },
  legalDesc2: { start: 1405, end: 1659 },
  landHstdVal: { start: 1796, end: 1810 },
  landNonHstdVal: { start: 1811, end: 1825 },
  imprvHstdVal: { start: 1826, end: 1840 },
  imprvNonHstdVal: { start: 1841, end: 1855 },
  agMarket: { start: 1871, end: 1885 },
  timberMarket: { start: 1901, end: 1915 },
  appraisedVal: { start: 1916, end: 1930 },
  assessedVal: { start: 1946, end: 1960 },
  imprvStateCd: { start: 2732, end: 2741 },
  landStateCd: { start: 2742, end: 2751 },
  landAcres: { start: 2772, end: 2791 },
  marketValue: { start: 4214, end: 4227 },
  situsNum: { start: 4460, end: 4474 },
  situsUnit: { start: 4475, end: 4479 },
} satisfies Record<string, FieldSpan>;

/**
 * Single-char 'T'/'F' exemption flags -> normalized short code.
 * Positions from the layout's exemption block (2609..2731) plus the
 * two later-appended flags (ECO 5342, CHODO 5408).
 */
export const EXEMPTION_FLAGS: ReadonlyArray<{ code: string; pos: number }> = [
  { code: "HS", pos: 2609 },
  { code: "OV65", pos: 2610 },
  { code: "OV65S", pos: 2661 },
  { code: "DP", pos: 2662 },
  { code: "DV1", pos: 2663 },
  { code: "DV1S", pos: 2664 },
  { code: "DV2", pos: 2665 },
  { code: "DV2S", pos: 2666 },
  { code: "DV3", pos: 2667 },
  { code: "DV3S", pos: 2668 },
  { code: "DV4", pos: 2669 },
  { code: "DV4S", pos: 2670 },
  { code: "EX", pos: 2671 },
  { code: "LVE", pos: 2722 },
  { code: "AB", pos: 2723 },
  { code: "EN", pos: 2724 },
  { code: "FR", pos: 2725 },
  { code: "HT", pos: 2726 },
  { code: "PRO", pos: 2727 },
  { code: "PC", pos: 2728 },
  { code: "SO", pos: 2729 },
  { code: "EX366", pos: 2730 },
  { code: "CH", pos: 2731 },
  { code: "ECO", pos: 5342 },
  { code: "CHODO", pos: 5408 },
];

/**
 * Minimum APPRAISAL_INFO record length we accept. The deepest field we
 * read is the CHODO flag at 5408; 8.0.26 (the oldest layout in play)
 * already has record length 9067, so any well-formed 8.0.26+ row
 * clears this. Shorter lines are counted as malformed and skipped.
 */
export const APPRAISAL_INFO_MIN_LEN = 5408;

/** APPRAISAL_IMPROVEMENT_DETAIL.TXT — one row per improvement segment. */
export const IMPROVEMENT_DETAIL = {
  propId: { start: 1, end: 12 },
  propValYr: { start: 13, end: 16 },
  typeCd: { start: 41, end: 50 },
  typeDesc: { start: 51, end: 75 },
  yrBuilt: { start: 86, end: 89 },
  area: { start: 94, end: 108 },
} satisfies Record<string, FieldSpan>;

export const IMPROVEMENT_DETAIL_MIN_LEN = 122;

export function cut(line: string, span: FieldSpan): string {
  return line.slice(span.start - 1, span.end).trim();
}
