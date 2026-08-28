/**
 * P-85 item 5/6 — index search hit shape and header-bound table extraction.
 */

import type { RecordsRecipeBrowser, ResultRowExtract } from "./types.js";

export interface IndexSearchHit {
  recordingRef: string | null;
  documentType: string | null;
  recordingDate: string | null;
  parties: string | null;
  detailUrl: string | null;
}

/** Max instruments acquired per run (fail closed on overflow). */
export const MAX_INSTRUMENTS_PER_RUN = 25;

export const UNRESOLVED_RESULT_ROW_HEADER = "unresolved_result_row_header";

/** Compact dump of rows that triggered a header refuse. Lives on the job error. */
export function nullHeaderRowDump(rows: ResultRowExtract[]): string {
  const nulls = rows.filter((row) => !row.headers || row.headers.length === 0);
  const dump = nulls.slice(0, 6).map((row) => ({
    n: (row.cells ?? []).length,
    c: (row.cells ?? []).slice(0, 4).map((cell) =>
      String(cell).replace(/\s+/g, " ").slice(0, 48),
    ),
  }));
  return `nullHeaderRows=${nulls.length}/${rows.length} dump=${JSON.stringify(dump)}`;
}

export type VendorFamily = "aumentum" | "tyler" | "publicsearch" | "shared";

export type ExtractIndexHitsResult =
  | { ok: true; hits: IndexSearchHit[] }
  | {
      ok: false;
      errorCode: typeof UNRESOLVED_RESULT_ROW_HEADER;
      errorMessage: string;
    };

export class IndexHitHeaderRefuseError extends Error {
  readonly code = UNRESOLVED_RESULT_ROW_HEADER;

  constructor(message: string) {
    super(message);
    this.name = "IndexHitHeaderRefuseError";
  }
}

type BindField =
  | "recordingRef"
  | "documentType"
  | "recordingDate"
  | "parties"
  | "grantor"
  | "grantee";

const SHARED_ALIASES: Record<BindField, readonly string[]> = {
  recordingRef: [
    "INSTRUMENT NUMBER",
    "INSTRUMENT #",
    "INSTRUMENT NO",
    "INST #",
    "INST NO",
    "DOCUMENT NUMBER",
    "DOCUMENT #",
    "DOC NUMBER",
    "DOC #",
    "DOC NO",
    "DOC NUM",
    "FILE NUMBER",
    "FILE #",
    "RECORDING NUMBER",
    "REC #",
    "REC NO",
    "INSTRUMENT",
  ],
  documentType: [
    "DOCUMENT TYPE",
    "DOC TYPE",
    "INSTRUMENT TYPE",
    "INST TYPE",
    "TYPE",
    "KIND",
  ],
  recordingDate: [
    "RECORDING DATE",
    "RECORD DATE",
    "RECORDED DATE",
    "DATE RECORDED",
    "DATE FILED",
    "FILED DATE",
    "RECORDED",
    "REC DATE",
    "DATE",
  ],
  parties: ["PARTIES", "GRANTOR/GRANTEE", "GRANTOR / GRANTEE", "NAMES"],
  grantor: ["GRANTOR", "GRANTORS", "FROM", "SELLER"],
  grantee: ["GRANTEE", "GRANTEES", "TO", "BUYER"],
};

const VENDOR_ALIASES: Record<VendorFamily, Record<BindField, readonly string[]>> =
  {
    shared: SHARED_ALIASES,
    aumentum: {
      ...SHARED_ALIASES,
      recordingRef: [...SHARED_ALIASES.recordingRef, "INSTR #", "INSTNUM"],
    },
    tyler: {
      ...SHARED_ALIASES,
      recordingRef: [...SHARED_ALIASES.recordingRef, "INSTRUMENT#"],
    },
    publicsearch: {
      ...SHARED_ALIASES,
      recordingRef: [...SHARED_ALIASES.recordingRef, "DOCUMENT NUMBER"],
    },
  };

