/**
 * Map structuralFact read result → doc 19 LayerWire on facets.livingAreaSqft.
 */

import type { LayerAbsenceWire } from "./verdictLayerServe";
import type { StructuralFactAbsent, StructuralFactPresent, StructuralFactRead } from "./structuralFactResolve";

export type LivingAreaSqftLayerWire =
  | { status: "populated"; value: number }
  | LayerAbsenceWire;

export function structuralFactToLivingAreaWire(
  fact: StructuralFactRead,
): LivingAreaSqftLayerWire | null {
  if ("state" in fact && fact.state === "present") {
    const sqft = fact.livingAreaSqft;
    if (typeof sqft === "number" && Number.isFinite(sqft) && sqft > 0) {
      return { status: "populated", value: sqft };
    }
    return null;
  }
  const { source: _source, ...absence } = fact as StructuralFactAbsent;
  return absence;
}

function bakedZoningHasDistrict(zoning: unknown): boolean {
  if (!zoning || typeof zoning !== "object" || Array.isArray(zoning)) return false;
  const district = (zoning as { district?: unknown }).district;
  return typeof district === "string" && district.trim().length > 0;
}

/**
 * Attach P-63 verdict wires onto baked facets for inspect (livingAreaSqft +
 * the zoning verdict).
 *
 * CTX card F (2026-08-28): the zoning verdict is passed in, derived by the
 * route from the city-limits containment fact (`zoningVerdictFromCityLimits`).
 * It is attached whenever the baked zoning carries no district, for all three
 * verdicts (`not-applicable`, `stamp-missing`, `unmeasured`). Before this card
 * the zoning absence was read back off the land-use fact, which had been
 * merged from a situsCity predicate; that coupling is gone.
 */
export function attachVerdictLayersToFacets(
  facets: Record<string, unknown>,
  structuralFact: StructuralFactRead,
  zoningVerdict: LayerAbsenceWire | null | undefined,
): Record<string, unknown> {
  const out = { ...facets };
  const cov =
    out.facetCoverage && typeof out.facetCoverage === "object" && !Array.isArray(out.facetCoverage)
      ? { ...(out.facetCoverage as Record<string, unknown>) }
      : {};
  cov.structural = true;

  const livingWire = structuralFactToLivingAreaWire(structuralFact);
  if (livingWire) {
    out.livingAreaSqft = livingWire;
  }

  if (zoningVerdict && !bakedZoningHasDistrict(out.zoning)) {
    out.zoning = zoningVerdict;
    cov.zoning = false;
  }

  out.facetCoverage = cov;
  return out;
}
