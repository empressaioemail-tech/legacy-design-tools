import type { EditionEffectiveDateTable, ResolvedEdition } from "./editionResolve.js";

/**
 * Wave 4 municode snapshot years → LDC effective windows.
 * Corpus atoms are Path-C Municode LDC; edition label is attribution only.
 */
const AUSTIN_LDC_WINDOWS: Array<{
  editionId: string;
  editionYear: number;
  effective_from: string;
  effective_to: string | null;
}> = [
  {
    editionId: "austin_tx-ldc-municode-2015",
    editionYear: 2015,
    effective_from: "2015-01-01",
    effective_to: "2017-12-31",
  },
  {
    editionId: "austin_tx-ldc-municode-2018",
    editionYear: 2018,
    effective_from: "2018-01-01",
    effective_to: "2020-12-31",
  },
  {
    editionId: "austin_tx-ldc-municode-2021",
    editionYear: 2021,
    effective_from: "2021-01-01",
    effective_to: "2024-12-31",
  },
  {
    editionId: "austin_tx-ldc-municode-2024",
    editionYear: 2024,
    effective_from: "2025-01-01",
    effective_to: null,
  },
];

const SA_UDC_WINDOWS: Array<{
  editionId: string;
  editionYear: number;
  effective_from: string;
  effective_to: string | null;
}> = [
  {
    editionId: "san_antonio_tx-udc-municode-2016",
    editionYear: 2016,
    effective_from: "2016-01-01",
    effective_to: "2020-12-31",
  },
  {
    editionId: "san_antonio_tx-udc-municode-2021",
    editionYear: 2021,
    effective_from: "2021-01-01",
    effective_to: null,
  },
];

function resolveFromWindows(
  windows: Array<{
    editionId: string;
    editionYear: number;
    effective_from: string;
    effective_to: string | null;
  }>,
  caseDateIso: string,
  codeFamily: string,
  jurisdictionTenant: string,
): ResolvedEdition | null {
  const caseMs = Date.parse(caseDateIso);
  if (!Number.isFinite(caseMs)) return null;

  for (const row of windows) {
    const fromMs = Date.parse(row.effective_from);
    const toMs = row.effective_to
      ? Date.parse(row.effective_to)
      : Number.POSITIVE_INFINITY;
    if (caseMs >= fromMs && caseMs < toMs) {
      return {
        editionId: row.editionId,
        codeFamily,
        editionYear: row.editionYear,
        effectiveFrom: row.effective_from,
        effectiveTo: row.effective_to,
      };
    }
  }
  return null;
}

/**
 * Resolve LOCAL code edition (LDC/UDC) at case date from Wave 4 municode snapshot years.
 * Falls back to IBC table row relabeled as LDC proxy when no local window matches.
 */
export function resolveLocalEditionInEffect(
  table: EditionEffectiveDateTable,
  caseDateIso: string,
  jurisdictionTenant: string,
): ResolvedEdition | null {
  const windows =
    jurisdictionTenant === "san_antonio_tx" ? SA_UDC_WINDOWS : AUSTIN_LDC_WINDOWS;
  const codeFamily = jurisdictionTenant === "san_antonio_tx" ? "UDC" : "LDC";

  const local = resolveFromWindows(
    windows,
    caseDateIso,
    codeFamily,
    jurisdictionTenant,
  );
  if (local) return local;

  // Pre-2015 Austin cases: anchor to earliest snapshot
  if (jurisdictionTenant === "austin_tx") {
    const caseMs = Date.parse(caseDateIso);
    const earliest = AUSTIN_LDC_WINDOWS[0]!;
    if (Number.isFinite(caseMs) && caseMs < Date.parse(earliest.effective_from)) {
      return {
        editionId: earliest.editionId,
        codeFamily,
        editionYear: earliest.editionYear,
        effectiveFrom: earliest.effective_from,
        effectiveTo: earliest.effective_to,
      };
    }
  }

  // Last resort: any edition row from table (provenance continuity)
  for (const row of table.table) {
    const fromMs = Date.parse(row.effective_from);
    const toMs = row.effective_to
      ? Date.parse(row.effective_to)
      : Number.POSITIVE_INFINITY;
    const caseMs = Date.parse(caseDateIso);
    if (caseMs >= fromMs && caseMs < toMs) {
      return {
        editionId: row.editionId.replace("-ibc-", "-ldc-proxy-"),
        codeFamily,
        editionYear: row.editionYear,
        effectiveFrom: row.effective_from,
        effectiveTo: row.effective_to,
      };
    }
  }
  return null;
}