export function vendorFamilyFromPortalId(portalId: string): VendorFamily {
  if (portalId.includes("aumentum") || portalId.includes("tccsearch")) {
    return "aumentum";
  }
  if (portalId.includes("tyler") || portalId.includes("erss")) {
    return "tyler";
  }
  if (portalId.includes("publicsearch")) {
    return "publicsearch";
  }
  return "shared";
}

export function normalizeHeaderLabel(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[_.:]+/g, " ")
    .replace(/#/g, " #")
    .replace(/\s+/g, " ")
    .trim();
}

function fieldForHeader(
  header: string,
  vendorFamily: VendorFamily,
): BindField | null {
  const label = normalizeHeaderLabel(header);
  if (!label) return null;
  const table = VENDOR_ALIASES[vendorFamily];
  for (const [field, aliases] of Object.entries(table) as Array<
    [BindField, readonly string[]]
  >) {
    if (aliases.some((alias) => normalizeHeaderLabel(alias) === label)) {
      return field;
    }
  }
  return null;
}

function bindParties(bound: Partial<Record<BindField, string>>): string | null {
  if (bound.parties?.trim()) return bound.parties.trim();
  const grantor = bound.grantor?.trim() ?? "";
  const grantee = bound.grantee?.trim() ?? "";
  if (grantor && grantee) return `${grantor} / ${grantee}`;
  if (grantor) return grantor;
  if (grantee) return grantee;
  return null;
}

export function normalizeIndexHit(
  raw: {
    cells?: string[];
    link?: string | null;
    headers?: string[] | null;
  },
  vendorFamily: VendorFamily = "shared",
): IndexSearchHit | null {
  const headers = raw.headers;
  if (!headers || headers.length === 0) {
    throw new IndexHitHeaderRefuseError(
      "Result row has no published column header; refuse rather than guess by position",
    );
  }

  const cells = raw.cells ?? [];
  const bound: Partial<Record<BindField, string>> = {};
  for (let i = 0; i < headers.length; i++) {
    const field = fieldForHeader(headers[i] ?? "", vendorFamily);
    if (!field) continue;
    const value = (cells[i] ?? "").trim();
    if (!value) continue;
    if (!bound[field]) bound[field] = value;
  }

  const recordingRef = bound.recordingRef?.trim() ?? null;
  if (!recordingRef) return null;

  return {
    recordingRef,
    documentType: bound.documentType?.trim() ?? null,
    recordingDate: bound.recordingDate?.trim() ?? null,
    parties: bindParties(bound),
    detailUrl: raw.link ?? null,
  };
}

export async function extractIndexHitsFromPage(
  browser: RecordsRecipeBrowser,
  options?: { vendorFamily?: VendorFamily },
): Promise<ExtractIndexHitsResult> {
  const vendorFamily = options?.vendorFamily ?? "shared";
  const rawRows = await browser.extractResultRows();
  if (rawRows.length === 0) {
    return { ok: true, hits: [] };
  }
  if (rawRows.some((row) => !row.headers || row.headers.length === 0)) {
    return {
      ok: false,
      errorCode: UNRESOLVED_RESULT_ROW_HEADER,
      errorMessage:
        `Result grid header could not be read; refuse rather than guess columns by position; ${nullHeaderRowDump(rawRows)}`,
    };
  }

  const hits: IndexSearchHit[] = [];
  for (const row of rawRows) {
    let hit: IndexSearchHit | null;
    try {
      hit = normalizeIndexHit(row, vendorFamily);
    } catch (err) {
      if (err instanceof IndexHitHeaderRefuseError) {
        return {
          ok: false,
          errorCode: UNRESOLVED_RESULT_ROW_HEADER,
          errorMessage: err.message,
        };
      }
      throw err;
    }
    if (hit) hits.push(hit);
  }
  return { ok: true, hits: hits.slice(0, MAX_INSTRUMENTS_PER_RUN) };
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

export function resultRowHasHeader(row: ResultRowExtract): boolean {
  return Array.isArray(row.headers) && row.headers.length > 0;
}
