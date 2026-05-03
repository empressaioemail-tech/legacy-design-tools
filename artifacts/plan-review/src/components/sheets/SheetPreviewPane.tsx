/**
 * SheetPreviewPane (PLR-7)
 *
 * Right pane in the Sheets tab: shows the selected sheet's full
 * resolution PNG plus its sheet-content metadata (number, name,
 * revision, dimensions). Falls back to an empty-state hint when no
 * sheet is selected.
 */
import {
  useGetAtomSummary,
  type SheetSummary,
} from "@workspace/api-client-react";

export interface SheetPreviewPaneProps {
  sheet: SheetSummary | null;
}

export function SheetPreviewPane({ sheet }: SheetPreviewPaneProps) {
  if (!sheet) {
    return (
      <div
        data-testid="sheet-preview-pane-empty"
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-muted)",
          fontSize: 13,
          padding: 24,
        }}
      >
        Select a sheet from the rail to preview it.
      </div>
    );
  }

  return (
    <div
      data-testid={`sheet-preview-pane-${sheet.id}`}
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 12,
        overflow: "auto",
      }}
    >
      <SheetPreviewHeader sheet={sheet} />
      <div
        style={{
          background: "var(--bg-elevated, #0b0b0b)",
          border: "1px solid var(--border-default)",
          borderRadius: 6,
          padding: 8,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <img
          src={`/api/sheets/${sheet.id}/full.png`}
          alt={`Full preview of ${sheet.sheetNumber} — ${sheet.sheetName}`}
          data-testid={`sheet-preview-image-${sheet.id}`}
          style={{
            maxWidth: "100%",
            height: "auto",
            display: "block",
          }}
        />
      </div>
      <SheetMetadataPanel sheet={sheet} />
    </div>
  );
}

function SheetPreviewHeader({ sheet }: { sheet: SheetSummary }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <div
        style={{
          fontSize: 14,
          fontWeight: 700,
          color: "var(--text-primary)",
        }}
      >
        {sheet.sheetNumber}
      </div>
      <div
        style={{
          fontSize: 12,
          color: "var(--text-secondary)",
        }}
      >
        {sheet.sheetName}
      </div>
    </div>
  );
}

function SheetMetadataPanel({ sheet }: { sheet: SheetSummary }) {
  // Pull richer metadata from the sheet atom's contextSummary so the
  // pane stays consistent with the rest of the app's atom-driven
  // surfaces (SheetCard reads the same source).
  const { data: summary } = useGetAtomSummary("sheet", sheet.id);

  const rows: Array<[label: string, value: string]> = [
    ["Sheet number", sheet.sheetNumber],
    ["Sheet name", sheet.sheetName],
    [
      "Dimensions",
      `${sheet.fullWidth} × ${sheet.fullHeight} px`,
    ],
  ];
  if (sheet.viewCount != null) {
    rows.push(["Views", String(sheet.viewCount)]);
  }
  if (sheet.revisionNumber) {
    rows.push([
      "Revision",
      sheet.revisionDate
        ? `${sheet.revisionNumber} (${sheet.revisionDate})`
        : sheet.revisionNumber,
    ]);
  }
  if (summary?.historyProvenance.latestEventAt) {
    rows.push([
      "Latest event",
      new Date(summary.historyProvenance.latestEventAt).toLocaleString(),
    ]);
  }

  return (
    <dl
      data-testid={`sheet-preview-metadata-${sheet.id}`}
      style={{
        display: "grid",
        gridTemplateColumns: "max-content 1fr",
        columnGap: 12,
        rowGap: 4,
        margin: 0,
        fontSize: 12,
      }}
    >
      {rows.map(([label, value]) => (
        <div
          key={label}
          style={{ display: "contents" }}
        >
          <dt style={{ color: "var(--text-muted)" }}>{label}</dt>
          <dd style={{ margin: 0, color: "var(--text-primary)" }}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
