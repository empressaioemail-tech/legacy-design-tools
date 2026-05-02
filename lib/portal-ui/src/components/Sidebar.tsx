import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  useSidebarState,
  LEFT_SIDEBAR_DEFAULT_WIDTH,
  LEFT_SIDEBAR_MIN_WIDTH,
  LEFT_SIDEBAR_MAX_WIDTH,
} from "../lib/sidebar-state";

export interface SidebarItem {
  label: string;
  href: string;
  icon?: ReactNode;
  /**
   * Optional trailing badge (e.g. an unread-count pill). Rendered
   * only when the sidebar is expanded — the collapsed state shows
   * the icon alone since the count would not fit. Pass `null` /
   * `undefined` for items that do not need a badge.
   */
  badge?: ReactNode;
}

export interface SidebarGroup {
  label: string;
  items: SidebarItem[];
}

export interface SidebarProps {
  brandLabel: string;
  brandProductName: string;
  groups: SidebarGroup[];
}

const COLLAPSED_WIDTH = 56;
const KEYBOARD_NUDGE = 16;

function HexGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M12 2 L21.5 7 L21.5 17 L12 22 L2.5 17 L2.5 7 Z"
        fill="#6398AA"
      />
    </svg>
  );
}

function isActive(currentPath: string, href: string): boolean {
  if (href === "/") return currentPath === "/";
  return currentPath === href || currentPath.startsWith(href + "/");
}

