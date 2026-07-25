/**
 * Map OSM highway=* to v1 road classification (27c R2).
 * Mirrors hauska-engine road-intake/classify.ts — keep in sync.
 */

export type V1RoadClassification =
  | "highway"
  | "major_collector"
  | "minor_collector"
  | "residential"
  | "alley"
  | "gravel"
  | "unclassified";

const OSM_TO_CLASS: Record<string, V1RoadClassification> = {
  motorway: "highway",
  motorway_link: "highway",
  trunk: "highway",
  trunk_link: "highway",
  primary: "highway",
  primary_link: "major_collector",
  secondary: "major_collector",
  secondary_link: "major_collector",
  tertiary: "minor_collector",
  tertiary_link: "minor_collector",
  residential: "residential",
  living_street: "residential",
  unclassified: "unclassified",
  service: "alley",
  track: "gravel",
  path: "gravel",
};

export function classifyOsmHighwayTag(
  highwayTag: string | null | undefined,
  tags?: Record<string, string>,
): V1RoadClassification {
  const normalized = (highwayTag ?? "").trim().toLowerCase();
  if (!normalized) return "unclassified";
  if (normalized === "service" && tags?.surface === "unpaved") {
    return "gravel";
  }
  return OSM_TO_CLASS[normalized] ?? "unclassified";
}

/** v1 assumed ROW width (feet) by classification — Bastrop pilot table. */
export const BASTROP_ASSUMED_ROW_WIDTH_FT: Readonly<
  Record<V1RoadClassification, number>
> = {
  highway: 100,
  major_collector: 60,
  minor_collector: 50,
  residential: 50,
  alley: 20,
  gravel: 30,
  unclassified: 40,
};
