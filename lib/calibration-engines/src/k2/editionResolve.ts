export type EditionTableRow = {
  editionId: string;
  codeFamily: string;
  editionYear: number;
  effective_from: string;
  effective_to: string | null;
  adopting_ordinance_citation?: string;
  source_url?: string;
  notes?: string;
};

export type EditionEffectiveDateTable = {
  schemaVersion: string;
  jurisdictionTenant: string;
  table: EditionTableRow[];
};

export type ResolvedEdition = {
  editionId: string;
  codeFamily: string;
  editionYear: number;
  effectiveFrom: string;
  effectiveTo: string | null;
};

/**
 * Join caseDate to Wave 4 edition-effective-date table.
 */
export function resolveEditionInEffect(
  table: EditionEffectiveDateTable,
  caseDateIso: string,
  codeFamily?: string,
): ResolvedEdition | null {
  const caseMs = Date.parse(caseDateIso);
  if (!Number.isFinite(caseMs)) return null;

  const familyFilter = (codeFamily ?? "").trim().toUpperCase();

  for (const row of table.table) {
    if (familyFilter && row.codeFamily.toUpperCase() !== familyFilter) continue;
    const fromMs = Date.parse(row.effective_from);
    const toMs = row.effective_to ? Date.parse(row.effective_to) : Number.POSITIVE_INFINITY;
    if (caseMs >= fromMs && caseMs < toMs) {
      return {
        editionId: row.editionId,
        codeFamily: row.codeFamily,
        editionYear: row.editionYear,
        effectiveFrom: row.effective_from,
        effectiveTo: row.effective_to,
      };
    }
  }
  return null;
}