export function Sidebar({ brandLabel, brandProductName, groups }: SidebarProps) {
  const [location] = useLocation();
  const collapsed = useSidebarState((s) => s.leftCollapsed);
  const toggleLeft = useSidebarState((s) => s.toggleLeft);
  const width = useSidebarState((s) => s.leftWidth);
  const setLeftWidth = useSidebarState((s) => s.setLeftWidth);
  const resetLeftWidth = useSidebarState((s) => s.resetLeftWidth);

  // Cmd/Ctrl+B keyboard shortcut (VS Code convention)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          target?.isContentEditable
        ) {
          return;
        }
        e.preventDefault();
        toggleLeft();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleLeft]);

  const renderedWidth = collapsed ? COLLAPSED_WIDTH : width;

  // Drag-to-resize. Captures the starting pointer X and width once on
  // pointer-down, then computes the new width from each pointermove
  // delta — that way the user's pointer stays glued to the drag
  // handle even when the clamp pins us at the min/max bounds.
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (collapsed) return;
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: width };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onHandlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = dragRef.current;
    if (!start) return;
    const next = start.startWidth + (e.clientX - start.startX);
    setLeftWidth(next);
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
    if (collapsed) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setLeftWidth(width - KEYBOARD_NUDGE);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setLeftWidth(width + KEYBOARD_NUDGE);
    } else if (e.key === "Home") {
      e.preventDefault();
      setLeftWidth(LEFT_SIDEBAR_MIN_WIDTH);
    } else if (e.key === "End") {
      e.preventDefault();
      setLeftWidth(LEFT_SIDEBAR_MAX_WIDTH);
    }
  };

  return (
    <aside
      style={{
        width: renderedWidth,
        background: "var(--bg-chrome)",
        borderRight: "1px solid var(--chrome-border)",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        height: "100vh",
        position: "sticky",
        top: 0,
        overflowY: "auto",
        overflowX: "hidden",
        // Skip the width transition mid-drag so the panel tracks the
        // pointer 1:1 instead of easing into the new width.
        transition: dragging ? "none" : "width 200ms ease-out",
      }}
      className="sc-scroll"
    >
      {/* Brand block */}
      <div
        style={{
          padding: collapsed ? "20px 0 16px 0" : "20px 18px 16px 18px",
          borderBottom: "1px solid var(--chrome-border)",
          display: "flex",
          alignItems: "center",
          justifyContent: collapsed ? "center" : "flex-start",
          gap: 12,
          minHeight: 56,
        }}
      >
        <HexGlyph size={22} />
        {!collapsed && (
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span
              style={{
                fontFamily: "Inter, sans-serif",
                fontSize: 9,
                fontWeight: 600,
                letterSpacing: "0.16em",
                textTransform: "uppercase",
                color: "var(--chrome-text-sec)",
              }}
            >
              {brandLabel}
            </span>
            <span
              style={{
                fontFamily: "Oxygen, sans-serif",
                fontSize: 18,
                fontWeight: 700,
                color: "var(--chrome-text)",
                lineHeight: 1.1,
              }}
            >
              {brandProductName}
            </span>
          </div>
        )}
      </div>

      {/* Groups */}
      <nav style={{ flex: 1, padding: "14px 0 24px" }}>
        {groups.map((group) => (
          <div key={group.label} style={{ marginBottom: 18 }}>
            {!collapsed && (
              <div
                className="sc-label"
                style={{
                  color: "var(--chrome-text-sec)",
                  padding: "0 18px 6px 18px",
                }}
              >
                {group.label}
              </div>
            )}
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {group.items.map((item) => {
                const active = isActive(location, item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      title={collapsed ? item.label : undefined}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: collapsed ? "center" : "flex-start",
                        gap: 10,
                        height: 30,
                        padding: collapsed ? "0" : "0 12px 0 15px",
                        fontFamily: "Inter, sans-serif",
                        fontSize: 12,
                        color: active
                          ? "var(--chrome-text)"
                          : "var(--chrome-text-sec)",
                        background: active
                          ? "var(--bg-active)"
                          : "transparent",
                        borderLeft: active
                          ? "3px solid #6398AA"
                          : "3px solid transparent",
                        textDecoration: "none",
                        cursor: "pointer",
                        transition: "background 0.12s, color 0.12s",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                      }}
                      onMouseEnter={(e) => {
                        if (!active) {
                          e.currentTarget.style.background =
                            "var(--bg-highlight)";
                          e.currentTarget.style.color = "var(--chrome-text)";
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!active) {
                          e.currentTarget.style.background = "transparent";
                          e.currentTarget.style.color =
                            "var(--chrome-text-sec)";
                        }
                      }}
                    >
                      {item.icon && (
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 16,
                            height: 16,
                            color: "currentColor",
                            flexShrink: 0,
                          }}
                        >
                          {item.icon}
                        </span>
                      )}
                      {!collapsed && (
                        <span
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            flex: 1,
                          }}
                        >
                          {item.label}
                        </span>
                      )}
                      {!collapsed && item.badge !== undefined && item.badge !== null && (
                        <span
                          style={{
                            marginLeft: "auto",
                            display: "inline-flex",
                            alignItems: "center",
                            flexShrink: 0,
                          }}
                        >
                          {item.badge}
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Collapse toggle */}
      <div
        style={{
          padding: collapsed ? "8px 0" : "8px 12px",
          borderTop: "1px solid var(--chrome-border)",
          display: "flex",
          justifyContent: collapsed ? "center" : "flex-end",
        }}
      >
        <button
          onClick={toggleLeft}
          title={collapsed ? "Expand sidebar (⌘B)" : "Collapse sidebar (⌘B)"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          style={{
            width: 28,
            height: 28,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            background: "transparent",
            border: "1px solid var(--chrome-border)",
            color: "var(--chrome-text-sec)",
            borderRadius: 4,
            cursor: "pointer",
            transition: "background 0.12s, color 0.12s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--bg-highlight)";
            e.currentTarget.style.color = "var(--chrome-text)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "var(--chrome-text-sec)";
          }}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </button>
      </div>

      {/* Drag handle pinned to the right edge. Hidden while collapsed
          since there's nothing meaningful to resize between the icon
          stub and the user's last-chosen width. */}
      {!collapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuemin={LEFT_SIDEBAR_MIN_WIDTH}
          aria-valuemax={LEFT_SIDEBAR_MAX_WIDTH}
          aria-valuenow={width}
          tabIndex={0}
          data-testid="sidebar-resize-handle"
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
          onPointerCancel={onHandlePointerUp}
          onDoubleClick={resetLeftWidth}
          onKeyDown={onHandleKeyDown}
          title="Drag to resize, double-click to reset"
          style={{
            position: "absolute",
            top: 0,
            right: 0,
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
    </aside>
  );
}
