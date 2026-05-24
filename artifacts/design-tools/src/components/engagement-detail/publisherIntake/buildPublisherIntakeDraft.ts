import type { EngagementDetail, EngagementBriefingResponse } from "@workspace/api-client-react";
import { isDemoSeedEnabled } from "../../../demo/seed";
import { emptyPublisherIntakeForm } from "./exhibitCConstants";
import type {
  PublisherFieldSources,
  PublisherIntakeForm,
  PublisherPlanType,
} from "./types";

function formatUsDate(iso: string | null | undefined): string {
  if (!iso) return new Date().toLocaleDateString("en-US");
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return new Date().toLocaleDateString("en-US");
  return d.toLocaleDateString("en-US");
}

function inferPlanType(
  projectType: EngagementDetail["site"] extends null
    ? null
    : NonNullable<EngagementDetail["site"]>["projectType"],
): PublisherPlanType {
  if (projectType === "tenant_improvement") return "multi_family";
  return "single_family";
}

function inferStyleFromName(planName: string): string[] {
  const lower = planName.toLowerCase();
  const hits: string[] = [];
  if (lower.includes("cabin")) hits.push("Cabin");
  if (lower.includes("craftsman")) hits.push("Craftsman");
  if (lower.includes("modern") || lower.includes("contemporary")) {
    hits.push("Contemporary");
  }
  if (lower.includes("ranch")) hits.push("Ranch");
  if (lower.includes("farm")) hits.push("Farm House");
  if (lower.includes("lake")) hits.push("Lake Front");
  return hits;
}

function briefingSummary(briefing: EngagementBriefingResponse | null | undefined): string {
  const narrative = briefing?.briefing?.narrative;
  if (!narrative) return "";
  const snippets = [
    narrative.sectionA,
    narrative.sectionG,
    narrative.sectionE,
  ]
    .map((s) => s?.trim())
    .filter(Boolean);
  return snippets.join(" ");
}

function buildDescription(
  engagement: EngagementDetail,
  briefing: EngagementBriefingResponse | null | undefined,
): string {
  const parts: string[] = [];
  if (engagement.address) parts.push(`Site: ${engagement.address}`);
  if (engagement.jurisdiction) parts.push(`Jurisdiction: ${engagement.jurisdiction}`);
  if (engagement.site?.projectType) {
    parts.push(
      `Project type: ${engagement.site.projectType.replace(/_/g, " ")}`,
    );
  }
  if (engagement.site?.zoningCode) {
    parts.push(`Zoning: ${engagement.site.zoningCode}`);
  }
  if (engagement.site?.lotAreaSqft) {
    parts.push(`Lot area: ${engagement.site.lotAreaSqft.toLocaleString()} sq ft`);
  }
  const brief = briefingSummary(briefing);
  if (brief) parts.push(brief);
  return parts.join(". ");
}

const DEMO_INTAKE_EXTRAS: Partial<PublisherIntakeForm> = {
  numberOfStories: "2",
  numberOfBedrooms: "3",
  numberOfFullBaths: "2",
  numberOfHalfBaths: "1",
  garageTypes: ["Front Entry"],
  garageStalls: "2",
  mainRoofPitch: "8",
  sqftFirstFloor: "1,240",
  sqftSecondFloor: "980",
  sqftTotalHeated: "2,220",
  widthFeetInches: "62'-0\"",
  depthFeetInches: "48'-6\"",
  heightFeetInches: "28'-0\"",
  porchTypes: ["Front"],
  foundations: ["Slab"],
  planFeatures: ["Master on Main", "Bonus Room", "Home Office", "Laundry on Main Floor"],
};

export interface PublisherIntakeDraft {
  form: PublisherIntakeForm;
  sources: PublisherFieldSources;
}

/** Build Exhibit C draft from engagement, site briefing, and model metadata. */
export function buildPublisherIntakeDraft(
  engagement: EngagementDetail,
  briefing?: EngagementBriefingResponse | null,
): PublisherIntakeDraft {
  const form = emptyPublisherIntakeForm();
  const sources: PublisherFieldSources = {};

  const designerName =
    engagement.applicantFirm?.trim() ||
    engagement.architectOfRecord?.name?.trim() ||
    "";
  if (designerName) {
    form.designerName = designerName;
    sources.designerName = "engagement";
  }

  form.designerPlanName = engagement.name;
  sources.designerPlanName = "engagement";

  const planNumber =
    engagement.revitDocumentPath?.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, "") ||
    engagement.revitCentralGuid?.slice(0, 12) ||
    engagement.id;
  form.designerPlanNumber = planNumber;
  sources.designerPlanNumber = engagement.revitCentralGuid ? "model" : "engagement";

  form.formDate = formatUsDate(engagement.updatedAt);
  sources.formDate = "engagement";

  form.planType = inferPlanType(engagement.site?.projectType ?? null);
  sources.planType = engagement.site?.projectType ? "site" : "engagement";

  form.architecturalStyles = inferStyleFromName(engagement.name);
  if (form.architecturalStyles.length) {
    sources.architecturalStyles = "engagement";
  }

  const description = buildDescription(engagement, briefing);
  if (description) {
    form.houseDescription = description;
    sources.houseDescription = briefing?.briefing?.narrative
      ? "briefing"
      : "site";
  }

  if (isDemoSeedEnabled()) {
    Object.assign(form, DEMO_INTAKE_EXTRAS);
    for (const key of Object.keys(DEMO_INTAKE_EXTRAS) as (keyof PublisherIntakeForm)[]) {
      sources[key] = "demo";
    }
  }

  return { form, sources };
}

export function countAutoFilledFields(sources: PublisherFieldSources): number {
  return Object.keys(sources).length;
}

export function countRequiredPublisherFields(form: PublisherIntakeForm): {
  filled: number;
  total: number;
} {
  const scalarKeys: (keyof PublisherIntakeForm)[] = [
    "designerName",
    "designerPlanNumber",
    "designerPlanName",
    "formDate",
    "planType",
    "numberOfStories",
    "numberOfBedrooms",
    "numberOfFullBaths",
    "houseDescription",
  ];
  let filled = 0;
  for (const key of scalarKeys) {
    const val = form[key];
    if (typeof val === "string" && val.trim()) filled += 1;
  }
  if (form.architecturalStyles.length > 0) filled += 1;
  if (form.planFeatures.length > 0) filled += 1;
  const roomsWithDims = form.rooms.filter(
    (r) => r.width.trim() || r.depth.trim(),
  ).length;
  if (roomsWithDims > 0) filled += 1;
  return { filled, total: scalarKeys.length + 3 };
}

/** Re-apply auto-fill without clobbering manual edits. */
export function mergePublisherIntakeDraft(
  current: PublisherIntakeForm,
  currentSources: PublisherFieldSources,
  draft: PublisherIntakeDraft,
): { form: PublisherIntakeForm; sources: PublisherFieldSources } {
  const form = { ...current };
  const sources = { ...currentSources };

  for (const key of Object.keys(draft.form) as (keyof PublisherIntakeForm)[]) {
    const prevSource = currentSources[key];
    if (prevSource === "manual") continue;
    form[key] = draft.form[key] as never;
    if (draft.sources[key]) {
      sources[key] = draft.sources[key];
    }
  }

  return { form, sources };
}
