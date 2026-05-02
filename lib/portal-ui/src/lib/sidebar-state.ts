import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export const LEFT_SIDEBAR_DEFAULT_WIDTH = 256;
export const LEFT_SIDEBAR_MIN_WIDTH = 180;
export const LEFT_SIDEBAR_MAX_WIDTH = 420;

export const RIGHT_SIDEBAR_DEFAULT_WIDTH = 420;
export const RIGHT_SIDEBAR_MIN_WIDTH = 280;
export const RIGHT_SIDEBAR_MAX_WIDTH = 720;

function clampLeft(width: number): number {
  if (Number.isNaN(width)) return LEFT_SIDEBAR_DEFAULT_WIDTH;
  return Math.min(
    LEFT_SIDEBAR_MAX_WIDTH,
    Math.max(LEFT_SIDEBAR_MIN_WIDTH, Math.round(width)),
  );
}

function clampRight(width: number): number {
  if (Number.isNaN(width)) return RIGHT_SIDEBAR_DEFAULT_WIDTH;
  return Math.min(
    RIGHT_SIDEBAR_MAX_WIDTH,
    Math.max(RIGHT_SIDEBAR_MIN_WIDTH, Math.round(width)),
  );
}

export interface SidebarStateValue {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  leftWidth: number;
  rightWidth: number;
  toggleLeft: () => void;
  toggleRight: () => void;
  setLeft: (collapsed: boolean) => void;
  setRight: (collapsed: boolean) => void;
  setLeftWidth: (width: number) => void;
  setRightWidth: (width: number) => void;
  resetLeftWidth: () => void;
  resetRightWidth: () => void;
}

export const useSidebarState = create<SidebarStateValue>()(
  persist(
    (set) => ({
      leftCollapsed: false,
      rightCollapsed: false,
      leftWidth: LEFT_SIDEBAR_DEFAULT_WIDTH,
      rightWidth: RIGHT_SIDEBAR_DEFAULT_WIDTH,
      toggleLeft: () =>
        set((s) => ({ leftCollapsed: !s.leftCollapsed })),
      toggleRight: () =>
        set((s) => ({ rightCollapsed: !s.rightCollapsed })),
      setLeft: (collapsed) => set({ leftCollapsed: collapsed }),
      setRight: (collapsed) => set({ rightCollapsed: collapsed }),
      setLeftWidth: (width) => set({ leftWidth: clampLeft(width) }),
      setRightWidth: (width) => set({ rightWidth: clampRight(width) }),
      resetLeftWidth: () => set({ leftWidth: LEFT_SIDEBAR_DEFAULT_WIDTH }),
      resetRightWidth: () => set({ rightWidth: RIGHT_SIDEBAR_DEFAULT_WIDTH }),
    }),
    {
      name: "portal-ui:sidebars",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        leftCollapsed: s.leftCollapsed,
        rightCollapsed: s.rightCollapsed,
        leftWidth: s.leftWidth,
        rightWidth: s.rightWidth,
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
        };
      },
    },
  ),
);
