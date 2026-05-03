/**
 * SheetNavigatorRail (PLR-7)
 *
 * Left rail in `SubmissionDetailModal`'s Sheets tab. Lists every
 * sheet composed by the active submission as a clickable thumbnail
 * tile labeled with sheet number + sheet name. The data source is
 * `GET /submissions/:submissionId/sheets`, which resolves the
 * submission's *contemporaneous* snapshot server-side (newest
 * snapshot at-or-before `submittedAt`, with a legacy fallback to
 * the engagement's earliest snapshot) so the rail stays stable to
 * the sheet set actually packaged at send-off even after newer
 * snapshots land on the same engagement (SD-5).
 *
 * Includes a search box that filters by sheet number prefix
 * (case-insensitive) — typing `A-3` narrows to all sheets whose
 * sheet number starts with `A-3`.
 */
import { useMemo, useState } from "react";
import {
  useListSubmissionSheets,
  type SheetSummary,
} from "@workspace/api-client-react";

export interface SheetNavigatorRailProps {
  submissionId: string;
  selectedSheetId: string | null;
  onSelect: (sheet: SheetSummary) => void;
}

export function SheetNavigatorRail({
  submissionId,
  selectedSheetId,
  onSelect,
}: SheetNavigatorRailProps) {
  const { data, isLoading, isError } = useListSubmissionSheets(submissionId);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const list = data ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((s) => s.sheetNumber.toLowerCase().startsWith(q));
  }, [data, query]);

  return (
    <div
      data-testid="sheet-navigator-rail"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        borderRight: "1px solid var(--border-default)",
        padding: 8,
        minWidth: 180,
        maxWidth: 220,
        height: "100%",
        overflow: "hidden",
      }}
    >
      <input
        type="search"
        placeholder="Search sheet #..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        data-testid="sheet-navigator-rail-search"
        aria-label="Filter sheets by sheet number"
        style={{
          padding: "6px 8px",
          borderRadius: 6,
          border: "1px solid var(--border-default)",
          background: "var(--bg-input)",
          color: "var(--text-primary)",
          fontSize: 12,
        }}
      />
      <div
        style={{
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 6,
          paddingRight: 2,
        }}
      >
        {isLoading && (
          <div
            data-testid="sheet-navigator-rail-loading"
            style={{
              padding: 8,
              fontSize: 12,
              color: "var(--text-muted)",
            }}
          >
            Loading sheets…
          </div>
        )}
        {isError && (
          <div
            data-testid="sheet-navigator-rail-error"
            style={{
              padding: 8,
              fontSize: 12,
              color: "var(--text-muted)",
            }}
          >
            Could not load sheets.
          </div>
        )}
        {!isLoading && !isError && filtered.length === 0 && (
          <div
            data-testid="sheet-navigator-rail-empty"
            style={{
              padding: 8,
              fontSize: 12,
              color: "var(--text-muted)",
            }}
          >
            {data && data.length > 0
              ? "No sheets match that filter."
              : "No sheets ingested yet."}
          </div>
        )}
        {filtered.map((sheet) => {
          const isActive = sheet.id === selectedSheetId;
          return (
            <button
              key={sheet.id}
              type="button"
              onClick={() => onSelect(sheet)}
              data-testid={`sheet-navigator-tile-${sheet.id}`}
              data-active={isActive ? "true" : "false"}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                padding: 6,
                borderRadius: 6,
                border: isActive
                  ? "1px solid var(--cyan, #06b6d4)"
                  : "1px solid var(--border-default)",
                background: isActive
                  ? "var(--bg-active, var(--bg-input))"
                  : "var(--bg-input)",
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <div
                style={{
                  width: "100%",
                  aspectRatio: `${sheet.thumbnailWidth} / ${sheet.thumbnailHeight}`,
                  background: "var(--bg-elevated, #0b0b0b)",
                  border: "1px solid var(--border-default)",
                  borderRadius: 4,
                  overflow: "hidden",
                }}
              >
                <img
                  src={`/api/sheets/${sheet.id}/thumbnail.png`}
                  alt={`Thumbnail of ${sheet.sheetNumber}`}
                  loading="lazy"
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "contain",
                    display: "block",
                  }}
                />
              </div>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: "var(--text-primary)",
                  lineHeight: 1.2,
                }}
              >
                {sheet.sheetNumber}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-secondary)",
                  lineHeight: 1.2,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={sheet.sheetName}
              >
                {sheet.sheetName}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
