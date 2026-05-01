import type { ReactNode } from "react";
import { Sidebar, type SidebarGroup } from "./Sidebar";
import { Header, type HeaderSearch } from "./Header";
import { useSidebarState } from "../lib/sidebar-state";

export interface DashboardLayoutProps {
  children: ReactNode;
  title?: string;
  brandLabel: string;
  brandProductName: string;
  navGroups: SidebarGroup[];
  rightPanel?: ReactNode;
  search?: HeaderSearch;
}

export function DashboardLayout({
  children,
  title,
  brandLabel,
  brandProductName,
  navGroups,
  rightPanel,
  search,
}: DashboardLayoutProps) {
  const rightCollapsed = useSidebarState((s) => s.rightCollapsed);
  const rightWidth = rightCollapsed ? 48 : 420;

  return (
    <div
      style={{
        display: "flex",
        minHeight: "100vh",
        background: "var(--bg-base)",
        color: "var(--text-primary)",
        fontFamily: "Inter, sans-serif",
      }}
    >
      <Sidebar
        brandLabel={brandLabel}
        brandProductName={brandProductName}
        groups={navGroups}
      />

      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
        }}
      >
        <Header title={title} search={search} />
        <main
          style={{
            flex: 1,
            padding: 24,
            background: "var(--bg-base)",
            minWidth: 0,
            overflowX: "hidden",
          }}
        >
          {children}
        </main>
      </div>

      {rightPanel && (
        <aside
          style={{
            width: rightWidth,
            flexShrink: 0,
            borderLeft: "1px solid var(--border-default)",
            background: "var(--ai-panel-bg)",
            height: "100vh",
            position: "sticky",
            top: 0,
            overflowY: "auto",
            overflowX: "hidden",
            transition: "width 200ms ease-out",
          }}
          className="sc-scroll"
        >
          {rightPanel}
        </aside>
      )}
    </div>
  );
}
