/** Legacy tab ids (panels); consolidated under top-level views in the header. */
export type TabId =
  | "snapshots"
  | "sheets"
  | "model-3d"
  | "site"
  | "site-context"
  | "property-intel"
  | "submissions"
  | "findings"
  | "response-tasks"
  | "deliverable-letters"
  | "detail-callouts"
  | "product-specs"
  | "renders"
  | "presentations"
  | "publish-prep"
  | "publish-launch"
  | "settings";

/** Top-level engagement surfaces (fixed header). */
export type EngagementViewId =
  | "model"
  | "site"
  | "review"
  | "deliver"
  | "studio"
  | "settings";

export const ENGAGEMENT_VIEW_IDS: EngagementViewId[] = [
  "model",
  "site",
  "review",
  "deliver",
  "studio",
  "settings",
];

export const ENGAGEMENT_VIEW_LABELS: Record<EngagementViewId, string> = {
  model: "Model",
  site: "Site",
  review: "Review",
  deliver: "Deliver",
  studio: "Studio",
  settings: "Settings",
};

export const TAB_TO_VIEW: Record<TabId, EngagementViewId> = {
  snapshots: "model",
  sheets: "deliver",
  "model-3d": "model",
  site: "site",
  "site-context": "site",
  "property-intel": "site",
  submissions: "review",
  findings: "review",
  "response-tasks": "review",
  "deliverable-letters": "review",
  "detail-callouts": "deliver",
  "product-specs": "deliver",
  renders: "studio",
  presentations: "studio",
  "publish-prep": "studio",
  "publish-launch": "studio",
  settings: "settings",
};

export const VIEW_DEFAULT_TAB: Record<EngagementViewId, TabId> = {
  model: "snapshots",
  site: "site",
  review: "findings",
  deliver: "product-specs",
  studio: "publish-prep",
  settings: "settings",
};

export interface ViewSegment {
  tab: TabId;
  label: string;
  testId: string;
}

export const VIEW_SEGMENTS: Record<EngagementViewId, ViewSegment[]> = {
  model: [
    { tab: "snapshots", label: "Snapshots", testId: "engagement-tab-snapshots" },
    { tab: "model-3d", label: "3D model", testId: "engagement-tab-model-3d" },
  ],
  site: [
    { tab: "site", label: "Map", testId: "engagement-tab-site" },
    {
      tab: "property-intel",
      label: "Property Intel",
      testId: "engagement-tab-property-intel",
    },
  ],
  review: [
    { tab: "findings", label: "Findings", testId: "engagement-tab-findings" },
    {
      tab: "submissions",
      label: "Submissions",
      testId: "engagement-tab-submissions",
    },
    {
      tab: "response-tasks",
      label: "Tasks",
      testId: "engagement-tab-response-tasks",
    },
    {
      tab: "deliverable-letters",
      label: "Letters",
      testId: "engagement-tab-deliverable-letters",
    },
  ],
  deliver: [
    { tab: "sheets", label: "Sheets", testId: "engagement-tab-sheets" },
    {
      tab: "product-specs",
      label: "Product specs",
      testId: "engagement-tab-product-specs",
    },
    {
      tab: "detail-callouts",
      label: "Callouts",
      testId: "engagement-tab-detail-callouts",
    },
  ],
  studio: [
    {
      tab: "publish-prep",
      label: "Publish",
      testId: "engagement-tab-publish-prep",
    },
    {
      tab: "renders",
      label: "Rendering",
      testId: "engagement-tab-renders",
    },
    {
      tab: "presentations",
      label: "Presentations",
      testId: "engagement-tab-presentations",
    },
  ],
  settings: [],
};

export function tabToView(tab: TabId): EngagementViewId {
  return TAB_TO_VIEW[tab];
}

export function isEngagementViewId(raw: string): raw is EngagementViewId {
  return (ENGAGEMENT_VIEW_IDS as string[]).includes(raw);
}

/** Legacy top-level view slug from pre-Studio IA. */
export function normalizeEngagementViewId(raw: string): EngagementViewId | null {
  if (raw === "publish") return "studio";
  return isEngagementViewId(raw) ? raw : null;
}

function isTabId(raw: string): raw is TabId {
  return Object.prototype.hasOwnProperty.call(TAB_TO_VIEW, raw);
}

/** Map legacy `?tab=` or `?view=` + optional `?segment=` to a TabId. */
export function resolveTabFromSearchParams(params: URLSearchParams): TabId {
  const legacyTab = params.get("tab");
  if (legacyTab === "site-context") return "property-intel";
  if (legacyTab === "publish-launch") return "publish-prep";
  if (legacyTab && isTabId(legacyTab)) return legacyTab;

  const viewRaw = params.get("view");
  const view = viewRaw ? normalizeEngagementViewId(viewRaw) : null;
  if (view) {
    const segment = params.get("segment");
    if (segment && isTabId(segment)) {
      if (segment === "site-context") return "property-intel";
      if (segment === "publish-launch") return "publish-prep";
      if (TAB_TO_VIEW[segment] === view) return segment;
      // Honor segment when the view slug is stale (e.g. letters moved deliver → review).
      return segment;
    }
    return VIEW_DEFAULT_TAB[view];
  }

  return "snapshots";
}

export function writeViewStateToUrl(nextTab: TabId): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.delete("tab");

  const view = tabToView(nextTab);
  const defaultTab = VIEW_DEFAULT_TAB[view];

  if (view === "model" && nextTab === "snapshots") {
    url.searchParams.delete("view");
    url.searchParams.delete("segment");
  } else {
    url.searchParams.set("view", view);
    if (nextTab !== defaultTab) {
      url.searchParams.set("segment", nextTab);
    } else {
      url.searchParams.delete("segment");
    }
  }

  window.history.replaceState(null, "", url.toString());
}
