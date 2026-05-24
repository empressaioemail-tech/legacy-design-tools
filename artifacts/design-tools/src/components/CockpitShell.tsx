import { useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import {
  Activity,
  BookOpen,
  Box,
  Building2,
  ChevronLeft,
  ChevronRight,
  Database,
  Inbox,
  LayoutDashboard,
  Palette,
  Search,
  Settings as SettingsIcon,
  Share2,
} from "lucide-react";
import {
  useSidebarState,
  RIGHT_SIDEBAR_MAX_WIDTH,
  RIGHT_SIDEBAR_MIN_WIDTH,
  PROJECT_RAIL_MAX_WIDTH,
  PROJECT_RAIL_MIN_WIDTH,
} from "@workspace/portal-ui";

/**
 * Wave 2 / Cockpit IA — the dense 3-pane command-center shell that
 * replaces the legacy portal-ui DashboardLayout for the design-tools
 * artifact. Approved on the canvas (variant A / dt-cockpit) as the
 * direction for the architect-facing workspace.
 *
 * Structure (left → right):
 *
 *   ┌──────┬──────────────┬──────────────────────┬───────────────┐
 *   │ Nav  │ Project list │ Header               │               │
 *   │ rail │ rail (opt.)  ├──────────────────────┤  Right panel  │
 *   │ 60px │ 280px        │ Main scroll area     │  (Claude chat,│
 *   │      │              │ children render here │   resizable)  │
 *   └──────┴──────────────┴──────────────────────┴───────────────┘
 *
 * Colour, depth, and border values come exclusively from the existing
 * `:root` token set in `@workspace/portal-ui/styles/smartcity-themes`.
 * The Cockpit mockup used hard-coded hexes (#0A0A0B etc); those are
 * deliberately translated to `var(--bg-base)`, `var(--bg-surface)`,
 * `var(--border-default)` so the team's design tokens remain the
 * single source of truth.
 *
 * The right panel honours the same persisted resize state used by the
 * legacy `DashboardLayout`, so existing keyboard / drag behaviour and
 * tests (`right-panel-resize-handle`) continue to work unmodified.
 */

const RIGHT_COLLAPSED_WIDTH = 48;
const KEYBOARD_NUDGE = 16;

export interface CockpitNavItem {
  label: string;
  href: string;
  icon: ReactNode;
  /** Optional unread / pending count rendered as a violet dot + n. */
  badge?: number;
}

export interface CockpitNavSection {
  label?: string;
  items: CockpitNavItem[];
}

export interface CockpitProject {
  id: string;
  name: string;
  jurisdiction?: string | null;
  status?: string | null;
  /** Number of snapshots, shown beside the relative-time in the row footer. */
  snapshotCount?: number | null;
  /** Pre-formatted relative timestamp ("12m ago"). */
  updatedLabel?: string | null;
}

export interface CockpitShellProps {
  title?: string;
  hidePageTitle?: boolean;
  children: ReactNode;
  rightPanel?: ReactNode;
  /** Top icons (workspace nav). */
  primaryNav: CockpitNavSection;
  /** Bottom icons above the avatar (dev / settings). */
  secondaryNav?: CockpitNavSection;
  /** Trailing element in the slim icon rail (avatar / auth chip). */
  navTrailing?: ReactNode;
  /** Project list rail config; omit to hide the rail entirely. */
  projectRail?: {
    label?: string;
    projects: CockpitProject[];
    activeProjectId?: string | null;
    emptyMessage?: string;
    /** Optional "view all" link rendered below the list. */
    viewAllHref?: string;
  };
  /** Right-aligned header actions (e.g. Ask Claude / New Snapshot). */
  headerActions?: ReactNode;
}

function statusColor(status: string | null | undefined): string {
  switch (status) {
    case "active":
      return "var(--success)";
    case "in-pilot":
      return "var(--warning)";
    case "archived":
      return "var(--text-muted)";
    default:
      return "var(--text-muted)";
  }
}

function StatusDot({ status }: { status: string | null | undefined }) {
  const color = statusColor(status);
  const isLive = status === "active" || status === "in-pilot";
  return (
    <span
      aria-hidden="true"
      style={{
        width: 8,
        height: 8,
        borderRadius: 999,
        background: color,
        boxShadow: isLive ? `0 0 6px ${color}` : "none",
        flexShrink: 0,
      }}
    />
  );
}

export function CockpitShell({
  title,
  hidePageTitle,
  children,
  rightPanel,
  primaryNav,
  secondaryNav,
  navTrailing,
  projectRail,
  headerActions,
}: CockpitShellProps) {
  const [location] = useLocation();

  // Persisted right-panel width (shared with the legacy DashboardLayout
  // store so the Claude chat width survives the redesign).
  const rightCollapsed = useSidebarState((s) => s.rightCollapsed);
  const rightWidth = useSidebarState((s) => s.rightWidth);
  const setRightWidth = useSidebarState((s) => s.setRightWidth);
  const resetRightWidth = useSidebarState((s) => s.resetRightWidth);
  const renderedWidth = rightCollapsed ? RIGHT_COLLAPSED_WIDTH : rightWidth;

  const projectRailCollapsed = useSidebarState((s) => s.projectRailCollapsed);
  const projectRailWidth = useSidebarState((s) => s.projectRailWidth);
  const toggleProjectRail = useSidebarState((s) => s.toggleProjectRail);
  const setProjectRailWidth = useSidebarState((s) => s.setProjectRailWidth);
  const resetProjectRailWidth = useSidebarState((s) => s.resetProjectRailWidth);

  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const projDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [projDragging, setProjDragging] = useState(false);

  const onProjPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (projectRailCollapsed) return;
    e.preventDefault();
    projDragRef.current = { startX: e.clientX, startWidth: projectRailWidth };
    setProjDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onProjPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = projDragRef.current;
    if (!start) return;
    setProjectRailWidth(start.startWidth + (e.clientX - start.startX));
  };
  const onProjPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!projDragRef.current) return;
    projDragRef.current = null;
    setProjDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch { /* pointer may already be released */ }
  };
  const onProjKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (projectRailCollapsed) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      setProjectRailWidth(projectRailWidth + KEYBOARD_NUDGE);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      setProjectRailWidth(projectRailWidth - KEYBOARD_NUDGE);
    } else if (e.key === "Home") {
      e.preventDefault();
      setProjectRailWidth(PROJECT_RAIL_MIN_WIDTH);
    } else if (e.key === "End") {
      e.preventDefault();
      setProjectRailWidth(PROJECT_RAIL_MAX_WIDTH);
    }
  };

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
    setRightWidth(start.startWidth - (e.clientX - start.startX));
  };
  const onHandlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer may already be released */
    }
  };
  const onHandleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (rightCollapsed) return;
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

  const isActive = (href: string) => {
    if (href === "/") return location === "/";
    return location === href || location.startsWith(href + "/");
  };

  return (
    <div className="cockpit-shell">
      {/* UNIFIED LEFT RAIL (workspace nav + project list) ---------------- */}
      {projectRail && (
        <aside
          className="cockpit-unified-rail"
          aria-label="Workspace and projects"
          data-testid="cockpit-project-rail"
          data-collapsed={projectRailCollapsed ? "true" : "false"}
          style={{
            width: projectRailCollapsed ? 36 : projectRailWidth,
            transition: projDragging ? "none" : "width 200ms ease-out",
          }}
        >
          {projectRailCollapsed ? (
            <button
              type="button"
              onClick={toggleProjectRail}
              className="cockpit-project-rail-stub"
              aria-label="Expand projects rail"
              title="Expand projects rail"
              data-testid="cockpit-project-rail-toggle"
            >
              <ChevronRight size={14} />
            </button>
          ) : (
            <>
              <div className="cockpit-unified-rail-top">
                <Link
                  href="/"
                  className="cockpit-nav-brand cockpit-nav-brand-labeled"
                  aria-label="SmartCity OS Home"
                >
                  <span className="cockpit-nav-brand-mark" aria-hidden="true">
                    S
                  </span>
                  <span className="cockpit-nav-brand-text">SmartCity OS</span>
                </Link>
                <nav
                  className="cockpit-workspace-nav"
                  aria-label="Workspace navigation"
                >
                  {primaryNav.items.map((it) => (
                    <Link
                      key={it.href}
                      href={it.href}
                      className="cockpit-workspace-nav-item"
                      data-active={isActive(it.href) ? "true" : "false"}
                      data-testid={`workspace-nav-${it.label.toLowerCase().replace(/\s+/g, "-")}`}
                    >
                      <span className="cockpit-workspace-nav-icon">{it.icon}</span>
                      <span className="cockpit-workspace-nav-label">{it.label}</span>
                      {typeof it.badge === "number" && it.badge > 0 && (
                        <span className="cockpit-nav-badge">{it.badge}</span>
                      )}
                    </Link>
                  ))}
                </nav>
                {secondaryNav && secondaryNav.items.length > 0 && (
                  <nav
                    className="cockpit-workspace-nav cockpit-workspace-nav-secondary"
                    aria-label={secondaryNav.label ?? "Workspace tools"}
                  >
                    {secondaryNav.label && (
                      <div className="cockpit-rail-overline">{secondaryNav.label}</div>
                    )}
                    {secondaryNav.items.map((it) => (
                      <Link
                        key={it.href}
                        href={it.href}
                        className="cockpit-workspace-nav-item"
                        data-active={isActive(it.href) ? "true" : "false"}
                      >
                        <span className="cockpit-workspace-nav-icon">{it.icon}</span>
                        <span className="cockpit-workspace-nav-label">{it.label}</span>
                      </Link>
                    ))}
                  </nav>
                )}
              </div>
              <div className="cockpit-project-rail-header">
                <div className="cockpit-search-affordance">
                  <Search size={13} className="opacity-60" />
                  <span className="cockpit-search-placeholder">Search engagements…</span>
                  <span className="cockpit-kbd">⌘</span>
                  <span className="cockpit-kbd">K</span>
                </div>
                <button
                  type="button"
                  onClick={toggleProjectRail}
                  className="cockpit-rail-collapse-btn"
                  aria-label="Collapse projects rail"
                  title="Collapse projects rail"
                  data-testid="cockpit-project-rail-toggle"
                >
                  <ChevronLeft size={14} />
                </button>
              </div>
              <div className="cockpit-project-rail-list sc-scroll">
                <div className="cockpit-rail-overline">
                  {projectRail.label ?? "Active engagements"}
                </div>
                {projectRail.projects.length === 0 ? (
                  <div className="cockpit-rail-empty">
                    {projectRail.emptyMessage ?? "No engagements yet."}
                  </div>
                ) : (
              projectRail.projects.map((p) => {
                const isProjectActive = p.id === projectRail.activeProjectId;
                return (
                  <Link
                    key={p.id}
                    href={`/engagements/${p.id}`}
                    className="cockpit-project-row"
                    data-active={isProjectActive ? "true" : "false"}
                    data-testid={`cockpit-project-row-${p.id}`}
                  >
                    <div className="cockpit-project-row-top">
                      <span className="cockpit-project-name">{p.name}</span>
                      <StatusDot status={p.status} />
                    </div>
                    {p.jurisdiction && (
                      <div className="cockpit-project-meta">{p.jurisdiction}</div>
                    )}
                    <div className="cockpit-project-row-footer">
                      <span>{p.snapshotCount ?? 0} snaps</span>
                      {p.updatedLabel && <span>{p.updatedLabel}</span>}
                    </div>
                  </Link>
                );
              })
            )}
            {projectRail.viewAllHref && projectRail.projects.length > 0 && (
              <Link
                href={projectRail.viewAllHref}
                className="cockpit-rail-view-all"
              >
                View all projects →
              </Link>
            )}
          </div>
              <div className="cockpit-unified-rail-footer">
                {navTrailing}
              </div>
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize projects rail"
                aria-valuemin={PROJECT_RAIL_MIN_WIDTH}
                aria-valuemax={PROJECT_RAIL_MAX_WIDTH}
                aria-valuenow={projectRailWidth}
                tabIndex={0}
                data-testid="cockpit-project-rail-resize-handle"
                onPointerDown={onProjPointerDown}
                onPointerMove={onProjPointerMove}
                onPointerUp={onProjPointerUp}
                onPointerCancel={onProjPointerUp}
                onDoubleClick={resetProjectRailWidth}
                onKeyDown={onProjKeyDown}
                title="Drag to resize, double-click to reset"
                className="cockpit-project-rail-resize"
                style={{
                  background: projDragging ? "var(--cyan-dim)" : "transparent",
                }}
              />
            </>
          )}
        </aside>
      )}

      {/* MAIN COLUMN ----------------------------------------------- */}
      <div className="cockpit-main">
        {!hidePageTitle && (title || headerActions) && (
          <header className="cockpit-header">
            <div className="cockpit-header-title">
              {title && (
                <h1 className="cockpit-header-h1" data-testid="cockpit-page-title">
                  {title}
                </h1>
              )}
            </div>
            {headerActions && (
              <div className="cockpit-header-actions">{headerActions}</div>
            )}
          </header>
        )}
        <main className="cockpit-main-body sc-scroll">{children}</main>
      </div>

      {/* RIGHT PANEL (Claude / context) ---------------------------- */}
      {rightPanel && (
        <aside
          className="cockpit-right-panel sc-scroll"
          style={{
            width: renderedWidth,
            transition: dragging ? "none" : "width 200ms ease-out",
          }}
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
              className="cockpit-right-resize"
              style={{
                background: dragging ? "var(--cyan-dim)" : "transparent",
              }}
            />
          )}
          {rightPanel}
        </aside>
      )}
    </div>
  );
}

