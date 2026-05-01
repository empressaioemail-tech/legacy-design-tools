import type { CSSProperties } from "react";
import { resolverInitials, resolverLabel } from "../lib/briefing-divergences";

export interface ResolvedByChipProps {
  resolvedByRequestor:
    | { kind: string; id: string; displayName?: string; avatarUrl?: string }
    | null;
}

/**
 * Avatar + name chip rendered beside each "Resolved {time} by …" row
 * on the divergence panel (Task #269). Promoted from design-tools to
 * portal-ui by Task #306 so the read-only reviewer surface in
 * plan-review renders the same attribution treatment as the
 * architect-facing surface.
 *
 * Visual treatment matches the plan-review `ActorBadge` so the two
 * audit-trail surfaces (sheet timeline and divergence panel) read the
 * same at a glance:
 *
 *   - Hydrated user with `avatarUrl` → image avatar + display name
 *   - Hydrated user without `avatarUrl` → initials fallback + name
 *   - Un-hydrated user → initials derived from raw id + raw id
 *   - `null` requestor (system / unattributed) → neutral "·" glyph
 *     instead of an initials chip so it can't be confused with a real
 *     user named "S"
 *
 * Implemented with plain CSS rather than the Radix Avatar primitive
 * to keep portal-ui's surface area small (no extra Radix dependency
 * is required) and to dodge the happy-dom image-load gating that
 * forces `<img>`-based assertions through opaque mocking on the
 * design-tools side. The DOM shape (`data-resolver-kind`,
 * `data-resolver-avatar-url`) matches the previous design-tools
 * implementation so existing tests stay valid.
 */
export function ResolvedByChip({ resolvedByRequestor }: ResolvedByChipProps) {
  const isSystem = resolvedByRequestor == null;
  const name = resolverLabel(resolvedByRequestor);
  const avatarSize = 14;
  const sizeStyle: CSSProperties = {
    height: avatarSize,
    width: avatarSize,
    borderRadius: 999,
    background: "var(--bg-subtle, var(--bg-default, transparent))",
    color: "var(--text-secondary)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: Math.max(8, Math.round(avatarSize * 0.55)),
    lineHeight: 1,
    overflow: "hidden",
    fontWeight: 600,
  };
  return (
    <span
      data-testid="briefing-divergences-resolver-chip"
      data-resolver-kind={isSystem ? "system" : resolvedByRequestor.kind}
      data-resolver-avatar-url={
        !isSystem && resolvedByRequestor.avatarUrl
          ? resolvedByRequestor.avatarUrl
          : undefined
      }
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        minWidth: 0,
      }}
    >
      <span
        aria-hidden
        data-testid="briefing-divergences-resolver-avatar"
        style={sizeStyle}
      >
        {!isSystem && resolvedByRequestor.avatarUrl ? (
          <img
            src={resolvedByRequestor.avatarUrl}
            alt=""
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              display: "block",
            }}
          />
        ) : (
          <span data-testid="briefing-divergences-resolver-avatar-fallback">
            {/* `·` (middle dot) reads as "no specific person" without
             *  collapsing to an empty circle the way a blank string
             *  would. Real users get their initials. */}
            {isSystem ? "·" : resolverInitials(name)}
          </span>
        )}
      </span>
      <span style={{ minWidth: 0 }}>{name}</span>
    </span>
  );
}
