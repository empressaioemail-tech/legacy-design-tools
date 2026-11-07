/**
 * Apply the doc 19 zoning verdict to landUseFact when municipal zoning
 * authority is not applicable to the parcel (unincorporated, unzoned county).
 *
 * CTX card F (2026-08-28): the verdict is DERIVED ONCE in the route from the
 * city-limits containment fact (`zoningVerdictFromCityLimits`) and passed in
 * here; this module no longer reads baked facets or `baseFacts.situsCity`.
 * Only a `not-applicable` verdict (index populated, point outside every
 * incorporated place, county unincorporated territory unzoned) is merged onto
 * a missing or absent land-use fact. `stamp-missing` and `unmeasured` say
 * nothing about land use and leave the fact untouched.
 *
 * INTERIM APPLICABILITY (instrument brief 2026-08-22): contract Shape is not
 * armed yet; texas_county_roster_v1 `zoning_regime.unincorporated=unzoned`
 * is the declared per-family applicability, never a boolean default.
 */

import { mergeLayerVerdict, type LayerAbsenceWire } from "./verdictLayerServe";

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
  // state=absent (e.g. no-cad-row) — still eligible for not-applicable.
  if (landUseFact.state === "absent") return true;
  return false;
}

/**
 * When land-use is missing or absent on unincorporated land with no zoning
 * authority, emit not-applicable instead of bare atom-miss / untyped absent
 * (P-63 WDLL item 3). The not-applicable decision is the containment-derived
 * zoning verdict; nothing here derives it.
 */
export function enrichLandUseFactWithZoningVerdict<T extends LandUseFactVerdictInput>(
  landUseFact: T,
  zoningVerdict: LayerAbsenceWire | null | undefined,
): T {
  if (!zoningVerdict || zoningVerdict.verdict !== "not-applicable") {
    return landUseFact;
  }
  if (!landUseFactEligibleForZoningNotApplicable(landUseFact)) {
    return landUseFact;
  }
  return mergeLayerVerdict(
    {
      ...landUseFact,
      source: LAND_USE_FACT_SOURCE,
    },
    zoningVerdict,
  ) as T;
}
