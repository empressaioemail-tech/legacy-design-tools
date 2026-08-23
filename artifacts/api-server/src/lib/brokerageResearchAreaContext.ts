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

/**
 * Researched subject parcel's zoning constraints (setbacks + buildable envelope).
 * Fully optional so content-bundle / intel-panel callers that send no subject
 * never break. Numbers are approximate, not survey-grade (honesty contract).
 */
export const RESEARCH_AREA_SUBJECT_PARCEL_FACTS = z.object({
  acreageAc: z.number().nullish(),
  acreageSqft: z.number().nullish(),
  livingAreaSqft: z.number().nullish(),
  floodZoneLabel: z.string().nullish(),
  landUseCode: z.string().nullish(),
  landUseDescription: z.string().nullish(),
  zoningDistrict: z.string().nullish(),
});

export const RESEARCH_AREA_SUBJECT = z.object({
  parcelNodeId: z.string().nullish(),
  address: z.string().nullish(),
  setbacks: z
    .object({
      front_ft: z.number().nullish(),
      side_ft: z.number().nullish(),
      rear_ft: z.number().nullish(),
      district: z.string().nullish(),
    })
    .nullish(),
  envelope: z
    .object({
      buildableAreaSqFt: z.number().nullish(),
      buildableAreaPct: z.number().nullish(),
      maxHeightFt: z.number().nullish(),
      maxLotCoveragePct: z.number().nullish(),
      maxFootprintSqFt: z.number().nullish(),
      notSurveyGrade: z.boolean().nullish(),
      approximate: z.boolean().nullish(),
      edgeSignal: z.string().nullish(), // "road" | "point" | "shape"
      disclosure: z.string().nullish(),
      citationUrl: z.string().nullish(),
    })
    .nullish(),
  parcelFacts: RESEARCH_AREA_SUBJECT_PARCEL_FACTS.nullish(),
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
    /** Researched subject parcel constraints (setbacks + buildable envelope). */
    subject: RESEARCH_AREA_SUBJECT.nullish(),
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
  subjectCitationNumber?: number,
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

  const subjectBlock = formatSubjectConstraintsForLlm(
    areaContext.subject,
    subjectCitationNumber,
  );
  if (subjectBlock) {
    lines.push("");
    lines.push(subjectBlock);
  }

  return lines.join("\n");
}

/**
 * Renders the researched subject parcel's setbacks + buildable envelope for the
 * LLM prompt, present-fields-only, always carrying the not-survey-grade hedge.
 * Returns "" when no subject (or no usable subject fields) are supplied.
 *
 * `citationNumber` is optional and additive: when the caller has registered
 * this subject as a numbered source (see brokerageBrief.ts research/chat —
 * the subject-parcel-facts entry is prepended to the numbered atom sources
 * so [n] citations can resolve to it), pass that number so the instruction
 * tells the model to cite it by number instead of the generic "cite the
 * source" phrasing that had no numbered target to point at.
 */
export function formatSubjectConstraintsForLlm(
  subject: z.infer<typeof RESEARCH_AREA_SUBJECT> | null | undefined,
  citationNumber?: number,
): string {
  if (!subject) return "";

  const sb = subject.setbacks ?? undefined;
  const env = subject.envelope ?? undefined;
  const pf = subject.parcelFacts ?? undefined;

  const detail: string[] = [];

  const district = sb?.district ?? pf?.zoningDistrict;
  if (district) detail.push(`- Zoning district: ${district}`);

  if (pf?.acreageAc != null) {
    const sqftPart =
      pf.acreageSqft != null
        ? ` (${pf.acreageSqft.toLocaleString("en-US")} sqft)`
        : "";
    detail.push(`- Lot size: ${pf.acreageAc} ac${sqftPart}`);
  } else if (pf?.acreageSqft != null) {
    detail.push(
      `- Lot size: ${pf.acreageSqft.toLocaleString("en-US")} sqft`,
    );
  }

  if (pf?.livingAreaSqft != null) {
    detail.push(
      `- Living area: ${pf.livingAreaSqft.toLocaleString("en-US")} sqft`,
    );
  }

  if (pf?.floodZoneLabel) {
    detail.push(`- Flood zone: ${pf.floodZoneLabel}`);
  }

  const landUseCode = pf?.landUseCode;
  const landUseDescription = pf?.landUseDescription;
  if (landUseCode || landUseDescription) {
    const label =
      landUseCode && landUseDescription
        ? `${landUseCode} — ${landUseDescription}`
        : landUseDescription || landUseCode;
    detail.push(`- Land use: ${label}`);
  }

  const setbackParts: string[] = [];
  if (sb?.front_ft != null) setbackParts.push(`front ${sb.front_ft} ft`);
  if (sb?.side_ft != null) setbackParts.push(`side ${sb.side_ft} ft`);
  if (sb?.rear_ft != null) setbackParts.push(`rear ${sb.rear_ft} ft`);
  if (setbackParts.length) detail.push(`- Setbacks: ${setbackParts.join(", ")}`);

  const envParts: string[] = [];
  if (env?.buildableAreaSqFt != null) {
    const pct =
      env.buildableAreaPct != null ? ` (${env.buildableAreaPct}% of lot)` : "";
    envParts.push(`buildable area ${env.buildableAreaSqFt} sqft${pct}`);
  } else if (env?.buildableAreaPct != null) {
    envParts.push(`buildable area ${env.buildableAreaPct}% of lot`);
  }
  if (env?.maxFootprintSqFt != null) {
    envParts.push(`max footprint ${env.maxFootprintSqFt} sqft`);
  }
  if (env?.maxHeightFt != null) envParts.push(`max height ${env.maxHeightFt} ft`);
  if (env?.maxLotCoveragePct != null) {
    envParts.push(`max lot coverage ${env.maxLotCoveragePct}%`);
  }
  if (envParts.length) detail.push(`- Envelope: ${envParts.join("; ")}`);

  const edgeSignal = env?.edgeSignal;
  const lowerConfidence =
    env?.approximate === true ||
    edgeSignal === "shape" ||
    edgeSignal === "point";
  if (edgeSignal) {
    const hedge = lowerConfidence
      ? ` — front edge inferred from parcel ${edgeSignal}, lower confidence`
      : "";
    detail.push(`- Front-edge inference: ${edgeSignal}${hedge}`);
  } else if (lowerConfidence) {
    detail.push("- Note: envelope is approximate (lower confidence)");
  }

  if (env?.disclosure) detail.push(`- ${env.disclosure}`);
  if (env?.citationUrl) detail.push(`- Source: ${env.citationUrl}`);

  // Nothing usable to render (no PII in this shape by contract).
  if (!detail.length) return "";

  const header =
    "SUBJECT PARCEL CONSTRAINTS (approximate, not survey-grade — verify with city):";
  const citeInstruction =
    citationNumber != null
      ? `answer from them and cite them as [${citationNumber}]`
      : "answer from them and cite the source";
  const instruction =
    "When the user asks about setbacks / ADU / additions / lot size / flood / " +
    "land use and SUBJECT PARCEL CONSTRAINTS are present, " +
    `${citeInstruction}; state they ` +
    "are approximate and to verify with the city. If absent, say the setbacks " +
    "aren't resolved for this parcel yet — do not fabricate.";

  return [header, ...detail, instruction].join("\n");
}
