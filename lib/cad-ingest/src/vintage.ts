/**
 * CAD declared-vintage resolver — THE blessed helper for every
 * `cad_property` reader (L17 / P-25 / L9 vintage-read spec).
 *
 * INVARIANT: every reader filters to the county's single DECLARED
 * vintage unless an explicit, evidence-classed named fallback entry
 * sanctions one prior-vintage row. No silent cross-vintage fallback.
 *
 * L21 additive: when the declared-year key misses, readers MAY resolve
 * at most one deterministic row from `cad_property_vintage_crosswalk`
 * via {@link resolveCrosswalkPropId}. That is key mapping inside this
 * seam, not a second resolver and not a cross-vintage year fallback.
 *
 * Declared values live in `_catalog/tx_cad_source_registry.json`
 * (`current_tax_year` + `current_tier`) and are mirrored here so
 * runtime readers do not parse the whole registry. Flip ONLY at load
 * completion — never mid-load.
 *
 * Greppable CI marker: files that query `cad_property` must import
 * `resolveDeclaredCadVintage` (or carry CAD_PROPERTY_MULTI_YEAR_INVENTORY
 * for intentional multi-year roster/capability probes).
 */

import type { CadSourceTier } from "./tier.js";

export const VINTAGE_GAP_ABSENCE_BASIS = "vintage-gap" as const;

export type CadVintageMissClass =
  | "hit"
  | typeof VINTAGE_GAP_ABSENCE_BASIS
  | "not-found";

export interface DeclaredCadVintage {
  countyFips: string;
  taxYear: number;
  tier: CadSourceTier;
}

/**
 * Store-truth seed 2026-08-13 (cortex-prod cad_property). Counting rule
 * in `_inbox/2026-08-14_l17_cp1.json` + `P:/tmp/l17_cad_vintage_20260814/declared_seed.json`.
 * Tarrant flipped to 2026 after the full C-inclusive load and the named
 * 2025 fallback ruling (L21 follow-up 3). Dallas flipped to 2026 after the
 * named 2025-fallback residual ruling (L21 follow-up 5).
 */
export const DECLARED_CAD_VINTAGES: Readonly<
  Record<string, Readonly<{ taxYear: number; tier: CadSourceTier }>>
> = Object.freeze({
  "48021": { taxYear: 2025, tier: "cad-export" },
  "48027": { taxYear: 2025, tier: "stratmap-roll" },
  "48029": { taxYear: 2025, tier: "stratmap-roll" },
  "48055": { taxYear: 2026, tier: "cad-export" },
  "48085": { taxYear: 2025, tier: "stratmap-roll" },
  "48091": { taxYear: 2025, tier: "stratmap-roll" },
  "48113": { taxYear: 2026, tier: "cad-export" },
  "48121": { taxYear: 2025, tier: "stratmap-roll" },
  "48187": { taxYear: 2025, tier: "stratmap-roll" },
  "48209": { taxYear: 2026, tier: "cad-export" },
  "48257": { taxYear: 2025, tier: "stratmap-roll" },
  "48309": { taxYear: 2025, tier: "stratmap-roll" },
  "48439": { taxYear: 2026, tier: "cad-export" },
  "48453": { taxYear: 2026, tier: "cad-export" },
  "48491": { taxYear: 2026, tier: "cad-export" },
});

function normalizeCountyFips(countyFips: string): string {
  const fips = countyFips.trim();
  if (!/^\d{5}$/.test(fips)) {
    throw new Error(
      `cad vintage FAIL CLOSED: countyFips must be 5 digits, got "${countyFips}"`,
    );
  }
  return fips;
}

/**
 * Soft resolve — null when the county has no declared vintage yet
 * (no cad_property rows / not flipped). Callers MUST treat null as
 * "read nothing" (honest empty), never as "fall back to max(tax_year)".
 */
