import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";

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

  return (
    <aside
      style={{
        width: 256,
        background: "var(--bg-chrome)",
        borderRight: "1px solid var(--chrome-border)",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        height: "100vh",
        position: "sticky",
        top: 0,
        overflowY: "auto",
      }}
      className="sc-scroll"
    >
      {/* Brand block */}
      <div
        style={{
          padding: "20px 18px 16px 18px",
          borderBottom: "1px solid var(--chrome-border)",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <HexGlyph size={22} />
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
      </div>

      {/* Groups */}
      <nav style={{ flex: 1, padding: "14px 0 24px" }}>
        {groups.map((group) => (
          <div key={group.label} style={{ marginBottom: 18 }}>
            <div
              className="sc-label"
              style={{
                color: "var(--chrome-text-sec)",
                padding: "0 18px 6px 18px",
              }}
            >
              {group.label}
            </div>
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {group.items.map((item) => {
                const active = isActive(location, item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        height: 30,
                        padding: "0 12px 0 15px",
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
                            width: 14,
                            height: 14,
                            color: "currentColor",
                          }}
                        >
                          {item.icon}
                        </span>
                      )}
                      <span>{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}
