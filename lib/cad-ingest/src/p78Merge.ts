/**
 * P-78 cad_property Path A merge helpers (parsers + JS reference merge for tests).
 * SQL in upsertCadProperties must match applyPathAMerge semantics.
 */

export const YEAR_BUILT_MIN = 1800;
export const YEAR_BUILT_MAX = 2027;

export const REFUSE_GIS_AREA_REASON = "gis_area_u_not_acres_or_convertible";

const ACRES_UNITS = new Set(["AC", "ACRE", "ACRES"]);
const SQFT_UNITS = new Set(["SF", "SQFT", "SQ.FT", "SQ FT", "SQUARE FEET"]);
const HA_UNITS = new Set(["HA", "HECTARE", "HECTARES"]);

export function parseYearBuilt(v: unknown): number | null {
  if (v === 0 || v === "0" || v === "" || v == null) return null;
  if (typeof v === "number") {
    if (!Number.isInteger(v) || v < YEAR_BUILT_MIN || v > YEAR_BUILT_MAX) return null;
    return v;
  }
  const raw = String(v).trim();
  if (!raw) return null;
  for (const token of raw.split(",")) {
    const t = token.trim();
    if (!/^\d{4}$/.test(t)) continue;
    const n = Number(t);
    if (n >= YEAR_BUILT_MIN && n <= YEAR_BUILT_MAX) return n;
  }
  return null;
}

function formatAcres(n: number): string {
  const rounded = Math.round(n * 10000 + Number.EPSILON) / 10000;
  return rounded.toFixed(4);
}

export type LandAcresGate =
  | { landAcres: string | null }
  | { refuse: true; reason: string };

export function landAcresFromGis(
  gisArea: unknown,
  gisAreaU: unknown,
): LandAcresGate {
  const unitRaw = gisAreaU == null ? "" : String(gisAreaU).trim();
  if (unitRaw.length === 0) {
    return { refuse: true, reason: REFUSE_GIS_AREA_REASON };
  }
  const unit = unitRaw.toUpperCase();
  const n = typeof gisArea === "number" ? gisArea : Number(gisArea);
  if (!Number.isFinite(n) || n <= 0) {
    return { landAcres: null };
  }
  if (ACRES_UNITS.has(unit)) return { landAcres: formatAcres(n) };
  if (SQFT_UNITS.has(unit)) return { landAcres: formatAcres(n / 43560) };
  if (HA_UNITS.has(unit)) {
    return { landAcres: formatAcres(n * 2.471053814671653) };
  }
  return { refuse: true, reason: REFUSE_GIS_AREA_REASON };
}

function isCamaVintage(vintage: string | null | undefined): boolean {
  return typeof vintage === "string" && vintage.startsWith("tier:cad-export;");
}

function coalesce<T>(incoming: T | null | undefined, existing: T | null | undefined): T | null | undefined {
  return incoming == null ? existing : incoming;
}

function mergeAuthority(
  incoming: number | null | undefined,
  existing: number | null | undefined,
  incomingVintage: string | undefined,
  existingVintage: string | undefined,
  normalize?: (v: unknown) => number | null,
): number | null | undefined {
  const inc = normalize ? normalize(incoming) : incoming;
  const ex = normalize ? normalize(existing) : existing;
  if (inc == null) return ex ?? null;
  if (ex == null) return inc;
  if (isCamaVintage(incomingVintage)) return inc;
  if (isCamaVintage(existingVintage)) return ex;
  return inc;
}

export type CadPropertyMergeRow = {
  countyFips: string;
  propId: string;
  taxYear: number;
  ownerName?: string | null;
  ownerMailingAddress?: string | null;
  situsAddress?: string | null;
  situsCity?: string | null;
  situsZip?: string | null;
  legalDescription?: string | null;
  exemptionCodes?: string[] | null;
  landValue?: number | null;
  improvementValue?: number | null;
  marketValue?: number | null;
  assessedValue?: number | null;
  landAcres?: string | null;
  propertyUseCode?: string | null;
  yearBuilt?: number | null;
  livingAreaSqft?: number | null;
  sourceFile?: string;
  sourceVintage?: string;
};

const COALESCE_FIELDS = [
  "ownerName",
  "ownerMailingAddress",
  "situsAddress",
  "situsCity",
  "situsZip",
  "legalDescription",
  "exemptionCodes",
  "landValue",
  "improvementValue",
  "marketValue",
  "assessedValue",
  "landAcres",
  "propertyUseCode",
] as const;

/** JS reference for Path A ON CONFLICT merge (matches spec SET clause). */
export function applyPathAMerge(
  existing: CadPropertyMergeRow,
  incoming: CadPropertyMergeRow,
): CadPropertyMergeRow {
  const inc = { ...incoming };
  inc.yearBuilt = parseYearBuilt(inc.yearBuilt);

  const out: CadPropertyMergeRow = {
    countyFips: inc.countyFips,
    propId: inc.propId,
    taxYear: inc.taxYear,
  };
  for (const k of COALESCE_FIELDS) {
    (out as Record<string, unknown>)[k] = coalesce(
      (inc as Record<string, unknown>)[k],
      (existing as Record<string, unknown>)[k],
    );
  }
  out.yearBuilt = mergeAuthority(
    inc.yearBuilt,
    existing.yearBuilt,
    inc.sourceVintage,
    existing.sourceVintage,
    parseYearBuilt,
  ) ?? null;
  out.livingAreaSqft = mergeAuthority(
    inc.livingAreaSqft,
    existing.livingAreaSqft,
    inc.sourceVintage,
    existing.sourceVintage,
  ) ?? null;
  out.sourceFile = inc.sourceFile;
  out.sourceVintage = inc.sourceVintage;
  return out;
}
