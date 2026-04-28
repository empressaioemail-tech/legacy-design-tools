import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export interface SidebarStateValue {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  toggleLeft: () => void;
  toggleRight: () => void;
  setLeft: (collapsed: boolean) => void;
  setRight: (collapsed: boolean) => void;
}

export const useSidebarState = create<SidebarStateValue>()(
  persist(
    (set) => ({
      leftCollapsed: false,
      rightCollapsed: false,
      toggleLeft: () =>
        set((s) => ({ leftCollapsed: !s.leftCollapsed })),
      toggleRight: () =>
        set((s) => ({ rightCollapsed: !s.rightCollapsed })),
      setLeft: (collapsed) => set({ leftCollapsed: collapsed }),
      setRight: (collapsed) => set({ rightCollapsed: collapsed }),
    }),
    {
      name: "portal-ui:sidebars",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        leftCollapsed: s.leftCollapsed,
        rightCollapsed: s.rightCollapsed,
      }),
    },
  ),
);
