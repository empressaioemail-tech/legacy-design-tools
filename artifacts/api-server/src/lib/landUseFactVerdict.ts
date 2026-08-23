/**
 * Apply doc 19 layer verdicts to landUseFact when zoning authority is absent
 * by parcel shape (unincorporated / unzoned county doctrine).
 *
 * INTERIM APPLICABILITY (instrument brief 2026-08-22): contract Shape is not
 * armed yet. Until it lands, not-applicable for municipal zoning on
 * unincorporated land uses `isUnincorporatedNoZoningAuthorityShape` plus
 * texas_county_roster_v1 `zoning_regime.unincorporated=unzoned` — declared
 * per-family applicability, not a boolean default.
 */

import {
  buildZoningNotApplicableAbsence,
  isUnincorporatedNoZoningAuthorityShape,
  mergeLayerVerdict,
} from "./verdictLayerServe";

const LAND_USE_FACT_SOURCE = "land-use-fact" as const;

type LandUseAtomMiss = {
  state: "refused";
  code: "atom-miss";
  source: typeof LAND_USE_FACT_SOURCE;
  tried: readonly string[];
  reason: string;
};

export type LandUseFactVerdictInput = LandUseAtomMiss | {
  state: "present" | "absent" | "refused";
  code?: string;
  source: string;
  [key: string]: unknown;
};

function landUseFactAlreadyHasVerdict(landUseFact: LandUseFactVerdictInput): boolean {
  const verdict = (landUseFact as { verdict?: unknown }).verdict;
  return typeof verdict === "string" && verdict.trim().length > 0;
}

function landUseFactEligibleForZoningNotApplicable(
  landUseFact: LandUseFactVerdictInput,
): boolean {
  if (landUseFactAlreadyHasVerdict(landUseFact)) return false;
  if (landUseFact.state === "refused" && landUseFact.code === "atom-miss") {
    return true;
  }
  // Baked parcels in unzoned counties carry a bound land-use-fact atom with
  // state=absent (e.g. no-cad-row) — still unincorporated no-zoning shape.
  if (landUseFact.state === "absent") return true;
  return false;
}

/**
 * When land-use is missing or absent on unincorporated land with no zoning
 * authority, emit not-applicable instead of bare atom-miss / untyped absent
 * (P-63 WDLL item 3).
 */
export function enrichLandUseFactWithZoningVerdict<T extends LandUseFactVerdictInput>(
  landUseFact: T,
  parcelNodeId: string,
  bakedFacets: unknown,
): T {
  if (!landUseFactEligibleForZoningNotApplicable(landUseFact)) {
    return landUseFact;
  }
  if (!isUnincorporatedNoZoningAuthorityShape(parcelNodeId, bakedFacets)) {
    return landUseFact;
  }
  const absence = buildZoningNotApplicableAbsence();
  return mergeLayerVerdict(
    {
      ...landUseFact,
      source: LAND_USE_FACT_SOURCE,
    },
    absence,
  ) as T;
}
