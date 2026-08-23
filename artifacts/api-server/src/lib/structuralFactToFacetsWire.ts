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

function layerAbsenceFromRecord(
  value: unknown,
): LayerAbsenceWire | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (o.status !== "absent" || typeof o.verdict !== "string") return null;
  if (
    typeof o.authority !== "string" ||
    typeof o.scopeSearched !== "string" ||
    typeof o.asOf !== "string" ||
    typeof o.basis !== "string"
  ) {
    return null;
  }
  return {
    status: "absent",
    verdict: o.verdict as LayerAbsenceWire["verdict"],
    authority: o.authority,
    scopeSearched: o.scopeSearched,
    asOf: o.asOf,
    basis: o.basis,
    provenanceClass:
      o.provenanceClass === "Observation" ||
      o.provenanceClass === "Derivation" ||
      o.provenanceClass === "Synthesis"
        ? o.provenanceClass
        : "Record",
    subjectKind:
      o.subjectKind === "intensional" ? "intensional" : "extensional",
    chainAnchoring:
      o.chainAnchoring === "contemporaneous" ? "contemporaneous" : "backfill",
    serveLayer: typeof o.serveLayer === "string" ? o.serveLayer : "cad",
    entityType:
      typeof o.entityType === "string" ? o.entityType : "cad-parcel-roll",
  };
}

function bakedZoningHasDistrict(zoning: unknown): boolean {
  if (!zoning || typeof zoning !== "object" || Array.isArray(zoning)) return false;
  const district = (zoning as { district?: unknown }).district;
  return typeof district === "string" && district.trim().length > 0;
}

/**
 * Attach P-63 verdict wires onto baked facets for inspect (livingAreaSqft + zoning N/A).
 */
export function attachVerdictLayersToFacets(
  facets: Record<string, unknown>,
  structuralFact: StructuralFactRead,
  landUseFact: unknown,
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

  const zoningAbsence = layerAbsenceFromRecord(landUseFact);
  if (
    zoningAbsence?.verdict === "not-applicable" &&
    !bakedZoningHasDistrict(out.zoning)
  ) {
    out.zoning = zoningAbsence;
    cov.zoning = false;
  }

  out.facetCoverage = cov;
  return out;
}
