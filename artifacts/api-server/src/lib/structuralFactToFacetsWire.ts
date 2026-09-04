/**
 * Map structuralFact read result → doc 19 LayerWire on facets.livingAreaSqft.
 */

import type { LayerAbsenceWire } from "./verdictLayerServe";
import type { StructuralFactAbsent, StructuralFactPresent, StructuralFactRead } from "./structuralFactResolve";
import type { LivingAreaSqftFromParcelRecord } from "./cadRollFactFromParcelRecord";

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

/**
 * PARCEL-B-SLATE2: when the allowlist resolved livingAreaSqft to "record"
 * for this county, `overlay` carries the parcel_record-sourced value (or
 * `null` if the cell itself does not resolve to a usable value -- keep
 * legacy in that case too, fail closed). `null` also covers "not cut over
 * at all" (the overlay resolver itself returns null for that case) -- there
 * is deliberately no way to distinguish the two from this function's own
 * inputs; the caller's allowlist resolution is the single source of truth
 * for which case applies, and either way the correct fallback is identical:
 * keep computing from the legacy structuralFact exactly as before.
 */
export function structuralFactToLivingAreaWireWithOverlay(
  fact: StructuralFactRead,
  overlay: LivingAreaSqftFromParcelRecord,
): LivingAreaSqftLayerWire | null {
  if (!overlay) return structuralFactToLivingAreaWire(fact);
  if (overlay.status === "populated") return { status: "populated", value: overlay.value };
  // "absent-in-record": still need SOME LayerAbsenceWire shape for the wire.
  // The legacy absence shape (authority/scopeSearched/basis/etc.) is the
  // correct one to keep -- parcel_record's own cell absence does not carry
  // those fields, and the wire contract requires them.
  return structuralFactToLivingAreaWire(fact);
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
  livingAreaOverlay?: LivingAreaSqftFromParcelRecord,
): Record<string, unknown> {
  const out = { ...facets };
  const cov =
    out.facetCoverage && typeof out.facetCoverage === "object" && !Array.isArray(out.facetCoverage)
      ? { ...(out.facetCoverage as Record<string, unknown>) }
      : {};
  cov.structural = true;

  const livingWire = structuralFactToLivingAreaWireWithOverlay(
    structuralFact,
    livingAreaOverlay ?? null,
  );
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

/**
 * PARCEL-B-SLATE2: overlay the four dollar rails and yearBuilt onto the
 * baked snapshot's own baseFacts.cadRoll.* / baseFacts.yearBuilt, where the
 * allowlist resolved that rail to "record". A rail whose overlay is `null`
 * (not slated, verdict refused/excluded, or the cell itself did not
 * resolve) keeps whatever the bake already wrote -- untouched, not merged
 * field-by-field within cadRoll itself (a baked cadRoll object is already
 * whole; only the specific overlaid keys move).
 */
export function attachCadRollOverlaysToFacets(
  facets: Record<string, unknown>,
  overlay: {
    marketValue: unknown;
    assessedValue: unknown;
    landValue: unknown;
    improvementValue: unknown;
    yearBuilt: unknown;
  },
): Record<string, unknown> {
  const out = { ...facets };
  const base =
    out.baseFacts && typeof out.baseFacts === "object" && !Array.isArray(out.baseFacts)
      ? { ...(out.baseFacts as Record<string, unknown>) }
      : {};
  const cadRoll =
    base.cadRoll && typeof base.cadRoll === "object" && !Array.isArray(base.cadRoll)
      ? { ...(base.cadRoll as Record<string, unknown>) }
      : {};

  let cadRollChanged = false;
  for (const [key, value] of [
    ["marketValue", overlay.marketValue],
    ["assessedValue", overlay.assessedValue],
    ["landValue", overlay.landValue],
    ["improvementValue", overlay.improvementValue],
  ] as const) {
    if (value != null) {
      cadRoll[key] = value;
      cadRollChanged = true;
    }
  }
  if (cadRollChanged) base.cadRoll = cadRoll;

  if (overlay.yearBuilt != null) base.yearBuilt = overlay.yearBuilt;

  out.baseFacts = base;
  return out;
}
