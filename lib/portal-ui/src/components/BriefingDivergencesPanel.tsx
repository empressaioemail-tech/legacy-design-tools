import { useState, type ReactNode } from "react";
import {
  type BimModelDivergenceListEntry,
  getListBimModelDivergencesQueryKey,
  useGetEngagementBimModel,
  useListBimModelDivergences,
} from "@workspace/api-client-react";
import { groupDivergencesByElement } from "../lib/briefing-divergences";
import { BriefingDivergenceGroup } from "./BriefingDivergenceGroup";

export interface BriefingDivergencesPanelProps {
  engagementId: string;
  /**
   * Renders one row inside a group card. Each surface wires this up
   * with its own {@link BriefingDivergenceRow} wrapper that supplies
   * its action-slot vocabulary (architect: Resolve mutation;
   * reviewer: View details drill-in).
   */
  renderRow: (row: BimModelDivergenceListEntry) => ReactNode;
  /**
   * Optional copy override for the panel header. Defaults to the
   * architect-facing "Architect overrides in Revit"; the reviewer
   * surface in plan-review passes "BIM model overrides" to read as
   * a neutral observer rather than the editing party.
   */
  title?: string;
  /**
   * Optional copy override for the helper text under the title.
   * Defaults to the architect-facing language; reviewer surface
   * passes a read-only-friendly version.
   */
  description?: string;
}

/**
 * DA-PI-5 / Spec 51a §2.2 — the "what did the architect change
 * inside Revit" feedback panel. Promoted from
 * `artifacts/design-tools/src/pages/EngagementDetail.tsx` to
 * portal-ui by Wave 2 Sprint B (Task #306) so the read-only reviewer
 * surface in plan-review (BIM Model tab on the submission detail
 * modal) and the architect-facing surface in design-tools both go
 * through the same loading/error/empty/Open-vs-Resolved partition
 * logic.
 *
 * Reads the engagement's bim-model (to discover the bim-model id)
 * and lists its recorded divergences grouped by element. Renders
 * nothing while the bim-model query is still loading or when no
 * bim-model has ever been pushed — both surfaces want to suppress
 * an empty card on a fresh engagement.
 *
 * Each surface owns the per-row action vocabulary by passing
 * `renderRow`; this panel stays presentational/ orchestration-only
 * and never mutates.
 *
 * The cache-key contract used by the resolve mutation
 * (`getListBimModelDivergencesQueryKey`) is exported intentionally
 * so the architect-side wrapper's `onSuccess` invalidation lands on
 * the same key this panel reads from.
 */
