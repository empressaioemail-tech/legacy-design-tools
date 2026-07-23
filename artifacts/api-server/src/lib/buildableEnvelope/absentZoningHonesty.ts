/**
 * Absent-zoning honesty: when mapDistrict picks the conservative fallback
 * because the parcel has no zoning stamp, callers must not present that row
 * as a real district determination (e.g. Bexar null → stamped I-2).
 *
 * The envelope may still carry a conservative setback shape; the wire status
 * is declined with declineReason "no-zoning-stamp", and the district name is
 * scrubbed from top-level + geojson props.
 */

import type { BuildableEnvelopeResult } from "./derive";
import type { DistrictMappingResult } from "./districtMapping";

export const NO_ZONING_STAMP_REASON = "no-zoning-stamp";

/** Label used in geojson setbacks.district when no stamp exists. */
export const CONSERVATIVE_ESTIMATE_DISTRICT_LABEL =
  "conservative-estimate (no zoning stamp)";

export function isAbsentZoningFallback(
  district: DistrictMappingResult,
): boolean {
  return district.kind === "fallback-conservative";
}

export function absentZoningDisclosure(setbacks: {
  front_ft: number;
  side_ft: number;
  rear_ft: number;
}): string {
  return (
    `No zoning stamp on this parcel. Conservative setback estimate only ` +
    `(${setbacks.front_ft}/${setbacks.side_ft}/${setbacks.rear_ft} ft ` +
    `front/side/rear) — not a district determination. ` +
    `Verify zoning with the city before relying on it.`
  );
}

/**
 * Scrub a derived geojson so consumers cannot read a fabricated district
 * name off setbacks.district / disclosure while still drawing the estimate.
 */
export function scrubAbsentZoningGeojson(
  geojson: BuildableEnvelopeResult["geojson"],
  setbacks: { front_ft: number; side_ft: number; rear_ft: number },
): BuildableEnvelopeResult["geojson"] {
  const disclosure = absentZoningDisclosure(setbacks);
  return {
    type: "FeatureCollection",
    features: geojson.features.map((f) => ({
      ...f,
      properties: {
        ...f.properties,
        disclosure,
        districtNote:
          "No zoning stamp — conservative setback estimate only; not a district determination.",
        setbacks: {
          ...f.properties.setbacks,
          district: CONSERVATIVE_ESTIMATE_DISTRICT_LABEL,
        },
      },
    })),
  };
}
