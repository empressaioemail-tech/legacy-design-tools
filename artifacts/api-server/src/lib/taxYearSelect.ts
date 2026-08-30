/**
 * CTX W1 tax-year selection (W0 `_inbox/2026-08-30_ctx_w0_tax_year.md`).
 *
 * Silent last-wins / arbitrary page-order wins is the defect. For each
 * `countyFips:prop_id` the bake keeps the max yeared atom, or an unyeared
 * singleton, and refuses when same-year (or unyeared) load-bearing fields
 * disagree. Winner among an agreeing set is `entity_id` ASC, never page order.
 *
 * Pure. Does not import the bake builder (the builder imports this).
 */

export type TaxYearRule =
  | "max-year"
  | "max-year-agree"
  | "max-year-disagree"
  | "unyeared-singleton"
  | "unyeared-disagree";

export interface TaxYearAtom {
  body: Record<string, unknown>;
  entityId: string;
  /** True when `assertSitusNotPunctuationOnly` refused this atom. */
  situsRefuse: boolean;
}

export type TaxYearSelection =
  | { outcome: "dropped" }
  | {
      outcome: "selected";
      body: Record<string, unknown>;
      entityId: string;
      taxYear: number | null;
      taxYearRule: TaxYearRule;
      /** True when claim fields must be refused (unmeasured / absent). */
      refused: boolean;
    };

export const TAX_YEAR_LOAD_BEARING_FIELDS = [
  "situsAddress",
  "situsCity",
  "propertyUseCode",
  "landAcres",
] as const;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function strOrNull(v: unknown): string | null {
  if (typeof v === "string") return v.trim() ? v.trim() : null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function finiteOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function claimRecord(body: Record<string, unknown>): Record<string, unknown> {
  const nested = asRecord(body.claim);
  return nested ?? body;
}

function loadBearingFingerprint(body: Record<string, unknown>): string {
  const claim = claimRecord(body);
  return JSON.stringify({
    situsAddress: strOrNull(claim.situsAddress),
    situsCity: strOrNull(claim.situsCity),
    propertyUseCode: strOrNull(claim.propertyUseCode),
    landAcres: finiteOrNull(claim.landAcres),
  });
}

function yearOf(atom: TaxYearAtom): number | null {
  const claim = claimRecord(atom.body);
  const src = asRecord(claim.sourceIdentifiers) ?? asRecord(atom.body.sourceIdentifiers) ?? {};
  const y = finiteOrNull(src.taxYear);
  return y != null && Number.isInteger(y) ? y : null;
}

function byEntityIdAsc(a: TaxYearAtom, b: TaxYearAtom): number {
  if (a.entityId < b.entityId) return -1;
  if (a.entityId > b.entityId) return 1;
  return 0;
}

function allAgree(atoms: readonly TaxYearAtom[]): boolean {
  if (atoms.length <= 1) return true;
  const first = loadBearingFingerprint(atoms[0]!.body);
  return atoms.every((a) => loadBearingFingerprint(a.body) === first);
}

function pick(atoms: readonly TaxYearAtom[]): TaxYearAtom {
  return [...atoms].sort(byEntityIdAsc)[0]!;
}

/**
 * Select the claim body for one parcel node. Punctuation-only situs atoms
 * are dropped first. A missing year is never defaulted to the calendar year.
 */
export function selectTaxYearWinner(
  atoms: readonly TaxYearAtom[],
): TaxYearSelection {
  const kept = atoms.filter((a) => !a.situsRefuse);
  if (kept.length === 0) return { outcome: "dropped" };

  const yeared = kept.filter((a) => yearOf(a) != null);
  if (yeared.length > 0) {
    const maxYear = Math.max(...yeared.map((a) => yearOf(a)!));
    const atMax = yeared.filter((a) => yearOf(a) === maxYear);
    const winner = pick(atMax);
    if (atMax.length === 1) {
      return {
        outcome: "selected",
        body: winner.body,
        entityId: winner.entityId,
        taxYear: maxYear,
        taxYearRule: "max-year",
        refused: false,
      };
    }
    const agree = allAgree(atMax);
    return {
      outcome: "selected",
      body: winner.body,
      entityId: winner.entityId,
      taxYear: maxYear,
      taxYearRule: agree ? "max-year-agree" : "max-year-disagree",
      refused: !agree,
    };
  }

  const winner = pick(kept);
  if (kept.length === 1) {
    return {
      outcome: "selected",
      body: winner.body,
      entityId: winner.entityId,
      taxYear: null,
      taxYearRule: "unyeared-singleton",
      refused: false,
    };
  }
  return {
    outcome: "selected",
    body: winner.body,
    entityId: winner.entityId,
    taxYear: null,
    taxYearRule: "unyeared-disagree",
    refused: true,
  };
}