/**
 * Default workspace navigation for the Cockpit shell, kept here so
 * every page that uses `<AppShell>` resolves to the same icon set
 * without duplicating it in each call site.
 */
export const DEFAULT_PRIMARY_NAV: CockpitNavSection = {
  items: [
    { label: "Projects", href: "/", icon: <LayoutDashboard size={18} /> },
    { label: "Inbox", href: "/inbox", icon: <Inbox size={18} /> },
    { label: "Code Library", href: "/code-library", icon: <BookOpen size={18} /> },
    { label: "Style Probe", href: "/style-probe", icon: <Palette size={18} /> },
    { label: "Settings", href: "/settings", icon: <SettingsIcon size={18} /> },
  ],
};

export const DEFAULT_SECONDARY_NAV: CockpitNavSection = {
  label: "Workspace",
  items: [
    { label: "Product settings", href: "/workspace", icon: <Building2 size={18} /> },
    { label: "Shared with me", href: "/workspace/shared", icon: <Share2 size={18} /> },
    { label: "Atom Inspector", href: "/dev/atoms", icon: <Database size={18} /> },
    { label: "Retrieval Probe", href: "/dev/atoms/probe", icon: <Search size={18} /> },
    { label: "API Health", href: "/health", icon: <Activity size={18} /> },
  ],
};

export { Box as CockpitBrandIcon };
