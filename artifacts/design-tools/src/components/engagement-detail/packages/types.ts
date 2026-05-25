export type {
  EngagementPackageRecord,
  PackageFormSnapshot,
  PackageSelection,
  PackageShareComment,
  PackageShareView,
  PackageStatus,
  PackageTemplateId,
} from "@workspace/api-client-react";

import type { PackageTemplateId as TemplateId } from "@workspace/api-client-react";

export interface PackageSelectionRequired {
  includeIntake?: boolean;
  includeBriefing?: boolean;
  renderIds: string[];
  videoIds: string[];
  sheetIds: string[];
  heroRenderId?: string | null;
}

export function emptyPackageSelection(): PackageSelectionRequired {
  return {
    includeIntake: false,
    includeBriefing: false,
    renderIds: [],
    videoIds: [],
    sheetIds: [],
    heroRenderId: null,
  };
}

export const PACKAGE_TEMPLATE_LABELS: Record<TemplateId, string> = {
  "client-presentation": "Client presentation",
  "client-review": "Client plan review",
  "publisher-handoff": "Publisher handoff",
  "jurisdiction-manifest": "Submittal manifest",
};

export const PACKAGE_TEMPLATE_DESCRIPTIONS: Record<TemplateId, string> = {
  "client-presentation":
    "Branded deck materials — hero render, key sheets, talking points.",
  "client-review":
    "Share a review link so your client can comment on the plan set.",
  "publisher-handoff":
    "Exhibit C intake form plus renders, videos, and plan sheets as a ZIP.",
  "jurisdiction-manifest":
    "Manifest of what went out with a jurisdiction submission.",
};

export function isPackageTemplateId(raw: string): raw is TemplateId {
  return raw in PACKAGE_TEMPLATE_LABELS;
}

export function readPackageTemplateFromUrl(): TemplateId {
  if (typeof window === "undefined") return "client-presentation";
  const t = new URL(window.location.href).searchParams.get("packageTemplate");
  return t && isPackageTemplateId(t) ? t : "client-presentation";
}

export function writePackageTemplateToUrl(template: TemplateId): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (template === "client-presentation") {
    url.searchParams.delete("packageTemplate");
  } else {
    url.searchParams.set("packageTemplate", template);
  }
  window.history.replaceState(null, "", url.toString());
}
