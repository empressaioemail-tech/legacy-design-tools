import { useMemo, useState } from "react";
import {
  useGetSnapshotSheets,
  getGetSnapshotSheetsQueryKey,
  type SheetSummary,
} from "@workspace/api-client-react";
import { SheetThumbnail } from "../SheetThumbnail";
import { SheetViewer } from "../SheetViewer";

interface SnapshotsSheetRailProps {
  snapshotId: string | null;
  onAskClaude: (sheet: SheetSummary) => void;
}

/**
 * Vertical sheet thumbnail strip beside the Snapshots hero BIM viewer.
 */
export function SnapshotsSheetRail({
  snapshotId,
  onAskClaude,
}: SnapshotsSheetRailProps) {
  const [filter, setFilter] = useState("");
  const [viewerSheetId, setViewerSheetId] = useState<string | null>(null);

  const enabled = !!snapshotId;
  const { data, isLoading } = useGetSnapshotSheets(snapshotId ?? "", {
    query: {
      enabled,
      queryKey: getGetSnapshotSheetsQueryKey(snapshotId ?? ""),
      refetchInterval: 5000,
    },
  });

  const sheets = data ?? [];
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return sheets;
    return sheets.filter(
      (s) =>
        s.sheetNumber.toLowerCase().startsWith(q) ||
        s.sheetName.toLowerCase().includes(q),
    );
  }, [sheets, filter]);

  const viewerSheet =
    viewerSheetId !== null
      ? (sheets.find((s) => s.id === viewerSheetId) ?? null)
      : null;

  return (
    <aside
      className="snapshots-hero-sheets-rail"
      data-testid="snapshots-sheet-rail"
      aria-label="Snapshot sheets"
    >
      <div className="snapshots-hero-sheets-rail-header">
        <span className="sc-label">Sheets</span>
        {snapshotId && sheets.length > 0 && (
          <span className="snapshots-hero-sheets-rail-count">{sheets.length}</span>
        )}
      </div>

      {snapshotId && sheets.length > 3 && (
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter sheets…"
          className="snapshots-hero-sheets-rail-search"
          data-testid="snapshots-sheet-rail-filter"
        />
      )}

      <div className="snapshots-hero-sheets-rail-list sc-scroll">
        {!snapshotId && (
          <p className="snapshots-hero-sheets-rail-empty sc-prose opacity-70">
            Select a snapshot to load sheet thumbnails.
          </p>
        )}
        {snapshotId && isLoading && (
          <p className="snapshots-hero-sheets-rail-empty sc-prose opacity-60">
            Loading sheets…
          </p>
        )}
        {snapshotId && !isLoading && sheets.length === 0 && (
          <p className="snapshots-hero-sheets-rail-empty sc-prose opacity-70">
            No sheets in this snapshot yet.
          </p>
        )}
        {snapshotId && !isLoading && filter && filtered.length === 0 && (
          <p className="snapshots-hero-sheets-rail-empty sc-prose opacity-70">
            No sheets match.
          </p>
        )}
        {filtered.map((sheet) => (
          <div key={sheet.id} className="snapshots-hero-sheets-rail-item">
            <SheetThumbnail
              sheet={sheet}
              onClick={() => setViewerSheetId(sheet.id)}
            />
          </div>
        ))}
      </div>

      <SheetViewer
        sheet={viewerSheet}
        onClose={() => setViewerSheetId(null)}
        onAskClaude={(s) => {
          setViewerSheetId(null);
          onAskClaude(s);
        }}
      />
    </aside>
  );
}
