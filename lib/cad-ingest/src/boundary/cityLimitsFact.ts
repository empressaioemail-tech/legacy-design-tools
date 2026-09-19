/**
 * Typed city-limits serve DTO for inspect (P-76).
 *
 * Not an atom family. PIP against `tx_city_boundary` only.
 * ETJ is a typed absence (`etjStatus: unresolved`). A fabricated
 * offset / buffer ring is a defect — this module has no buffer path.
 */

import type {
  CityContainmentResult,
  EtjIncorporationSettlement,
  EtjStatus,
} from "./containment";

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

/**
 * P-376: this city-limits fact's own incorporation determination, in the shape
 * the ETJ determination consumes — or null when this fact settles nothing.
 *
 * "A real basis" is THIS TYPE's state, not a new judgement:
 *
 *   - `incorporated` is a POSITIVE determination, and it has to NAME the city it
 *     rests on: an `incorporated` fact with no `cityName` would be a legal
 *     ground with no subject for it, so it settles nothing;
 *   - `unmeasured` never settles. It is this type's own "nothing usable was
 *     determined" state, and it is where EVERY parcel_record refusal collapses
 *     (unaccounted, malformed cell, no such parcel or rail, store not
 *     configured, engine refused, invalid node id), so a refusal can never
 *     invent an incorporation;
 *   - `unincorporated` never settles. It is the opposite determination, and the
 *     published-ring test is exactly the check that exists for it.
 *
 * The `source` and `basis` fields are carried verbatim rather than validated
 * here: `source` is a non-empty literal on this type, and `basis` is the
 * sentence that carries the source of record and the vintage. The sentence is
 * deliberately NOT re-parsed — a parser would be a second owner of a string this
 * type already owns — and the servability of the whole settlement (a city, a
 * source and a basis, all non-empty) is checked once, where it is served, in
 * `resolveEtjByIncorporation`.
 */
export function incorporationSettlesEtj(
  fact: CityLimitsFact | null,
): EtjIncorporationSettlement | null {
  if (fact === null || fact.status !== "incorporated") return null;
  const cityName = fact.cityName?.trim() ?? "";
  if (cityName.length === 0) return null;
  return {
    cityName,
    geoId: fact.geoId ?? null,
    source: fact.source,
    cityLimitsBasis: fact.basis,
  };
}
