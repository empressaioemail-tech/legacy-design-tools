import { useMemo, type CSSProperties } from "react";
import type { BimModelDivergenceListEntry } from "@workspace/api-client-react";
import {
  BRIEFING_DIVERGENCE_REASON_LABELS,
  MATERIALIZABLE_ELEMENT_KIND_LABELS,
  formatRelativeMaterializedAt,
  formatResolvedAcknowledgement,
} from "../lib/briefing-divergences";
import { ResolvedByChip } from "./ResolvedByChip";

export interface BriefingDivergenceDetailDialogProps {
  /**
   * The divergence to detail. When `null` the dialog is closed and
   * renders nothing — the parent owns selection state.
   */
  divergence: BimModelDivergenceListEntry | null;
  onClose: () => void;
}

/**
 * Per-divergence drill-in dialog. Wave 2 Sprint B (Task #306) — used
 * by the plan-review reviewer surface to surface a tabular diff
 * between the briefing-locked element state and the architect's
 * actual edit recorded by the C# Revit add-in.
 *
 * The data source is the divergence row's `detail` JSON column. The
 * server-side recorder writes a free-shape object whose keys vary
 * per `reason`:
 *
 *   - `geometry-edited` — typically `{ before: {...}, after: {...} }`
 *     plus a `revitElementId` reference back to the Revit document.
 *   - `unpinned`        — typically `{ revitElementId: number }`.
 *   - `deleted`         — typically `{ revitElementId: number,
 *     lastSeenAt?: string }`.
 *   - `other`           — anything the C# side wants to attach.
 *
 * Rather than pin to one shape per reason, the dialog renders the
 * detail as a generic 2-column key/value table so any forward-compat
 * field the recorder grows lands on the screen automatically. When
 * the row carries a `before` / `after` pair we render a 3-column
 * "Field / Briefing locked / Architect actual" diff above the
 * generic table so the most-common geometry-edit case reads at a
 * glance — both surfaces (3-col diff + flat detail) coexist when
 * present.
 *
 * Lives in portal-ui so design-tools can adopt the same drill-in on
 * its architect surface in a future task without a copy/paste fork.
 * Implemented with plain CSS + a backdrop click-out (mirroring
 * design-tools' existing `SubmissionDetailModal` chrome) instead of
 * Radix Dialog so portal-ui doesn't grow a Radix dependency it
 * doesn't already need.
 */
