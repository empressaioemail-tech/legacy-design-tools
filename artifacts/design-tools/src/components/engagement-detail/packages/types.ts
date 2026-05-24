export type PackageTemplateId =
  | "client-presentation"
  | "client-review"
  | "publisher-handoff"
  | "jurisdiction-manifest";

export type PackageStatus =
  | "draft"
  | "exported"
  | "shared"
  | "handed-off"
  | "closed";

export interface PackageSelection {
  includeIntake?: boolean;
  includeBriefing?: boolean;
  renderIds: string[];
  videoIds: string[];
  sheetIds: string[];
  heroRenderId?: string | null;
}

export interface PackageFormSnapshot {
  publisherIntake?: Record<string, unknown>;
  clientHeadline?: string;
  clientTalkingPoints?: string;
  clientReviewNote?: string;
}

export interface EngagementPackageRecord {
  id: string;
  engagementId: string;
  template: PackageTemplateId;
  status: PackageStatus;
  title: string;
  snapshotId: string | null;
  selection: PackageSelection;
  formSnapshot: PackageFormSnapshot | null;
  clientReviewDeadline: string | null;
  linkedSubmissionId: string | null;
  exportedAt: string | null;
  shareToken: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PackageShareView {
  engagementName: string;
  package: EngagementPackageRecord;
  comments: PackageShareComment[];
}

export interface PackageShareComment {
  id: string;
  authorName: string;
  body: string;
  sheetId: string | null;
  createdAt: string;
}

export function emptyPackageSelection(): PackageSelection {
  return {
    includeIntake: false,
    includeBriefing: false,
    renderIds: [],
    videoIds: [],
    sheetIds: [],
    heroRenderId: null,
  };
}

export const PACKAGE_TEMPLATE_LABELS: Record<PackageTemplateId, string> = {
  "client-presentation": "Client presentation",
  "client-review": "Client plan review",
  "publisher-handoff": "Publisher handoff",
  "jurisdiction-manifest": "Submittal manifest",
};

export const PACKAGE_TEMPLATE_DESCRIPTIONS: Record<PackageTemplateId, string> = {
  "client-presentation":
    "Branded deck materials — hero render, key sheets, talking points.",
  "client-review":
    "Share a review link so your client can comment on the plan set.",
  "publisher-handoff":
    "Exhibit C intake form plus renders, videos, and plan sheets as a ZIP.",
  "jurisdiction-manifest":
    "Manifest of what went out with a jurisdiction submission.",
};

export function isPackageTemplateId(raw: string): raw is PackageTemplateId {
  return raw in PACKAGE_TEMPLATE_LABELS;
}

export function readPackageTemplateFromUrl(): PackageTemplateId {
  if (typeof window === "undefined") return "client-presentation";
  const t = new URL(window.location.href).searchParams.get("packageTemplate");
  return t && isPackageTemplateId(t) ? t : "client-presentation";
}

export function writePackageTemplateToUrl(template: PackageTemplateId): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (template === "client-presentation") {
    url.searchParams.delete("packageTemplate");
  } else {
    url.searchParams.set("packageTemplate", template);
  }
  window.history.replaceState(null, "", url.toString());
}
