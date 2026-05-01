import type { ReactNode } from "react";
import type { BimModelDivergenceListEntry } from "@workspace/api-client-react";
import {
  type BriefingDivergenceGroupShape,
  MATERIALIZABLE_ELEMENT_KIND_LABELS,
} from "../lib/briefing-divergences";

export interface BriefingDivergenceGroupProps {
  group: BriefingDivergenceGroupShape;
  /**
   * Renders the row for a single divergence. The caller wires up the
   * presentational {@link BriefingDivergenceRow} with whatever
   * action / error slots its surface needs (architect: Resolve;
   * reviewer: View details).
   */
  renderRow: (row: BimModelDivergenceListEntry) => ReactNode;
}

/**
 * Group card rendering one materializable element header + its
 * divergence rows. Promoted from
 * `artifacts/design-tools/src/pages/EngagementDetail.tsx` to
 * portal-ui alongside {@link BriefingDivergenceRow} so the architect
 * and reviewer surfaces share a single grouping treatment.
 */
export function BriefingDivergenceGroup({
  group,
  renderRow,
}: BriefingDivergenceGroupProps) {
  const kindLabel = group.elementKind
    ? (MATERIALIZABLE_ELEMENT_KIND_LABELS[group.elementKind] ??
      group.elementKind)
    : "Element no longer in briefing";
  return (
    <div
      data-testid="briefing-divergences-group"
      data-element-id={group.elementId}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: 8,
        border: "1px solid var(--border-default)",
        borderRadius: 4,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <div className="sc-medium" style={{ fontSize: 13 }}>
          {kindLabel}
        </div>
        {group.elementLabel && (
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {group.elementLabel}
          </div>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {group.rows.map((row) => renderRow(row))}
      </div>
    </div>
  );
}
