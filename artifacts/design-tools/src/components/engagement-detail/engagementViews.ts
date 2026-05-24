/** Legacy tab ids (panels); consolidated under top-level views in the header. */
export type TabId =
  | "snapshots"
  | "sheets"
  | "model-3d"
  | "site"
  | "site-context"
  | "submissions"
  | "findings"
  | "response-tasks"
  | "deliverable-letters"
  | "detail-callouts"
  | "product-specs"
  | "renders"
  | "presentations"
  | "publish-prep"
  | "settings";

/** Top-level engagement surfaces (fixed header). */
export type EngagementViewId =
  | "model"
  | "site"
  | "review"
  | "deliver"
  | "publish"
  | "settings";

export const ENGAGEMENT_VIEW_IDS: EngagementViewId[] = [
  "model",
  "site",
  "review",
  "deliver",
  "publish",
  "settings",
];

export const ENGAGEMENT_VIEW_LABELS: Record<EngagementViewId, string> = {
  model: "Model",
  site: "Site",
  review: "Review",
  deliver: "Deliver",
  publish: "Publish",
  settings: "Settings",
};

export const TAB_TO_VIEW: Record<TabId, EngagementViewId> = {
  snapshots: "model",
  sheets: "model",
  "model-3d": "model",
  site: "site",
  "site-context": "site",
  submissions: "review",
  findings: "review",
  "response-tasks": "review",
  "deliverable-letters": "deliver",
  "detail-callouts": "deliver",
  "product-specs": "deliver",
  renders: "deliver",
  presentations: "deliver",
  "publish-prep": "publish",
  settings: "settings",
};

export const VIEW_DEFAULT_TAB: Record<EngagementViewId, TabId> = {
  model: "snapshots",
  site: "site",
  review: "findings",
  deliver: "presentations",
  publish: "publish-prep",
  settings: "settings",
};

export interface ViewSegment {
  tab: TabId;
  label: string;
  testId: string;
}

export const VIEW_SEGMENTS: Record<EngagementViewId, ViewSegment[]> = {
  model: [
    { tab: "snapshots", label: "Snapshots", testId: "view-segment-snapshots" },
    { tab: "sheets", label: "Sheets", testId: "view-segment-sheets" },
    { tab: "model-3d", label: "3D model", testId: "view-segment-model-3d" },
  ],
  site: [
    { tab: "site", label: "Site", testId: "view-segment-site" },
    {
      tab: "site-context",
      label: "Site context",
      testId: "view-segment-site-context",
    },
  ],
  review: [
    { tab: "findings", label: "Findings", testId: "view-segment-findings" },
    {
      tab: "submissions",
      label: "Submissions",
      testId: "view-segment-submissions",
    },
    {
      tab: "response-tasks",
      label: "Tasks",
      testId: "view-segment-response-tasks",
    },
  ],
  deliver: [
    {
      tab: "presentations",
      label: "Presentations",
      testId: "view-segment-presentations",
    },
    {
      tab: "product-specs",
      label: "Product specs",
      testId: "view-segment-product-specs",
    },
    {
      tab: "deliverable-letters",
      label: "Letters",
      testId: "view-segment-deliverable-letters",
    },
    {
      tab: "detail-callouts",
      label: "Callouts",
      testId: "view-segment-detail-callouts",
    },
    { tab: "renders", label: "Studio", testId: "view-segment-renders" },
  ],
  publish: [],
  settings: [],
};

export function tabToView(tab: TabId): EngagementViewId {
  return TAB_TO_VIEW[tab];
}

export function isEngagementViewId(raw: string): raw is EngagementViewId {
  return (ENGAGEMENT_VIEW_IDS as string[]).includes(raw);
}

function isTabId(raw: string): raw is TabId {
  return Object.prototype.hasOwnProperty.call(TAB_TO_VIEW, raw);
}

/** Map legacy `?tab=` or `?view=` + optional `?segment=` to a TabId. */
export function resolveTabFromSearchParams(params: URLSearchParams): TabId {
  const legacyTab = params.get("tab");
  if (legacyTab && isTabId(legacyTab)) return legacyTab;

  const viewRaw = params.get("view");
  if (viewRaw && isEngagementViewId(viewRaw)) {
    const segment = params.get("segment");
    if (segment && isTabId(segment) && TAB_TO_VIEW[segment] === viewRaw) {
      return segment;
    }
    return VIEW_DEFAULT_TAB[viewRaw];
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
