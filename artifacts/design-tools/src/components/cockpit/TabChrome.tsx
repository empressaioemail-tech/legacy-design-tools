import type { CSSProperties, ReactNode } from "react";

/**
 * Cockpit tab chrome primitives — shared across every engagement-detail
 * tab and (lightly) across the secondary routes. Mirrors the IA we
 * established in `DesignToolsTab` so each tab gets the same
 *   overline   →  small mono kicker (group label)
 *   title      →  18px Inter 600
 *   subtitle   →  one-sentence context for the surface
 *   actions    →  right-aligned action cluster
 * treatment without re-rolling markup in every file.
 *
 * All colors resolve through the existing `smartcity-themes` tokens
 * (see `index.css`). No hex / rgba literals.
 */

export interface TabHeaderProps {
  overline?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /**
   * Optional testid for the *header* element. The tab body usually
   * carries its own root testid — this is just for header-specific
   * affordances.
   */
  testId?: string;
}

export function TabHeader({
  overline,
  title,
  subtitle,
  actions,
  testId,
}: TabHeaderProps) {
  return (
    <header className="cockpit-tab-header" data-testid={testId}>
      <div className="cockpit-tab-header-title">
        {overline ? (
          <div className="cockpit-tab-header-overline">{overline}</div>
        ) : null}
        <h1 className="cockpit-tab-header-h1">{title}</h1>
        {subtitle ? (
          <p className="cockpit-tab-header-sub">{subtitle}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="cockpit-tab-header-actions">{actions}</div>
      ) : null}
    </header>
  );
}

export interface ReservedTile {
  id: string;
  icon: ReactNode;
  title: string;
  body: string;
  /** Pill text — defaults to `Soon`. */
  pill?: string;
}

export interface ReservedRailProps {
  title?: string;
  tiles: ReservedTile[];
  testId?: string;
}

/**
 * Growth-zone rail — disabled placeholder cards that mark the layout
 * slot where a planned surface will live. Used wherever the planning
 * brief calls out reserved space (QA-27 / 28 / 29, 40d, etc.) so the
 * next wave drops in without restructuring the tab.
 */
export function ReservedRail({
  title = "Reserved",
  tiles,
  testId,
}: ReservedRailProps) {
  if (tiles.length === 0) return null;
  return (
    <section className="cockpit-reserved" data-testid={testId}>
      <div className="cockpit-reserved-header">
        <h2 className="cockpit-reserved-title">{title}</h2>
      </div>
      <div className="cockpit-reserved-grid">
        {tiles.map((tile) => (
          <article
            key={tile.id}
            className="cockpit-reserved-card"
            data-testid={`${testId ?? "cockpit-reserved"}-${tile.id}`}
            aria-disabled="true"
          >
            <span className="cockpit-reserved-icon" aria-hidden="true">
              {tile.icon}
            </span>
            <div className="cockpit-reserved-text">
              <span className="cockpit-reserved-card-title">{tile.title}</span>
              <p className="cockpit-reserved-card-body">{tile.body}</p>
            </div>
            <span className="cockpit-reserved-pill">{tile.pill ?? "Soon"}</span>
          </article>
        ))}
      </div>
    </section>
  );
}

export interface TabShellProps {
  testId?: string;
  legacyTestId?: string;
  style?: CSSProperties;
  className?: string;
  children: ReactNode;
}

/**
 * Lightweight wrapper that provides the standardized tab spacing AND
 * preserves backwards-compatible legacy testids (so existing e2e specs
 * targeting `${tabId}-tab` testids keep finding the visible subtree).
 */
export function TabShell({
  testId,
  legacyTestId,
  style,
  className,
  children,
}: TabShellProps) {
  const cls = ["cockpit-tab", className].filter(Boolean).join(" ");
  return (
    <div
      className={cls}
      data-testid={testId}
      data-legacy-testid={legacyTestId}
      style={style}
    >
      {legacyTestId && legacyTestId !== testId ? (
        <div data-testid={legacyTestId} style={{ display: "contents" }}>
          {children}
        </div>
      ) : (
        children
      )}
    </div>
  );
}
