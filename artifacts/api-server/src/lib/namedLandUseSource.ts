/**
 * CTX W1 named land-use source (W0b `_inbox/2026-08-30_ctx_w0b_landuse_source.json`).
 *
 * Source: `land-use-fact.landUseCode` / `cad_property.property_use_code`.
 * Rejected: nested `body.claim.propertyUseCode` only, and treating bake
 * `baseFacts.landUse` as the source (that is the miss).
 *
 * The bake projects that code or writes absent-verified. `landUse: null`
 * plus `coverage: false` is illegal (A-025 present-as-absent).
 *
 * Store fetches live in `namedLandUseSourceFetch.ts` so this module stays
 * DB-free (the builder tests import it).
 */

export type NamedLandUseSourceKind = "land-use-fact" | "cad-property";

export interface NamedLandUseHit {
  code: string;
  vintage: string | null;
  source: NamedLandUseSourceKind;
}

export interface AbsentVerifiedLeaf {
  verdict: "absent-verified";
  authority: string;
  scopeSearched: string;
  asOf: string;
  basis: string;
  /** Present-shaped keys are never set; they exist so `landUse?.code` type-narrows. */
  code?: never;
  source?: never;
  description?: never;
  vintage?: never;
}

export function isAbsentVerifiedLeaf(v: unknown): v is AbsentVerifiedLeaf {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    r.verdict === "absent-verified" &&
    typeof r.authority === "string" &&
    r.authority.trim() !== "" &&
    typeof r.scopeSearched === "string" &&
    r.scopeSearched.trim() !== "" &&
    typeof r.asOf === "string" &&
    r.asOf.trim() !== "" &&
    typeof r.basis === "string" &&
    r.basis.trim() !== ""
  );
}

export function absentVerifiedLandUse(asOf: string): AbsentVerifiedLeaf {
  return {
    verdict: "absent-verified",
    authority: "tx:cad-property",
    scopeSearched:
      "land-use-fact.landUseCode and cad_property.property_use_code for this parcel",
    asOf,
    basis:
      "source responded; named land-use field empty on the roll and no land-use-fact code (shared documented rule: CAD/atom null is absent-verified)",
  };
}

/**
 * A-025 / BP-ABSENCE-01: `landUse: null` plus `coverage: false` is the miss.
 * A present code or a five-field absent-verified leaf is legal.
 */
export function landUseBakeLegal(payload: {
  baseFacts?: { landUse?: unknown };
  facetCoverage?: { landUse?: boolean };
}): boolean {
  const lu = payload.baseFacts?.landUse;
  const cov = payload.facetCoverage?.landUse;
  if (lu == null && cov === false) return false;
  if (lu == null) return false;
  if (isAbsentVerifiedLeaf(lu)) return true;
  if (
    typeof lu === "object" &&
    lu !== null &&
    typeof (lu as { code?: unknown }).code === "string" &&
    (lu as { code: string }).code.trim() !== ""
  ) {
    return true;
  }
  return false;
}

export function pickNamedLandUse(
  fact: NamedLandUseHit | null | undefined,
  cad: NamedLandUseHit | null | undefined,
): NamedLandUseHit | null {
  if (fact?.code) return fact;
  if (cad?.code) return cad;
  return null;
}