export function tryResolveDeclaredCadVintage(
  countyFips: string,
): DeclaredCadVintage | null {
  const fips = normalizeCountyFips(countyFips);
  const row = DECLARED_CAD_VINTAGES[fips];
  if (!row) return null;
  return { countyFips: fips, taxYear: row.taxYear, tier: row.tier };
}

/**
 * Resolve the county's declared CAD vintage. Fail-closed: unknown FIPS
 * or missing declaration throws — never invent a year from max(tax_year).
 * Prefer this in writers / apply paths. Serve paths may use
 * {@link tryResolveDeclaredCadVintage} and return empty on null.
 */
export function resolveDeclaredCadVintage(
  countyFips: string,
): DeclaredCadVintage {
  const resolved = tryResolveDeclaredCadVintage(countyFips);
  if (!resolved) {
    throw new Error(
      `cad vintage FAIL CLOSED: no declared current_tax_year/current_tier for county ${countyFips.trim()}`,
    );
  }
  return resolved;
}

/**
 * Classify a prop-level miss against the declared vintage.
 *
 * - hit: row present at declared year
 * - vintage-gap: declared year miss, but the prop exists in another year
 * - not-found: prop absent from every year (true gap)
 */
export function classifyCadPropertyMiss(opts: {
  declaredYearHit: boolean;
  otherVintageHit: boolean;
}): CadVintageMissClass {
  if (opts.declaredYearHit) return "hit";
  if (opts.otherVintageHit) return VINTAGE_GAP_ABSENCE_BASIS;
  return "not-found";
}

/** Normalize GIS_Link-style keys: trim, collapse whitespace, uppercase. */
export function normalizeCadGisLinkKey(propId: string): string {
  return propId.trim().replace(/\s+/g, " ").toUpperCase();
}

/** @deprecated use normalizeCadGisLinkKey — kept as alias for clarity in older notes. */
export function collapseCadPropIdWhitespace(propId: string): string {
  return normalizeCadGisLinkKey(propId);
}

export type CadPropIdResolution =
  | { kind: "exact"; propId: string }
  | { kind: "crosswalk"; propId: string; fromPropId: string; method: string }
  | {
      kind: "named-fallback";
      propId: string;
      taxYear: number;
      fromPropId: string;
      method: string;
      evidenceClass: string;
    }
  | { kind: "miss"; propId: string };

/**
 * Pure decision helper for tests: given an exact declared-year hit and
 * an optional single crosswalk target and named fallback, choose the
 * prop id/year to read. Order is exact -> crosswalk -> named fallback
 * -> miss.
 * Ambiguous (>1) crosswalk inputs are a programmer error — callers must
 * enforce uniqueness before calling.
 */
export function chooseCadPropIdResolution(opts: {
  requestedPropId: string;
  exactDeclaredHit: boolean;
  crosswalk?: { toPropId: string; method: string } | null;
  namedFallback?: {
    fallbackPropId: string;
    fallbackTaxYear: number;
    method: string;
    evidenceClass: string;
  } | null;
}): CadPropIdResolution {
  if (opts.exactDeclaredHit) {
    return { kind: "exact", propId: opts.requestedPropId };
  }
  if (opts.crosswalk && opts.crosswalk.toPropId.length > 0) {
    return {
      kind: "crosswalk",
      propId: opts.crosswalk.toPropId,
      fromPropId: opts.requestedPropId,
      method: opts.crosswalk.method,
    };
  }
  if (
    opts.namedFallback &&
    opts.namedFallback.fallbackPropId.length > 0 &&
    Number.isInteger(opts.namedFallback.fallbackTaxYear)
  ) {
    return {
      kind: "named-fallback",
      propId: opts.namedFallback.fallbackPropId,
      taxYear: opts.namedFallback.fallbackTaxYear,
      fromPropId: opts.requestedPropId,
      method: opts.namedFallback.method,
      evidenceClass: opts.namedFallback.evidenceClass,
    };
  }
  return { kind: "miss", propId: opts.requestedPropId };
}
