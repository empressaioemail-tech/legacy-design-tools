import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export const LEFT_SIDEBAR_DEFAULT_WIDTH = 256;
export const LEFT_SIDEBAR_MIN_WIDTH = 180;
export const LEFT_SIDEBAR_MAX_WIDTH = 420;

export const RIGHT_SIDEBAR_DEFAULT_WIDTH = 420;
export const RIGHT_SIDEBAR_MIN_WIDTH = 280;
export const RIGHT_SIDEBAR_MAX_WIDTH = 720;

// Project rail (cockpit inner list rail, between the slim icon rail
// and the main content). Independent of the global left sidebar so
// architects can collapse the list without losing the icon nav.
export const PROJECT_RAIL_DEFAULT_WIDTH = 280;
export const PROJECT_RAIL_MIN_WIDTH = 220;
export const PROJECT_RAIL_MAX_WIDTH = 380;

// Views rail (per-engagement vertical tab strip on the right of the
// engagement-detail page).
export const VIEWS_RAIL_DEFAULT_WIDTH = 220;
export const VIEWS_RAIL_MIN_WIDTH = 180;
export const VIEWS_RAIL_MAX_WIDTH = 320;

function clamp(width: number, min: number, max: number, fallback: number): number {
  if (Number.isNaN(width)) return fallback;
  return Math.min(max, Math.max(min, Math.round(width)));
}

function clampLeft(width: number): number {
  return clamp(width, LEFT_SIDEBAR_MIN_WIDTH, LEFT_SIDEBAR_MAX_WIDTH, LEFT_SIDEBAR_DEFAULT_WIDTH);
}

function clampRight(width: number): number {
  return clamp(width, RIGHT_SIDEBAR_MIN_WIDTH, RIGHT_SIDEBAR_MAX_WIDTH, RIGHT_SIDEBAR_DEFAULT_WIDTH);
}

function clampProject(width: number): number {
  return clamp(width, PROJECT_RAIL_MIN_WIDTH, PROJECT_RAIL_MAX_WIDTH, PROJECT_RAIL_DEFAULT_WIDTH);
}

function clampViews(width: number): number {
  return clamp(width, VIEWS_RAIL_MIN_WIDTH, VIEWS_RAIL_MAX_WIDTH, VIEWS_RAIL_DEFAULT_WIDTH);
}

export interface SidebarStateValue {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  leftWidth: number;
  rightWidth: number;
  projectRailCollapsed: boolean;
  projectRailWidth: number;
  viewsRailCollapsed: boolean;
  viewsRailWidth: number;
  /**
   * Per-section collapse state for the left sidebar nav groups,
   * keyed by the group's label. A missing key means expanded (the
   * default), so a brand-new group is open until the user collapses
   * it. Persisted alongside the width/collapsed state.
   */
  collapsedGroups: Record<string, boolean>;
  toggleLeft: () => void;
  toggleRight: () => void;
  setLeft: (collapsed: boolean) => void;
  setRight: (collapsed: boolean) => void;
  setLeftWidth: (width: number) => void;
  setRightWidth: (width: number) => void;
  resetLeftWidth: () => void;
  resetRightWidth: () => void;
  toggleProjectRail: () => void;
  setProjectRailWidth: (width: number) => void;
  resetProjectRailWidth: () => void;
  toggleViewsRail: () => void;
  setViewsRailWidth: (width: number) => void;
  resetViewsRailWidth: () => void;
  /** Toggle the collapsed state of one left-sidebar nav group. */
  toggleGroup: (label: string) => void;
}

export const useSidebarState = create<SidebarStateValue>()(
  persist(
    (set) => ({
      leftCollapsed: false,
      rightCollapsed: false,
      leftWidth: LEFT_SIDEBAR_DEFAULT_WIDTH,
      rightWidth: RIGHT_SIDEBAR_DEFAULT_WIDTH,
      projectRailCollapsed: false,
      projectRailWidth: PROJECT_RAIL_DEFAULT_WIDTH,
      viewsRailCollapsed: false,
      viewsRailWidth: VIEWS_RAIL_DEFAULT_WIDTH,
      collapsedGroups: {},
      toggleLeft: () => set((s) => ({ leftCollapsed: !s.leftCollapsed })),
      toggleRight: () => set((s) => ({ rightCollapsed: !s.rightCollapsed })),
      setLeft: (collapsed) => set({ leftCollapsed: collapsed }),
      setRight: (collapsed) => set({ rightCollapsed: collapsed }),
      setLeftWidth: (width) => set({ leftWidth: clampLeft(width) }),
      setRightWidth: (width) => set({ rightWidth: clampRight(width) }),
      resetLeftWidth: () => set({ leftWidth: LEFT_SIDEBAR_DEFAULT_WIDTH }),
      resetRightWidth: () => set({ rightWidth: RIGHT_SIDEBAR_DEFAULT_WIDTH }),
      toggleProjectRail: () =>
        set((s) => ({ projectRailCollapsed: !s.projectRailCollapsed })),
      setProjectRailWidth: (width) =>
        set({ projectRailWidth: clampProject(width) }),
      resetProjectRailWidth: () =>
        set({ projectRailWidth: PROJECT_RAIL_DEFAULT_WIDTH }),
      toggleViewsRail: () =>
        set((s) => ({ viewsRailCollapsed: !s.viewsRailCollapsed })),
      setViewsRailWidth: (width) =>
        set({ viewsRailWidth: clampViews(width) }),
      resetViewsRailWidth: () =>
        set({ viewsRailWidth: VIEWS_RAIL_DEFAULT_WIDTH }),
      toggleGroup: (label) =>
        set((s) => ({
          collapsedGroups: {
            ...s.collapsedGroups,
            [label]: !s.collapsedGroups[label],
          },
        })),
    }),
    {
      name: "portal-ui:sidebars",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        leftCollapsed: s.leftCollapsed,
        rightCollapsed: s.rightCollapsed,
        leftWidth: s.leftWidth,
        rightWidth: s.rightWidth,
        projectRailCollapsed: s.projectRailCollapsed,
        projectRailWidth: s.projectRailWidth,
        viewsRailCollapsed: s.viewsRailCollapsed,
        viewsRailWidth: s.viewsRailWidth,
        collapsedGroups: s.collapsedGroups,
      }),
      // Re-clamp persisted widths so a corrupted/stale value (or a
      // value saved under older min/max bounds) can't render the
      // workspace into an unusable narrow strip on next page load.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<SidebarStateValue>;
        return {
          ...current,
          ...p,
          leftWidth:
            typeof p.leftWidth === "number"
              ? clampLeft(p.leftWidth)
              : current.leftWidth,
          rightWidth:
            typeof p.rightWidth === "number"
              ? clampRight(p.rightWidth)
              : current.rightWidth,
          projectRailWidth:
            typeof p.projectRailWidth === "number"
              ? clampProject(p.projectRailWidth)
              : current.projectRailWidth,
          viewsRailWidth:
            typeof p.viewsRailWidth === "number"
              ? clampViews(p.viewsRailWidth)
              : current.viewsRailWidth,
        };
      },
    },
  ),
);
