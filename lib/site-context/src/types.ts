export type ProjectType =
  | "new_build"
  | "renovation"
  | "addition"
  | "tenant_improvement"
  | "other";

export interface Geocode {
  latitude: number;
  longitude: number;
  jurisdictionCity: string | null;
  jurisdictionState: string | null;
  jurisdictionFips: string | null;
  source: "nominatim" | "manual";
  geocodedAt: string;
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
