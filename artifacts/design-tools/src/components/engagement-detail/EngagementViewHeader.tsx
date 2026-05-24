import type { TabId } from "./urlState";
import {
  ENGAGEMENT_VIEW_LABELS,
  ENGAGEMENT_VIEW_IDS,
  VIEW_SEGMENTS,
  VIEW_DEFAULT_TAB,
  tabToView,
  type EngagementViewId,
} from "./engagementViews";
import { Settings } from "lucide-react";

export function EngagementViewHeader({
  activeTab,
  onSelectTab,
  findingsBadgeCount,
}: {
  activeTab: TabId;
  onSelectTab: (tab: TabId) => void;
  findingsBadgeCount?: number;
}) {
  const activeView = tabToView(activeTab);
  const segments = VIEW_SEGMENTS[activeView];

  const selectView = (view: EngagementViewId) => {
    if (view === "settings") {
      onSelectTab("settings");
      return;
    }
    const first = VIEW_SEGMENTS[view][0]?.tab ?? VIEW_DEFAULT_TAB[view];
    onSelectTab(first);
  };

  return (
    <div
      className="cockpit-engagement-view-header"
      data-testid="engagement-view-header"
    >
      <div
        className="cockpit-engagement-view-tabs"
        role="tablist"
        aria-label="Engagement views"
      >
        {ENGAGEMENT_VIEW_IDS.filter((v) => v !== "settings").map((view) => {
          const isActive = activeView === view;
          return (
            <button
              key={view}
              type="button"
              role="tab"
              aria-selected={isActive}
              className="cockpit-engagement-view-tab"
              data-active={isActive ? "true" : "false"}
              data-testid={`engagement-view-${view}`}
              onClick={() => selectView(view)}
            >
              {ENGAGEMENT_VIEW_LABELS[view]}
              {view === "review" &&
                typeof findingsBadgeCount === "number" &&
                findingsBadgeCount > 0 && (
                  <span
                    className="cockpit-engagement-view-badge"
                    data-testid="engagement-tab-findings-badge"
                  >
                    {findingsBadgeCount}
                  </span>
                )}
            </button>
          );
        })}
        <button
          type="button"
          role="tab"
          aria-selected={activeView === "settings"}
          className="cockpit-engagement-view-tab cockpit-engagement-view-tab-icon"
          data-active={activeView === "settings" ? "true" : "false"}
          data-testid="engagement-view-settings"
          title="Settings"
          onClick={() => onSelectTab("settings")}
        >
          <Settings size={16} aria-hidden="true" />
          <span className="sr-only">Settings</span>
        </button>
      </div>

      {segments.length > 0 && (
        <div
          className="cockpit-engagement-segment-tabs"
          role="tablist"
          aria-label={`${ENGAGEMENT_VIEW_LABELS[activeView]} sections`}
        >
          {segments.map((seg) => {
            const isActive = activeTab === seg.tab;
            return (
              <button
                key={seg.tab}
                type="button"
                role="tab"
                aria-selected={isActive}
                id={`engagement-tab-trigger-${seg.tab}`}
                aria-controls={`engagement-tabpanel-${seg.tab}`}
                className="cockpit-engagement-segment-tab"
                data-active={isActive ? "true" : "false"}
                data-testid={seg.testId}
                onClick={() => onSelectTab(seg.tab)}
              >
                {seg.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
