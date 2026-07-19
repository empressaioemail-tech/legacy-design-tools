export type ProjectType =
  | "new_build"
  | "renovation"
  | "addition"
  | "tenant_improvement"
  | "other";

/**
 * Which rung of the broaden-on-miss geocode ladder produced the hit.
 * The ladder walks the full street address first, then a coarser
 * "City ST ZIP" line, then the bare ZIP. Only "street" is rooftop-
 * grade; "locality" and "zip" are CENTROIDS kilometres from any given
 * rooftop and must NOT be treated as a precise point (that silent
 * degradation is the F4d bug). Optional/back-compat: absent on a
 * manually-set geocode.
 */
export type GeocodeMatchRung = "street" | "locality" | "zip";

export interface Geocode {
  latitude: number;
  longitude: number;
  jurisdictionCity: string | null;
  jurisdictionState: string | null;
  jurisdictionFips: string | null;
  source: "nominatim" | "manual";
  geocodedAt: string;
  /** Ladder rung that matched (see {@link GeocodeMatchRung}). */
  matchRung?: GeocodeMatchRung;
  raw?: unknown;
}

export interface Site {
  engagementId: string;
  address: string | null;
  geocode: Geocode | null;
  projectType: ProjectType | null;
  zoningCode: string | null;
  lotAreaSqft: number | null;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Parcel {}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Zoning {}
