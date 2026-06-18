/**
 * Map / area context for brokerage research chat (extension MapLibre state).
 */

import { z } from "zod";

export const RESEARCH_AREA_VISIBLE_PARCEL = z.object({
  parcelId: z.string().optional(),
  address: z.string().optional(),
  latitude: z.number().finite().optional(),
  longitude: z.number().finite().optional(),
  zoning: z.string().optional(),
  rentZestimate: z.number().optional(),
  price: z.number().optional(),
  verdict: z.enum(["keep", "pass", "watch"]).optional(),
  attrs: z.record(z.unknown()).optional(),
});

export const RESEARCH_AREA_CONTEXT = z
  .object({
    /** `area` = map-level question; `property` = default single-listing focus. */
    scope: z.enum(["property", "area"]).optional().default("property"),
    jurisdictionKey: z.string().optional(),
    jurisdictionCity: z.string().nullable().optional(),
    jurisdictionState: z.string().nullable().optional(),
    mapBounds: z
      .object({
        north: z.number().finite(),
        south: z.number().finite(),
        east: z.number().finite(),
        west: z.number().finite(),
      })
      .optional(),
    activeFilters: z.record(z.unknown()).optional(),
    visibleParcels: z.array(RESEARCH_AREA_VISIBLE_PARCEL).max(100).optional(),
  })
  .optional();

export type ResearchAreaContext = z.infer<typeof RESEARCH_AREA_CONTEXT>;

export function isAreaResearchChatEligible(
  areaContext: ResearchAreaContext | undefined,
): boolean {
  if (!areaContext) return false;
  if (areaContext.scope === "area") return true;
  return (areaContext.visibleParcels?.length ?? 0) > 0;
}

export function formatResearchAreaContextForLlm(
  areaContext: ResearchAreaContext | undefined,
): string {
  if (!areaContext) return "";

  const lines: string[] = ["Map / area context (extension):"];
  lines.push(`Scope: ${areaContext.scope ?? "property"}`);

  const jParts = [
    areaContext.jurisdictionCity,
    areaContext.jurisdictionState,
    areaContext.jurisdictionKey,
  ].filter(Boolean);
  if (jParts.length) {
    lines.push(`Jurisdiction: ${jParts.join(" / ")}`);
  }

  if (areaContext.mapBounds) {
    const b = areaContext.mapBounds;
    lines.push(
      `Viewport: N${b.north.toFixed(4)} S${b.south.toFixed(4)} E${b.east.toFixed(4)} W${b.west.toFixed(4)}`,
    );
  }

  if (areaContext.activeFilters && Object.keys(areaContext.activeFilters).length) {
    lines.push(
      `Active filters: ${JSON.stringify(areaContext.activeFilters).slice(0, 1200)}`,
    );
  }

  const parcels = areaContext.visibleParcels ?? [];
  if (parcels.length) {
    lines.push(`Visible parcels (${parcels.length}):`);
    for (const [i, p] of parcels.slice(0, 40).entries()) {
      const bits = [
        p.address,
        p.parcelId ? `id=${p.parcelId}` : null,
        p.zoning ? `zoning=${p.zoning}` : null,
        p.rentZestimate != null ? `rent≈$${p.rentZestimate}` : null,
        p.price != null ? `price≈$${p.price}` : null,
        p.verdict ? `verdict=${p.verdict}` : null,
      ].filter(Boolean);
      lines.push(`  ${i + 1}. ${bits.join(" | ") || "(no label)"}`);
    }
    if (parcels.length > 40) {
      lines.push(`  … and ${parcels.length - 40} more parcels in view`);
    }
  }

  return lines.join("\n");
}
