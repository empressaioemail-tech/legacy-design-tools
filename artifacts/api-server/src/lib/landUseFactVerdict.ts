/**
 * Apply doc 19 layer verdicts to landUseFact when zoning authority is absent
 * by parcel shape (unincorporated / unzoned county doctrine).
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

/**
 * When land-use atom is missing on unincorporated land with no zoning authority,
 * emit not-applicable instead of bare atom-miss (P-63 WDLL item 3).
 */
export function enrichLandUseFactWithZoningVerdict<T extends LandUseFactVerdictInput>(
  landUseFact: T,
  parcelNodeId: string,
  bakedFacets: unknown,
): T {
  if (landUseFact.state !== "refused" || landUseFact.code !== "atom-miss") {
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
