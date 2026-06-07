/**
 * Briefing callouts from site-drainage atom payloads — Phase 2D.3.4.
 *
 * Appends L1-style drainage findings to briefing sections B (threshold
 * hazards) and E (buildable envelope / terrain) with citations back to
 * the site-drainage atom.
 */

import type { BriefingSections } from "@workspace/briefing-engine";

export interface SiteDrainageBriefingInput {
  engagementId: string;
  rainfallDepthInches?: number | null;
  forcingSource?: string | null;
  flowLineCount?: number | null;
  drainageZoneCount?: number | null;
  hydrologyLibrary?: string | null;
}

function citeSiteDrainage(engagementId: string): string {
  return `{{atom|site-drainage|${engagementId}|Site drainage analysis}}`;
}

/**
 * Merge drainage findings into generated briefing sections. Pure
 * post-processor — does not mutate inputs without drainage data.
 */
export function mergeSiteDrainageIntoBriefingSections(
  sections: BriefingSections,
  input: SiteDrainageBriefingInput | null,
): BriefingSections {
  if (!input) return sections;
  const cite = citeSiteDrainage(input.engagementId);
  const depth =
    typeof input.rainfallDepthInches === "number"
      ? `${input.rainfallDepthInches} in`
      : "design-storm depth";
  const forcing = input.forcingSource ?? "manual/NOAA Atlas 14";
  const flowLines = input.flowLineCount ?? 0;
  const zones = input.drainageZoneCount ?? 0;

  const drainageB =
    `Hydrology pass (${input.hydrologyLibrary ?? "D8"}) identified ${zones} on-parcel drainage zone(s) and ${flowLines} primary flow path(s) ${cite}. ` +
    `Rainfall simulation at ${depth} (${forcing}) informs threshold runoff exposure — coordinate with civil for stormwater design.`;

  const drainageE =
    `Terrain drainage analysis shows upstream catchment delivers runoff toward the parcel pour point; primary flow exits follow the ${flowLines} traced flow line(s) ${cite}. ` +
    `Verify finished-floor elevation against the ${depth} ponding scenario before locking the envelope.`;

  return {
    ...sections,
    b: `${sections.b} ${drainageB}`.trim(),
    e: `${sections.e} ${drainageE}`.trim(),
  };
}
