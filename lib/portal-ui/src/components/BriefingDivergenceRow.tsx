import type { ReactNode } from "react";
import type { BimModelDivergenceListEntry } from "@workspace/api-client-react";
import {
  BRIEFING_DIVERGENCE_REASON_COLORS,
  BRIEFING_DIVERGENCE_REASON_LABELS,
  briefingDivergenceRowDomId,
  formatRelativeMaterializedAt,
  formatResolvedAcknowledgement,
} from "../lib/briefing-divergences";
import { ResolvedByChip } from "./ResolvedByChip";

export interface BriefingDivergenceRowProps {
  row: BimModelDivergenceListEntry;
  /**
   * Right-aligned action slot. Architect surface passes a "Resolve"
   * button bound to `useResolveBimModelDivergence`; reviewer surface
   * passes a read-only "View details" button that opens the per-
   * divergence drill-in. Pass `null` when no action belongs in the
   * row (e.g. resolved rows on the architect side already render the
   * Resolved badge and want no second action).
   */
  rightSlot?: ReactNode;
  /**
   * Optional error toast rendered inside the row, beneath the
   * acknowledgement entry. The architect surface uses this to
   * surface a resolve-mutation failure; reviewer-side typically
   * omits it.
   */
  errorSlot?: ReactNode;
}

/**
 * Presentational divergence row. Promoted from
 * `artifacts/design-tools/src/pages/EngagementDetail.tsx` to
 * portal-ui by Wave 2 Sprint B (Task #306) so the read-only reviewer
 * surface in plan-review and the architect-facing surface in
 * design-tools share a single visual treatment for the recorded-
 * override audit trail.
 *
 * The row owns the layout (reason badge → relative timestamp →
 * action slot, then optional note + acknowledgement-entry deep link
 * + error slot). Mutation logic stays with the caller via the
 * {@link BriefingDivergenceRowProps.rightSlot} / `errorSlot` props
 * so each surface keeps its own action vocabulary (Resolve vs.
 * View details) without forcing a `mode` discriminator into the
 * presentational layer.
 *
 * All `data-testid` attributes match the previous design-tools
 * implementation so existing FE tests continue to pin behavior
 * against the same DOM contract on both surfaces.
 */
export function BriefingDivergenceRow({
  row,
  rightSlot,
  errorSlot,
}: BriefingDivergenceRowProps) {
  const reasonLabel =
    BRIEFING_DIVERGENCE_REASON_LABELS[row.reason] ?? row.reason;
  const palette =
    BRIEFING_DIVERGENCE_REASON_COLORS[row.reason] ??
    BRIEFING_DIVERGENCE_REASON_COLORS.other;
  const isResolved = row.resolvedAt != null;
  return (
    <div
      // Stable in-page id so the matching `briefing-divergence.resolved`
      // timeline entry's `<a href="#…">` anchor (Task #268) can deep-
      // link straight to the originating recorded-divergence row.
      id={briefingDivergenceRowDomId(row.id)}
      data-testid="briefing-divergences-row"
      data-divergence-id={row.id}
      data-divergence-reason={row.reason}
      data-divergence-resolved={isResolved ? "true" : "false"}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "6px 8px",
        background: "var(--bg-subtle)",
        borderRadius: 4,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span
          data-testid="briefing-divergences-reason-badge"
          style={{
            display: "inline-flex",
            alignItems: "center",
            padding: "2px 8px",
            borderRadius: 999,
            background: palette.bg,
            color: palette.fg,
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0.2,
            textTransform: "uppercase",
            lineHeight: 1.4,
          }}
        >
          {reasonLabel}
        </span>
        <span
          title={new Date(row.createdAt).toISOString()}
          style={{ fontSize: 11, color: "var(--text-muted)" }}
        >
          {formatRelativeMaterializedAt(row.createdAt)}
        </span>
        <div style={{ flex: 1 }} />
        {isResolved && (
          <>
            <span
              data-testid="briefing-divergences-resolved-badge"
              title={
                row.resolvedAt
                  ? `Resolved ${new Date(row.resolvedAt).toISOString()}`
                  : undefined
              }
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "2px 8px",
                borderRadius: 999,
                background: "var(--success-dim)",
                color: "var(--success-text)",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: 0.2,
                textTransform: "uppercase",
                lineHeight: 1.4,
              }}
            >
              Resolved
            </span>
            <span
              data-testid="briefing-divergences-resolved-attribution"
              title={
                row.resolvedAt
                  ? new Date(row.resolvedAt).toISOString()
                  : undefined
              }
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 11,
                color: "var(--text-muted)",
              }}
            >
              {row.resolvedAt
                ? `${formatRelativeMaterializedAt(row.resolvedAt)} by`
                : "by"}
              <ResolvedByChip resolvedByRequestor={row.resolvedByRequestor} />
            </span>
          </>
        )}
        {rightSlot}
      </div>
      {row.note && (
        <div
          data-testid="briefing-divergences-note"
          style={{
            fontSize: 12,
            color: "var(--text-secondary)",
            whiteSpace: "pre-wrap",
          }}
        >
          {row.note}
        </div>
      )}
      {isResolved && (
        // Acknowledgement entry mirroring the
        // `briefing-divergence.resolved` atom event (Task #213 /
        // Task #268). Rendered as a real `<a href="#…">` anchor that
        // deep-links to the parent row's `id` for hash-link
        // navigation from the timeline.
        <a
          href={`#${briefingDivergenceRowDomId(row.id)}`}
          data-testid="briefing-divergences-acknowledged-entry"
          data-divergence-id={row.id}
          aria-label={`${formatResolvedAcknowledgement(row.resolvedByRequestor)} — open divergence detail`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 11,
            color: "var(--text-muted)",
            textDecoration: "none",
            paddingTop: 2,
            borderTop: "1px dashed var(--border-subtle)",
            marginTop: 2,
          }}
        >
          <span aria-hidden style={{ color: "var(--success-text)" }}>
            ✓
          </span>
          <span data-testid="briefing-divergences-acknowledged-text">
            {formatResolvedAcknowledgement(row.resolvedByRequestor)}
          </span>
          {row.resolvedAt && (
            <>
              <span aria-hidden>·</span>
              <span
                title={new Date(row.resolvedAt).toISOString()}
                data-testid="briefing-divergences-acknowledged-time"
              >
                {formatRelativeMaterializedAt(row.resolvedAt)}
              </span>
            </>
          )}
        </a>
      )}
      {errorSlot}
    </div>
  );
}