export function BriefingDivergencesPanel({
  engagementId,
  renderRow,
  title = "Architect overrides in Revit",
  description = "The C# add-in records every edit an architect makes to a locked element. Use this list to confirm the briefing still matches what's in the model.",
}: BriefingDivergencesPanelProps) {
  const bimModelQuery = useGetEngagementBimModel(engagementId);
  const bimModelId = bimModelQuery.data?.bimModel?.id ?? null;

  const divergencesQuery = useListBimModelDivergences(bimModelId ?? "", {
    query: {
      enabled: bimModelId !== null,
      queryKey: getListBimModelDivergencesQueryKey(bimModelId ?? ""),
      staleTime: 60_000,
    },
  });

  // Resolved rows are the long tail. Start collapsed so the eye
  // lands on the Open section first; per-mount UI state, never
  // persisted across reloads.
  const [resolvedExpanded, setResolvedExpanded] = useState(false);

  // Hide the panel until the engagement has actually been pushed to
  // Revit at least once — same guard the architect's affordance uses.
  if (bimModelQuery.isLoading || bimModelId === null) {
    return null;
  }

  const divergences = divergencesQuery.data?.divergences ?? [];
  // Server already returns Open rows first (NULLS FIRST on
  // `resolvedAt`); split on the boundary marker without re-sorting.
  // Tolerate `resolvedAt: undefined` as well as `null` so test
  // fixtures and forward-compat partial wire shapes both fall into
  // the Open partition.
  const openRows = divergences.filter((row) => row.resolvedAt == null);
  const resolvedRows = divergences.filter((row) => row.resolvedAt != null);
  const openGrouped = groupDivergencesByElement(openRows);
  const resolvedGrouped = groupDivergencesByElement(resolvedRows);

  return (
    <div
      className="sc-card"
      data-testid="briefing-divergences-panel"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: 12,
        border: "1px solid var(--border-subtle)",
        borderRadius: 6,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <div className="sc-medium">{title}</div>
          <span
            data-testid="briefing-divergences-open-count"
            data-open-count={openRows.length}
            title={`${openRows.length} open override${openRows.length === 1 ? "" : "s"}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "1px 8px",
              borderRadius: 999,
              background:
                openRows.length > 0
                  ? "var(--warning-dim)"
                  : "var(--bg-subtle)",
              color:
                openRows.length > 0
                  ? "var(--warning-text)"
                  : "var(--text-muted)",
              fontSize: 11,
              fontWeight: 600,
              lineHeight: 1.6,
            }}
          >
            {openRows.length} open
          </span>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {description}
        </div>
      </div>

      {divergencesQuery.isLoading && (
        <div
          data-testid="briefing-divergences-loading"
          style={{ fontSize: 12, color: "var(--text-muted)" }}
        >
          Loading recent overrides…
        </div>
      )}

      {divergencesQuery.isError && (
        <div
          role="alert"
          data-testid="briefing-divergences-error"
          style={{
            fontSize: 12,
            color: "var(--danger-text)",
            background: "var(--danger-dim)",
            padding: 8,
            borderRadius: 4,
          }}
        >
          Couldn't load recent overrides. Try refreshing in a moment.
        </div>
      )}

      {!divergencesQuery.isLoading &&
        !divergencesQuery.isError &&
        divergences.length === 0 && (
          <div
            data-testid="briefing-divergences-empty"
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              fontStyle: "italic",
              padding: "8px 0",
            }}
          >
            No overrides recorded yet — the briefing matches what's in
            Revit.
          </div>
        )}

      {openGrouped.length > 0 && (
        <div
          data-testid="briefing-divergences-open-section"
          style={{ display: "flex", flexDirection: "column", gap: 8 }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: 0.4,
              color: "var(--text-muted)",
            }}
          >
            Open
          </div>
          <div
            data-testid="briefing-divergences-list"
            style={{ display: "flex", flexDirection: "column", gap: 12 }}
          >
            {openGrouped.map((group) => (
              <BriefingDivergenceGroup
                key={group.elementId}
                group={group}
                renderRow={renderRow}
              />
            ))}
          </div>
        </div>
      )}

      {openGrouped.length === 0 && resolvedGrouped.length > 0 && (
        <div
          data-testid="briefing-divergences-open-empty"
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            fontStyle: "italic",
          }}
        >
          No open overrides — every recorded override has been
          acknowledged.
        </div>
      )}

      {resolvedGrouped.length > 0 && (
        <div
          data-testid="briefing-divergences-resolved-section"
          style={{ display: "flex", flexDirection: "column", gap: 8 }}
        >
          <button
            type="button"
            data-testid="briefing-divergences-resolved-toggle"
            aria-expanded={resolvedExpanded}
            onClick={() => setResolvedExpanded((v) => !v)}
            style={{
              all: "unset",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: 0.4,
              color: "var(--text-muted)",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span aria-hidden style={{ display: "inline-block", width: 10 }}>
              {resolvedExpanded ? "▾" : "▸"}
            </span>
            Resolved ({resolvedRows.length})
          </button>
          {resolvedExpanded && (
            <div
              data-testid="briefing-divergences-resolved-list"
              style={{ display: "flex", flexDirection: "column", gap: 12 }}
            >
              {resolvedGrouped.map((group) => (
                <BriefingDivergenceGroup
                  key={group.elementId}
                  group={group}
                  renderRow={renderRow}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
