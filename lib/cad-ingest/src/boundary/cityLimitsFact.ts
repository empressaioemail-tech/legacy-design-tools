/**
 * Typed city-limits serve DTO for inspect (P-76).
 *
 * Not an atom family. PIP against `tx_city_boundary` only.
 * ETJ is a typed absence (`etjStatus: unresolved`). A fabricated
 * offset / buffer ring is a defect — this module has no buffer path.
 */

import type { CityContainmentResult, EtjStatus } from "./containment";

export const CITY_LIMITS_SOURCE = "tx_city_boundary" as const;

export type CityLimitsStatus =
  | "incorporated"
  | "unincorporated"
  | "unmeasured";

export type CityLimitsFact = {
  status: CityLimitsStatus;
  etjStatus: EtjStatus;
  source: typeof CITY_LIMITS_SOURCE;
  basis: string;
  cityName?: string;
  geoId?: string;
  gnis?: string | null;
};

export function cityLimitsFactFromContainment(
  result: CityContainmentResult,
): CityLimitsFact {
  if (result.status === "incorporated") {
    return {
      status: "incorporated",
      etjStatus: result.etjStatus,
      source: CITY_LIMITS_SOURCE,
      basis: result.basis,
      cityName: result.cityName,
      geoId: result.geoId,
      gnis: result.gnis,
    };
  }
  return {
    status: result.status,
    etjStatus: result.etjStatus,
    source: CITY_LIMITS_SOURCE,
    basis: result.basis,
  };
}

export function unmeasuredCityLimitsFact(basis: string): CityLimitsFact {
  return {
    status: "unmeasured",
    etjStatus: "unresolved",
    source: CITY_LIMITS_SOURCE,
    basis,
  };
}

/** Degenerate bake centroid (0,0) and non-finite coords are not a query point. */
export function usableCityLimitsQueryPoint(
  longitude: number,
  latitude: number,
): { longitude: number; latitude: number } | null {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  if (longitude === 0 && latitude === 0) return null;
  return { longitude, latitude };
}
