/**
 * Road-class-aware setback lookup for envelope derive (27c WDLL 4).
 * Jurisdiction knowledge lives here as fixtures — engine RULE mirror.
 */

import type { EdgeLabel } from "./edgeLabeling";
import type { V1RoadClassification } from "./roadClassify";

export interface RoadClassSetbackCell {
  road_class: V1RoadClassification;
  edge_role: EdgeLabel;
  setback_ft: number;
  not_specified?: boolean;
}

export interface RoadClassSetbackDistrictRow {
  district_code: string;
  entries: ReadonlyArray<RoadClassSetbackCell>;
}

/** Bastrop B3 P-5 pilot — street front 15', alley rear 5'. */
export const BASTROP_P5_ROAD_CLASS_SETBACKS: RoadClassSetbackDistrictRow = {
  district_code: "P-5",
  entries: [
    { road_class: "residential", edge_role: "front", setback_ft: 15 },
    { road_class: "minor_collector", edge_role: "front", setback_ft: 15 },
    { road_class: "alley", edge_role: "rear", setback_ft: 5 },
    { road_class: "alley", edge_role: "front", setback_ft: 5 },
    {
      road_class: "residential",
      edge_role: "side",
      setback_ft: 0,
      not_specified: true,
    },
    {
      road_class: "residential",
      edge_role: "rear",
      setback_ft: 0,
      not_specified: true,
    },
  ],
};

function districtMatches(tableDistrict: string, wanted: string): boolean {
  const t = tableDistrict.trim().toLowerCase();
  const w = wanted.trim().toLowerCase();
  return w === t || w.startsWith(`${t} `) || w.startsWith(t);
}

export function roadClassSetbackFt(
  table: RoadClassSetbackDistrictRow | null | undefined,
  districtCode: string,
  roadClass: V1RoadClassification | undefined,
  edgeRole: EdgeLabel,
  flatFallback: (role: EdgeLabel) => number,
  flatNotSpecified?: (role: EdgeLabel) => boolean,
): number {
  if (table && districtMatches(table.district_code, districtCode)) {
    if (roadClass) {
      const hit = table.entries.find(
        (e) => e.road_class === roadClass && e.edge_role === edgeRole,
      );
      if (hit) {
        return hit.not_specified ? 0 : hit.setback_ft;
      }
    }
  }
  if (flatNotSpecified?.(edgeRole)) return 0;
  return flatFallback(edgeRole);
}

export function roadClassSetbackTableForJurisdiction(
  jurisdictionKey: string,
  districtName: string,
): RoadClassSetbackDistrictRow | null {
  if (jurisdictionKey !== "bastrop-city-tx") return null;
  if (!districtName.toUpperCase().startsWith("P-5")) return null;
  return BASTROP_P5_ROAD_CLASS_SETBACKS;
}
