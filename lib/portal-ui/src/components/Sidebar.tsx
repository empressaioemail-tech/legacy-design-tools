import { useEffect, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useSidebarState } from "../lib/sidebar-state";

export interface SidebarItem {
  label: string;
  href: string;
  icon?: ReactNode;
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

  const width = collapsed ? 56 : 256;

  return (
    <aside
      style={{
        width,
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
        transition: "width 200ms ease-out",
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
                          }}
                        >
                          {item.label}
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
    </aside>
  );
}
