/**
 * Shared helpers, constants, and types for the bim-model briefing-
 * divergences surface. Originally lived inline in
 * `artifacts/design-tools/src/pages/EngagementDetail.tsx`; promoted
 * to portal-ui by Wave 2 Sprint B (Task #306) so the read-only
 * reviewer surface in plan-review can render the same vocabulary
 * (kind labels, reason badges, resolver attribution) without
 * copy/pasting from design-tools.
 *
 * Two surfaces consume this module today:
 *
 *   - design-tools — the architect's "Architect overrides in Revit"
 *     panel, with the Resolve mutation layered on top.
 *   - plan-review — the reviewer's BIM Model tab, read-only with a
 *     per-divergence drill-in.
 *
 * Both surfaces stay in lock-step on copy/palette/grouping by
 * routing through this single source of truth.
 */

import type { BimModelDivergenceListEntry } from "@workspace/api-client-react";
import { formatActorLabel } from "./actorLabel";

/**
 * Human-readable label for each `MaterializableElementKind`. Mirrors
 * the closed enum in the OpenAPI spec; an unknown kind degrades to
 * the raw string at the call site.
 */
export const MATERIALIZABLE_ELEMENT_KIND_LABELS: Record<string, string> = {
  terrain: "Terrain",
  "property-line": "Property line",
  "setback-plane": "Setback plane",
  "buildable-envelope": "Buildable envelope",
  floodplain: "Floodplain",
  wetland: "Wetland",
  "neighbor-mass": "Neighbor mass",
};

/**
 * Human-readable label for each `BriefingDivergenceReason`. Mirrors
 * the closed enum in the OpenAPI spec; an unknown reason degrades
 * to the raw string at the call site.
 */
export const BRIEFING_DIVERGENCE_REASON_LABELS: Record<string, string> = {
  unpinned: "Unpinned",
  "geometry-edited": "Geometry edited",
  deleted: "Deleted",
  other: "Other override",
};

/**
 * Per-reason badge palette, keyed off the SmartCity theme tokens so
 * the pill picks the right dark/light contrast. `deleted` is the
 * loudest signal (danger); the other three reasons land on the
 * warning palette so they read as "noticed, not blocking".
 */
export const BRIEFING_DIVERGENCE_REASON_COLORS: Record<
  string,
  { bg: string; fg: string }
> = {
  deleted: { bg: "var(--danger-dim)", fg: "var(--danger-text)" },
  unpinned: { bg: "var(--warning-dim)", fg: "var(--warning-text)" },
  "geometry-edited": {
    bg: "var(--warning-dim)",
    fg: "var(--warning-text)",
  },
  other: { bg: "var(--info-dim)", fg: "var(--info-text)" },
};

/**
 * Format an ISO timestamp as a short relative string suitable for the
 * compact divergence-row metadata column (e.g. "just now", "5 min
 * ago"). Mirrors the design-tools-side `formatRelativeMaterializedAt`
 * helper that originally lived inline in `EngagementDetail.tsx` so
 * the two surfaces produce identical strings.
 */
export function formatRelativeMaterializedAt(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const now = Date.now();
  const deltaSec = Math.max(0, Math.floor((now - then) / 1000));
  if (deltaSec < 45) return "just now";
  if (deltaSec < 60 * 60) return `${Math.floor(deltaSec / 60)} min ago`;
  if (deltaSec < 60 * 60 * 24)
    return `${Math.floor(deltaSec / 60 / 60)} h ago`;
  return `${Math.floor(deltaSec / 60 / 60 / 24)} d ago`;
}

/**
 * Stable in-page DOM id for a divergence row, used as the link
 * target the `briefing-divergence.resolved` timeline entry navigates
 * to (Task #268). Mirrors the recorded row's "deep-link" semantics —
 * the recorded row carries this id, and the acknowledgement entry's
 * anchor `href` resolves to it.
 */
export function briefingDivergenceRowDomId(divergenceId: string): string {
  return `briefing-divergence-${divergenceId}`;
}

/**
 * Compact 1–2 letter avatar fallback derived from the resolver's
 * display name (or raw id when the API hasn't hydrated a friendlier
 * label). Falls back to a generic `?` when no usable letters are
 * available so the avatar slot never collapses.
 */
export function resolverInitials(name: string): string {
  const parts = name
    .split(/\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const second = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
  const initials = `${first}${second}`.toUpperCase();
  return initials || "?";
}

/**
 * Pick the human-friendly label for a divergence resolver. A null
 * requestor means the resolve was recorded without a session-bound
 * caller (e.g. dev / system path) and shows up as `system`. Otherwise
 * delegates to {@link formatActorLabel} so the display-name / raw-id
 * / friendly-agent-label fallback chain stays in lock-step with the
 * rest of the actor-attribution surfaces.
 */
export function resolverLabel(
  resolvedByRequestor:
    | { kind: string; id: string; displayName?: string }
    | null,
): string {
  if (!resolvedByRequestor) return "system";
  return formatActorLabel(resolvedByRequestor);
}

/**
 * Operator-facing copy for the timeline entry that mirrors the
 * `briefing-divergence.resolved` atom event. "<operator> acknowledged
 * the override".
 */
export function formatResolvedAcknowledgement(
  resolvedByRequestor: { kind: string; id: string; displayName?: string } | null,
): string {
  const who = resolvedByRequestor
    ? formatActorLabel(resolvedByRequestor)
    : "system";
  return `${who} acknowledged the override`;
}

/**
 * Group shape returned by {@link groupDivergencesByElement}. One card
 * per parent materializable element.
 */
export interface BriefingDivergenceGroupShape {
  elementId: string;
  elementKind: string | null;
  elementLabel: string | null;
  rows: BimModelDivergenceListEntry[];
}

/**
 * Group divergences by `materializableElementId` so each element
 * renders one card with one or more rows. Within a group, rows stay
 * in the server's newest-first order (the server's primary sort is
 * `resolvedAt ASC NULLS FIRST` then `createdAt DESC`). A
 * deleted-element fallback row never blanks out a kind/label that an
 * earlier row in the same group already carried.
 */
export function groupDivergencesByElement(
  rows: ReadonlyArray<BimModelDivergenceListEntry>,
): BriefingDivergenceGroupShape[] {
  const byId = new Map<string, BriefingDivergenceGroupShape>();
  for (const row of rows) {
    const existing = byId.get(row.materializableElementId);
    if (existing) {
      existing.rows.push(row);
      if (!existing.elementKind && row.elementKind) {
        existing.elementKind = row.elementKind;
      }
      if (!existing.elementLabel && row.elementLabel) {
        existing.elementLabel = row.elementLabel;
      }
    } else {
      byId.set(row.materializableElementId, {
        elementId: row.materializableElementId,
        elementKind: row.elementKind,
        elementLabel: row.elementLabel,
        rows: [row],
      });
    }
  }
  return Array.from(byId.values());
}
