import type { ReactNode } from "react";
import { Sidebar, type SidebarGroup } from "./Sidebar";
import { Header } from "./Header";

export interface DashboardLayoutProps {
  children: ReactNode;
  title?: string;
  brandLabel: string;
  brandProductName: string;
  navGroups: SidebarGroup[];
  rightPanel?: ReactNode;
  search?: { placeholder?: string };
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
            width: 420,
            flexShrink: 0,
            borderLeft: "1px solid var(--border-default)",
            background: "var(--ai-panel-bg)",
            height: "100vh",
            position: "sticky",
            top: 0,
            overflowY: "auto",
          }}
          className="sc-scroll"
        >
          {rightPanel}
        </aside>
      )}
    </div>
  );
}
