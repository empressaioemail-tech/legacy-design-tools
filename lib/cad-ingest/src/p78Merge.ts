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

/** Round to the `land_acres` column's 4 implied decimals, as a string. */
export function formatAcres(n: number): string {
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

/**
 * McLennan leftover-farm fallback (F-01, OPS-19b Wave 1 item 4 follow-up,
 * `_inbox/2026-09-05_engine-williamson-mclennan-geomgap-nulls_close.json`).
 *
 * McLennan's StratMap drop carries no usable GIS_AREA_U for any of its
 * 114,255 rows, so `landAcresFromGis` refuses every one of them even
 * though `land_value`/`market_value` land fine from the same rows (99%
 * populated) -- the acreage is not missing from the source, it is
 * embedded as free text on `LEGAL_DESC` and was never extracted. Two
 * real phrasings measured live against the county's own rows:
 *   - "Acres 0.414" (the dominant form, ~96.6% of rows)
 *   - "... 0.116 Ac Aband ROW (A) Total 0.414 Ac" (the remainder) --
 *     note the decoy: a bare "<number> Ac" match here would wrongly
 *     grab the 0.116 sub-tract figure instead of the parcel's real
 *     0.414 total, so "Total ... Ac" is matched FIRST and specifically,
 *     never a generic "<number> Ac" anywhere in the string.
 * Returns null (never an invented figure) when neither phrasing is
 * found -- this is a strict fallback that can only turn an existing
 * null into a real value or leave it null; it never overwrites a value
 * `landAcresFromGis` already resolved (see call site in txgio/landuse.ts).
 */
export function landAcresFromLegalDescription(
  legalDescription: unknown,
): string | null {
  if (typeof legalDescription !== "string") return null;
  const text = legalDescription.trim();
  if (!text) return null;

  const totalMatch = text.match(/\bTotal\s+(\d+(?:\.\d+)?)\s*Ac\b/i);
  const acresMatch = totalMatch ? null : text.match(/\bAcres\s+(\d+(?:\.\d+)?)\b/i);
  const raw = totalMatch?.[1] ?? acresMatch?.[1];
  if (raw == null) return null;

  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return formatAcres(n);
}

function isCamaVintage(vintage: string | null | undefined): boolean {
  return typeof vintage === "string" && vintage.startsWith("tier:cad-export;");
}

function coalesce<T>(incoming: T | null | undefined, existing: T | null | undefined): T | null | undefined {
  return incoming == null ? existing : incoming;
}

/**
 * THE P-78 MERGE ROOT (Phase 0 audit section 3/4, P3: "the root cause is
 * p78Merge.ts letting geometry-source fields overwrite appraisal-source
 * fields. That fix was built but never executed.").
 *
 * Authority-aware merge for every APPRAISAL-SOURCED field -- generalizes the
 * CAMA-wins rule that `yearBuilt`/`livingAreaSqft` already used (see git
 * history) to EVERY other field in COALESCE_FIELDS except `quickRefId` /
 * `propertyNumber`, which stay under the bare `coalesce()` below because the
 * StratMap/TxGIO geometry loader hardcodes them null (see that list's own
 * comment) and so can never win them away from a real CAD export regardless
 * of which merge function is used.
 *
 * Every OTHER field in COALESCE_FIELDS -- ownerName, situsAddress,
 * situsCity, situsZip, legalDescription, landValue, improvementValue,
 * marketValue, assessedValue, landAcres, propertyUseCode, exemptionCodes,
 * ownerMailingAddress -- is NOT hardcoded null by the geometry loader
 * (`normalizeStratMapLandUse` emits real, non-null values for all of them;
 * see txgio/landuse.ts). Before this fix, `applyPathAMerge` ran these
 * through the SAME bare `coalesce(incoming, existing)` as the two
 * identifiers: incoming wins whenever non-null, with NO regard for which
 * source produced it. A StratMap/TxGIO geometry re-ingest landing AFTER a
 * real CAD appraisal export therefore silently overwrote the appraisal
 * data with its own, lower-authority values -- measured live in Hays:
 * joinNormalize.ts documents all 116,421 Hays `cad_property` tax_year 2025
 * rows carrying TxGIO's situs byte-identically after the 2026-08-25 P-78
 * StratMap merge upserted TxGIO-keyed rows with `situsAddress` under bare
 * coalesce.
 *
 * Rule (identical shape to the pre-existing yearBuilt/livingAreaSqft case):
 * null loses to a present value on either side; when BOTH sides are
 * present, a cad-export-tier value always wins over a non-cad-export-tier
 * value, from EITHER side (so a real CAD export can still correct its own
 * prior value, and a geometry re-apply can never claw back a CAD value);
 * when neither side is cad-export-tier (two geometry loads, or two
 * non-authoritative sources), incoming wins -- the same outcome a bare
 * coalesce already gave, so two StratMap re-ingests in a row behave exactly
 * as before this change.
 */
function mergeAuthority<T>(
  incoming: T | null | undefined,
  existing: T | null | undefined,
  incomingVintage: string | undefined,
  existingVintage: string | undefined,
  normalize?: (v: unknown) => T | null,
): T | null | undefined {
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
  quickRefId?: string | null;
  propertyNumber?: string | null;
  yearBuilt?: number | null;
  livingAreaSqft?: number | null;
  sourceFile?: string;
  sourceVintage?: string;
};

/**
 * APPRAISAL-SOURCED fields: the StratMap/TxGIO geometry loader emits REAL,
 * non-null values for every one of these (`normalizeStratMapLandUse`), so a
 * bare bidirectional coalesce would let a lower-authority geometry re-apply
 * overwrite a real CAD export's value. Merged through `mergeAuthority` --
 * see that function's header for the full fix writeup (THE P-78 MERGE ROOT).
 */
const AUTHORITY_COALESCE_FIELDS = [
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

/**
 * IDENTIFIER fields: stay under a bare, direction-blind coalesce.
 *
 * CTX-HAYS-REBIND (P-124, 2026-09-10). The two OTHER identifiers the CAD
 * publishes for the same account. They belong under coalesce for the same
 * reason `assessedValue` survives a StratMap re-apply used to rely on: the
 * geometry loader emits null for both (it has no appraisal columns at all),
 * so `coalesce(incoming, existing)` returns the EXISTING value and a
 * geometry-only apply cannot blank a crosswalk a real CAD export
 * established. Unlike the fields above, the geometry loader can NEVER win
 * these away from a CAD export regardless of merge function, so there is no
 * authority question to resolve for them -- a bare coalesce is already
 * correct and `mergeAuthority` would compute the identical result. Omitting
 * them from either list would drop them from the merge output entirely,
 * which is the failure mode this comment exists to prevent.
 */
const IDENTIFIER_COALESCE_FIELDS = ["quickRefId", "propertyNumber"] as const;

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
  for (const k of AUTHORITY_COALESCE_FIELDS) {
    (out as Record<string, unknown>)[k] =
      mergeAuthority(
        (inc as Record<string, unknown>)[k],
        (existing as Record<string, unknown>)[k],
        inc.sourceVintage,
        existing.sourceVintage,
      ) ?? null;
  }
  for (const k of IDENTIFIER_COALESCE_FIELDS) {
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
