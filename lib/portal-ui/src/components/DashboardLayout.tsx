import { useRef, useState, type ReactNode } from "react";
import { Sidebar, type SidebarGroup } from "./Sidebar";
import { Header, type HeaderSearch } from "./Header";
import {
  useSidebarState,
  RIGHT_SIDEBAR_MAX_WIDTH,
  RIGHT_SIDEBAR_MIN_WIDTH,
} from "../lib/sidebar-state";

const RIGHT_COLLAPSED_WIDTH = 48;
const KEYBOARD_NUDGE = 16;

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
  const rightWidth = useSidebarState((s) => s.rightWidth);
  const setRightWidth = useSidebarState((s) => s.setRightWidth);
  const resetRightWidth = useSidebarState((s) => s.resetRightWidth);

  const renderedWidth = rightCollapsed ? RIGHT_COLLAPSED_WIDTH : rightWidth;

  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (rightCollapsed) return;
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: rightWidth };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onHandlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = dragRef.current;
    if (!start) return;
    // Right panel grows when the pointer moves LEFT, hence the
    // negated delta.
    const next = start.startWidth - (e.clientX - start.startX);
    setRightWidth(next);
  };

  const onHandlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore — pointer may already be released
    }
  };

  const onHandleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (rightCollapsed) return;
    // Mirror the left rail's nudge keys, but flip arrow direction so
    // that ArrowLeft enlarges the panel (it grows leftward into the
    // workspace) and ArrowRight shrinks it.
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setRightWidth(rightWidth + KEYBOARD_NUDGE);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setRightWidth(rightWidth - KEYBOARD_NUDGE);
    } else if (e.key === "Home") {
      e.preventDefault();
      setRightWidth(RIGHT_SIDEBAR_MIN_WIDTH);
    } else if (e.key === "End") {
      e.preventDefault();
      setRightWidth(RIGHT_SIDEBAR_MAX_WIDTH);
    }
  };

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
            width: renderedWidth,
            flexShrink: 0,
            borderLeft: "1px solid var(--border-default)",
            background: "var(--ai-panel-bg)",
            height: "100vh",
            position: "sticky",
            top: 0,
            overflowY: "auto",
            overflowX: "hidden",
            transition: dragging ? "none" : "width 200ms ease-out",
          }}
          className="sc-scroll"
        >
          {!rightCollapsed && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize Claude panel"
              aria-valuemin={RIGHT_SIDEBAR_MIN_WIDTH}
              aria-valuemax={RIGHT_SIDEBAR_MAX_WIDTH}
              aria-valuenow={rightWidth}
              tabIndex={0}
              data-testid="right-panel-resize-handle"
              onPointerDown={onHandlePointerDown}
              onPointerMove={onHandlePointerMove}
              onPointerUp={onHandlePointerUp}
              onPointerCancel={onHandlePointerUp}
              onDoubleClick={resetRightWidth}
              onKeyDown={onHandleKeyDown}
              title="Drag to resize, double-click to reset"
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: 6,
                height: "100%",
                cursor: "col-resize",
                background: dragging ? "var(--cyan-dim)" : "transparent",
                transition: dragging ? "none" : "background 0.12s",
                outline: "none",
                zIndex: 5,
              }}
              onMouseEnter={(e) => {
                if (!dragging) {
                  e.currentTarget.style.background = "var(--cyan-dim)";
                }
              }}
              onMouseLeave={(e) => {
                if (!dragging) {
                  e.currentTarget.style.background = "transparent";
                }
              }}
              onFocus={(e) => {
                e.currentTarget.style.background = "var(--cyan-dim)";
              }}
              onBlur={(e) => {
                if (!dragging) {
                  e.currentTarget.style.background = "transparent";
                }
              }}
            />
          )}
          {rightPanel}
        </aside>
      )}
    </div>
  );
}