export function BriefingDivergenceDetailDialog({
  divergence,
  onClose,
}: BriefingDivergenceDetailDialogProps) {
  const { rows, beforeAfter } = useMemo(
    () => extractDetailViews(divergence?.detail ?? {}),
    [divergence],
  );

  if (divergence == null) return null;

  const reasonLabel =
    BRIEFING_DIVERGENCE_REASON_LABELS[divergence.reason] ?? divergence.reason;
  const kindLabel = divergence.elementKind
    ? (MATERIALIZABLE_ELEMENT_KIND_LABELS[divergence.elementKind] ??
      divergence.elementKind)
    : "Element no longer in briefing";
  const isResolved = divergence.resolvedAt != null;

  return (
    <div
      onClick={onClose}
      data-testid="briefing-divergence-detail-dialog"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        className="sc-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="briefing-divergence-detail-title"
        style={{
          width: "100%",
          maxWidth: 640,
          maxHeight: "90vh",
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-default)",
          color: "var(--text-default)",
        }}
      >
        <div
          className="sc-card-header"
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12,
            padding: 16,
            borderBottom: "1px solid var(--border-subtle)",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span
              id="briefing-divergence-detail-title"
              style={{
                fontSize: 16,
                fontWeight: 600,
                color: "var(--text-primary)",
              }}
            >
              {kindLabel} — {reasonLabel}
            </span>
            {divergence.elementLabel && (
              <span
                className="sc-meta"
                style={{ fontSize: 12, color: "var(--text-secondary)" }}
              >
                {divergence.elementLabel}
              </span>
            )}
            <span
              className="sc-meta"
              data-testid="briefing-divergence-detail-recorded"
              title={new Date(divergence.createdAt).toISOString()}
              style={{ fontSize: 11, color: "var(--text-muted)" }}
            >
              Recorded {formatRelativeMaterializedAt(divergence.createdAt)}
            </span>
          </div>
          <button
            type="button"
            className="sc-btn-ghost"
            onClick={onClose}
            aria-label="Close divergence detail"
            data-testid="briefing-divergence-detail-close"
            style={{
              padding: "4px 10px",
              fontSize: 12,
              border: "1px solid var(--border-default)",
              borderRadius: 4,
              background: "var(--bg-default)",
              color: "var(--text-default)",
              cursor: "pointer",
            }}
          >
            Close
          </button>
        </div>

        <div
          className="p-4 flex flex-col"
          style={{ gap: 16, padding: 16 }}
        >
          {divergence.note && (
            <section
              data-testid="briefing-divergence-detail-note"
              style={{ display: "flex", flexDirection: "column", gap: 4 }}
            >
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: 0.4,
                  color: "var(--text-muted)",
                }}
              >
                Architect note
              </span>
              <div
                style={{
                  fontSize: 13,
                  color: "var(--text-secondary)",
                  whiteSpace: "pre-wrap",
                  background: "var(--bg-subtle)",
                  borderRadius: 4,
                  padding: 8,
                }}
              >
                {divergence.note}
              </div>
            </section>
          )}

          {beforeAfter.length > 0 && (
            <section
              data-testid="briefing-divergence-detail-diff"
              style={{ display: "flex", flexDirection: "column", gap: 4 }}
            >
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: 0.4,
                  color: "var(--text-muted)",
                }}
              >
                Briefing vs. Revit
              </span>
              <table
                data-testid="briefing-divergence-detail-diff-table"
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 12,
                }}
              >
                <thead>
                  <tr>
                    <th style={diffHeaderStyle}>Field</th>
                    <th style={diffHeaderStyle}>Briefing locked</th>
                    <th style={diffHeaderStyle}>Architect actual</th>
                  </tr>
                </thead>
                <tbody>
                  {beforeAfter.map((entry) => (
                    <tr
                      key={entry.field}
                      data-testid="briefing-divergence-detail-diff-row"
                      data-field={entry.field}
                    >
                      <td style={diffCellStyle}>{entry.field}</td>
                      <td
                        style={{
                          ...diffCellStyle,
                          color: "var(--text-secondary)",
                        }}
                      >
                        {entry.before}
                      </td>
                      <td
                        style={{
                          ...diffCellStyle,
                          color: "var(--warning-text)",
                          fontWeight: 600,
                        }}
                      >
                        {entry.after}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {rows.length > 0 && (
            <section
              data-testid="briefing-divergence-detail-attributes"
              style={{ display: "flex", flexDirection: "column", gap: 4 }}
            >
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: 0.4,
                  color: "var(--text-muted)",
                }}
              >
                Recorded detail
              </span>
              <table
                data-testid="briefing-divergence-detail-attributes-table"
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 12,
                }}
              >
                <tbody>
                  {rows.map((entry) => (
                    <tr
                      key={entry.field}
                      data-testid="briefing-divergence-detail-attribute-row"
                      data-field={entry.field}
                    >
                      <td
                        style={{
                          ...diffCellStyle,
                          width: "30%",
                          color: "var(--text-muted)",
                        }}
                      >
                        {entry.field}
                      </td>
                      <td style={diffCellStyle}>{entry.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {rows.length === 0 && beforeAfter.length === 0 && (
            <div
              data-testid="briefing-divergence-detail-empty"
              style={{
                fontSize: 12,
                color: "var(--text-muted)",
                fontStyle: "italic",
              }}
            >
              No structured detail was recorded for this override.
            </div>
          )}

          {isResolved && (
            <section
              data-testid="briefing-divergence-detail-acknowledgement"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                paddingTop: 8,
                borderTop: "1px dashed var(--border-subtle)",
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: 0.4,
                  color: "var(--text-muted)",
                }}
              >
                Acknowledgement
              </span>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  color: "var(--text-secondary)",
                }}
              >
                <span aria-hidden style={{ color: "var(--success-text)" }}>
                  ✓
                </span>
                <span data-testid="briefing-divergence-detail-acknowledged-text">
                  {formatResolvedAcknowledgement(divergence.resolvedByRequestor)}
                </span>
                {divergence.resolvedAt && (
                  <>
                    <span aria-hidden>·</span>
                    <span
                      title={new Date(divergence.resolvedAt).toISOString()}
                      data-testid="briefing-divergence-detail-acknowledged-time"
                    >
                      {formatRelativeMaterializedAt(divergence.resolvedAt)}
                    </span>
                  </>
                )}
                <ResolvedByChip
                  resolvedByRequestor={divergence.resolvedByRequestor}
                />
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

const diffHeaderStyle: CSSProperties = {
  textAlign: "left",
  padding: "6px 8px",
  borderBottom: "1px solid var(--border-default)",
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.3,
  color: "var(--text-muted)",
};

const diffCellStyle: CSSProperties = {
  padding: "6px 8px",
  borderBottom: "1px solid var(--border-subtle)",
  verticalAlign: "top",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

interface BeforeAfterEntry {
  field: string;
  before: string;
  after: string;
}

interface AttributeEntry {
  field: string;
  value: string;
}

/**
 * Split the divergence's `detail` payload into:
 *
 *   - `beforeAfter` — fields whose paired `before`/`after` values
 *     came from a `{ before: {...}, after: {...} }` envelope (the
 *     common geometry-edit shape).
 *   - `rows` — every other top-level key, formatted as a flat
 *     key/value table so any forward-compat field a recorder grows
 *     surfaces automatically.
 *
 * Both views coexist when both signal sources are present (e.g. a
 * `geometry-edited` row with `before` / `after` plus a top-level
 * `revitElementId` reference).
 *
 * Defensive about shape: a missing `before` or `after`, or a non-
 * object envelope, falls into the flat-attributes view rather than
 * crashing.
 */
function extractDetailViews(
  detail: Record<string, unknown>,
): { rows: AttributeEntry[]; beforeAfter: BeforeAfterEntry[] } {
  const beforeAfter: BeforeAfterEntry[] = [];
  const before = isPlainObject(detail.before) ? detail.before : null;
  const after = isPlainObject(detail.after) ? detail.after : null;
  if (before && after) {
    const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const field of fields) {
      beforeAfter.push({
        field,
        before: stringifyValue(before[field]),
        after: stringifyValue(after[field]),
      });
    }
  }
  const rows: AttributeEntry[] = [];
  for (const [key, value] of Object.entries(detail)) {
    if ((key === "before" || key === "after") && before && after) {
      // Already represented in the beforeAfter table — skip the
      // top-level envelope so we don't duplicate it as an opaque
      // JSON blob in the flat-attributes view.
      continue;
    }
    rows.push({ field: key, value: stringifyValue(value) });
  }
  return { rows, beforeAfter };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringifyValue(v: unknown): string {
  if (v === null) return "—";
  if (v === undefined) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
