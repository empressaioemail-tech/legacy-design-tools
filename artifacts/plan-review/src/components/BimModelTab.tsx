import { useMemo, useState } from "react";
import {
  BriefingDivergenceRow,
  BriefingDivergenceDetailDialog,
  BriefingDivergencesPanel,
  formatRelativeMaterializedAt,
} from "@workspace/portal-ui";
import {
  useGetEngagementBimModel,
  type BimModelDivergenceListEntry,
  type EngagementBimModel,
  type MaterializableElement,
  type MaterializableElementKind,
} from "@workspace/api-client-react";

/**
 * Canonical ordering + display labels for the seven Spec 51a §2.4
 * materializable element kinds. Mirrors the
 * `MATERIALIZABLE_ELEMENT_KINDS` tuple in
 * `lib/db/src/schema/materializableElements.ts` so the reviewer
 * sees the same kind grouping the architect side uses, in the
 * same order, even when the bim-model row only contains a subset.
 */
const ELEMENT_KIND_DISPLAY: Record<
  MaterializableElementKind,
  { label: string; order: number }
> = {
  terrain: { label: "Terrain", order: 0 },
  "property-line": { label: "Property line", order: 1 },
  "setback-plane": { label: "Setback planes", order: 2 },
  "buildable-envelope": { label: "Buildable envelope", order: 3 },
  floodplain: { label: "Floodplain", order: 4 },
  wetland: { label: "Wetland", order: 5 },
  "neighbor-mass": { label: "Neighbor masses", order: 6 },
};

const REFRESH_STATUS_COPY: Record<
  EngagementBimModel["refreshStatus"],
  { label: string; tone: "success" | "warning" | "muted" }
> = {
  current: { label: "Current", tone: "success" },
  stale: { label: "Stale — re-push pending", tone: "warning" },
  "not-pushed": { label: "Not pushed", tone: "muted" },
};

/**
 * Reviewer-facing list of the materializable elements the bim-model
 * is currently materialized against, grouped by kind in the
 * canonical Spec 51a §2.4 order. Read-only — there are no edit /
 * delete affordances; the architect owns element lifecycle.
 *
 * Renders a compact "(no materializable elements yet)" hint when the
 * bim-model exists but the briefing engine has not produced any
 * elements yet — easy to mistake for an empty divergences panel
 * otherwise.
 */
