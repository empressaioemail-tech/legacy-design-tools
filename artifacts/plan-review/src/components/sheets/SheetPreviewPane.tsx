/**
 * SheetPreviewPane — full-resolution PNG, metadata grid, and (PLR-8)
 * sheet-content text body with clickable cross-reference chips that
 * jump the navigator to the referenced sheet.
 */
import { useMemo } from "react";
import {
  useGetAtomSummary,
  type SheetSummary,
} from "@workspace/api-client-react";
import {
  renderSheetTextWithCrossRefs,
  type SheetCrossRef,
} from "./SheetReferenceLink";

export interface SheetPreviewPaneProps {
  sheet: SheetSummary | null;
  /** Sibling sheets in the same submission, used to resolve cross-refs. */
  siblingSheets: ReadonlyArray<SheetSummary>;
  /** Jump callback invoked when a resolved cross-ref chip is clicked. */
  onJumpToSheet: (sheet: SheetSummary) => void;
  /** Optional sheet-content text body (vision pipeline output). */
  contentBody?: string | null;
  /** Optional structured cross-references extracted from `contentBody`. */
  crossRefs?: ReadonlyArray<SheetCrossRef>;
}

export function SheetPreviewPane({
  sheet,
  siblingSheets,
  onJumpToSheet,
  contentBody,
  crossRefs,
}: SheetPreviewPaneProps) {
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
      <SheetContentBody
        body={contentBody ?? null}
        crossRefs={crossRefs ?? []}
        siblingSheets={siblingSheets}
        onJumpToSheet={onJumpToSheet}
      />
    </div>
  );
}

interface SheetContentBodyProps {
  body: string | null;
  crossRefs: ReadonlyArray<SheetCrossRef>;
  siblingSheets: ReadonlyArray<SheetSummary>;
  onJumpToSheet: (sheet: SheetSummary) => void;
}

function SheetContentBody({
  body,
  crossRefs,
  siblingSheets,
  onJumpToSheet,
}: SheetContentBodyProps) {
  const nodes = useMemo(
    () =>
      body
        ? renderSheetTextWithCrossRefs(
            body,
            crossRefs,
            siblingSheets,
            onJumpToSheet,
          )
        : [],
    [body, crossRefs, siblingSheets, onJumpToSheet],
  );
  if (!body) return null;
  return (
    <div
      data-testid="sheet-preview-content-body"
      style={{
        fontSize: 12,
        lineHeight: 1.5,
        color: "var(--text-primary)",
        whiteSpace: "pre-wrap",
        marginTop: 4,
      }}
    >
      {nodes}
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