function MaterializableElementsList({
  elements,
}: {
  elements: MaterializableElement[];
}) {
  const grouped = useMemo(() => {
    const buckets = new Map<MaterializableElementKind, MaterializableElement[]>();
    for (const el of elements) {
      const list = buckets.get(el.elementKind) ?? [];
      list.push(el);
      buckets.set(el.elementKind, list);
    }
    return Array.from(buckets.entries()).sort(
      ([a], [b]) =>
        (ELEMENT_KIND_DISPLAY[a]?.order ?? 99) -
        (ELEMENT_KIND_DISPLAY[b]?.order ?? 99),
    );
  }, [elements]);

  return (
    <div
      data-testid="bim-model-elements-list"
      className="sc-card"
      style={{
        padding: 16,
        border: "1px solid var(--border-default)",
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div className="sc-medium" style={{ fontSize: 14 }}>
        Materializable elements
      </div>
      {elements.length === 0 ? (
        <div
          data-testid="bim-model-elements-list-empty"
          style={{ fontSize: 12, color: "var(--text-muted)" }}
        >
          The briefing has not produced any materializable elements
          yet. Once the briefing engine emits geometry, the elements
          the C# add-in is materializing will appear here grouped by
          kind.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {grouped.map(([kind, items]) => (
            <div
              key={kind}
              data-testid="bim-model-elements-group"
              data-kind={kind}
              style={{ display: "flex", flexDirection: "column", gap: 4 }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <div
                  className="sc-medium"
                  style={{ fontSize: 12, color: "var(--text-default)" }}
                >
                  {ELEMENT_KIND_DISPLAY[kind]?.label ?? kind}
                </div>
                <div
                  data-testid="bim-model-elements-group-count"
                  style={{
                    fontSize: 11,
                    color: "var(--text-muted)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {items.length} {items.length === 1 ? "element" : "elements"}
                </div>
              </div>
              <ul
                style={{
                  margin: 0,
                  padding: 0,
                  listStyle: "none",
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                }}
              >
                {items.map((el) => (
                  <li
                    key={el.id}
                    data-testid="bim-model-elements-row"
                    data-element-id={el.id}
                    data-locked={el.locked ? "true" : "false"}
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "center",
                      fontSize: 12,
                      color: "var(--text-default)",
                    }}
                  >
                    <span style={{ flex: 1 }}>
                      {el.label ?? <em style={{ color: "var(--text-muted)" }}>(unlabeled)</em>}
                    </span>
                    {el.locked && (
                      <span
                        data-testid="bim-model-elements-row-locked"
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          textTransform: "uppercase",
                          letterSpacing: 0.4,
                          padding: "1px 6px",
                          borderRadius: 3,
                          color: "var(--text-muted)",
                          background: "var(--bg-muted)",
                          border: "1px solid var(--border-default)",
                        }}
                      >
                        Locked
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BimModelSummaryCard({ bimModel }: { bimModel: EngagementBimModel }) {
  const status = REFRESH_STATUS_COPY[bimModel.refreshStatus];
  const toneColor =
    status.tone === "success"
      ? "var(--success-text)"
      : status.tone === "warning"
        ? "var(--warning-text)"
        : "var(--text-muted)";
  const toneBg =
    status.tone === "success"
      ? "var(--success-dim)"
      : status.tone === "warning"
        ? "var(--warning-dim)"
        : "var(--bg-muted)";

  return (
    <div
      data-testid="bim-model-summary-card"
      className="sc-card"
      style={{
        padding: 16,
        border: "1px solid var(--border-default)",
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div className="sc-medium" style={{ fontSize: 14 }}>
          BIM model
        </div>
        <span
          data-testid="bim-model-summary-refresh-status"
          data-status={bimModel.refreshStatus}
          style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            padding: "3px 8px",
            borderRadius: 4,
            color: toneColor,
            background: toneBg,
          }}
        >
          {status.label}
        </span>
      </div>
      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "max-content 1fr",
          columnGap: 16,
          rowGap: 6,
          margin: 0,
          fontSize: 12,
        }}
      >
        <dt style={{ color: "var(--text-muted)" }}>Last materialized</dt>
        <dd
          data-testid="bim-model-summary-materialized-at"
          style={{ margin: 0, color: "var(--text-default)" }}
        >
          {bimModel.materializedAt
            ? formatRelativeMaterializedAt(bimModel.materializedAt)
            : "Never materialized"}
        </dd>
        <dt style={{ color: "var(--text-muted)" }}>Briefing version</dt>
        <dd
          data-testid="bim-model-summary-briefing-version"
          style={{ margin: 0, color: "var(--text-default)" }}
        >
          v{bimModel.briefingVersion}
        </dd>
        <dt style={{ color: "var(--text-muted)" }}>Revit document</dt>
        <dd
          data-testid="bim-model-summary-revit-document"
          style={{
            margin: 0,
            color: bimModel.revitDocumentPath
              ? "var(--text-default)"
              : "var(--text-muted)",
            wordBreak: "break-all",
          }}
        >
          {bimModel.revitDocumentPath ?? "—"}
        </dd>
      </dl>
    </div>
  );
}

export interface BimModelTabProps {
  engagementId: string;
}

/**
 * Plan-review's read-only BIM Model tab on the submission detail
 * modal (Wave 2 Sprint B / Task #306). Surfaces the bim-model
 * + briefing-divergences feedback loop to the reviewer audience
 * without exposing any of the architect-side write affordances
 * (no Push to Revit, no Resolve button on Open rows).
 *
 * The reviewer can drill into any individual divergence to see the
 * tabular diff between the briefing-locked element state and the
 * architect's recorded edit, but cannot move a row from Open to
 * Resolved — that remains an architect-side responsibility.
 *
 * Composes three pieces from `@workspace/portal-ui`:
 *   - {@link BriefingDivergencesPanel} — the loading / error /
 *     Open vs. Resolved partition + per-element grouping.
 *   - {@link BriefingDivergenceRow} — the per-row presentation,
 *     wrapped here with a "View details" right-slot button so the
 *     reviewer can open the drill-in.
 *   - {@link BriefingDivergenceDetailDialog} — the per-divergence
 *     tabular diff drill-in.
 *
 * When the engagement has no bim-model yet (no Push has happened
 * on the architect side) the panel renders nothing; this tab
 * supplies an empty-state explanation in that case so a reviewer
 * doesn't see a blank pane.
 */
export function BimModelTab({ engagementId }: BimModelTabProps) {
  const [activeDivergence, setActiveDivergence] =
    useState<BimModelDivergenceListEntry | null>(null);
  const bimModelQuery = useGetEngagementBimModel(engagementId);
  const bimModel = bimModelQuery.data?.bimModel ?? null;

  return (
    <div
      data-testid="bim-model-tab"
      style={{ display: "flex", flexDirection: "column", gap: 16 }}
    >
      {bimModelQuery.isLoading && (
        <div
          data-testid="bim-model-tab-loading"
          className="sc-body opacity-60"
          style={{ fontSize: 13 }}
        >
          Loading BIM model…
        </div>
      )}

      {!bimModelQuery.isLoading && bimModel == null && (
        <div
          data-testid="bim-model-tab-empty"
          className="sc-card"
          style={{
            padding: 16,
            border: "1px dashed var(--border-default)",
            borderRadius: 6,
            color: "var(--text-secondary)",
            fontSize: 13,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <div className="sc-medium" style={{ fontSize: 14 }}>
            No BIM model recorded yet
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            The architect hasn't pushed this engagement's briefing to
            Revit yet. Once they do, recorded overrides will appear
            here for review.
          </div>
        </div>
      )}

      {bimModel && <BimModelSummaryCard bimModel={bimModel} />}

      {bimModel && (
        <MaterializableElementsList elements={bimModel.elements} />
      )}

      {bimModel && (
        <BriefingDivergencesPanel
          engagementId={engagementId}
          title="BIM model overrides"
          description="The C# add-in records every edit the architect makes to a locked element. Click a row to see the briefing-vs-Revit diff."
          renderRow={(row) => (
            <BriefingDivergenceRow
              key={row.id}
              row={row}
              rightSlot={
                <button
                  type="button"
                  data-testid="briefing-divergences-view-details-button"
                  data-divergence-id={row.id}
                  onClick={() => setActiveDivergence(row)}
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    padding: "3px 10px",
                    borderRadius: 4,
                    fontSize: 11,
                    fontWeight: 600,
                    background: "var(--bg-default)",
                    color: "var(--text-default)",
                    border: "1px solid var(--border-default)",
                  }}
                >
                  View details
                </button>
              }
            />
          )}
        />
      )}

      <BriefingDivergenceDetailDialog
        divergence={activeDivergence}
        onClose={() => setActiveDivergence(null)}
      />
    </div>
  );
}
