import { useMemo, useState } from "react";
import {
  useGetSnapshotSheets,
  getGetSnapshotSheetsQueryKey,
  type SheetSummary,
} from "@workspace/api-client-react";
import { SheetThumbnail } from "./SheetThumbnail";
import { SheetViewer } from "./SheetViewer";

interface SheetGridProps {
  snapshotId: string | null;
  onAskClaude: (sheet: SheetSummary) => void;
}

export function SheetGrid({ snapshotId, onAskClaude }: SheetGridProps) {
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

  if (!snapshotId) {
    return (
      <div className="sc-card p-6 text-center">
        <div className="sc-prose opacity-70">
          Select a snapshot to view its sheets.
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="sc-card p-6 text-center">
        <div className="sc-prose opacity-60">Loading sheets…</div>
      </div>
    );
  }

  if (sheets.length === 0) {
    return (
      <div className="sc-card p-6 text-center">
        <div className="sc-prose opacity-80">
          No sheets uploaded yet. Send a snapshot from Revit (with sheet export
          enabled in v0.2 of the add-in) and they&rsquo;ll appear here.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="sc-label">SHEETS · {sheets.length}</span>
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by number or name"
          className="sc-input"
          style={{
            background: "var(--bg-input)",
            border: "1px solid var(--border-default)",
            color: "var(--text-primary)",
            padding: "6px 10px",
            borderRadius: 4,
            fontSize: 12,
            width: 220,
            outline: "none",
          }}
          onFocus={(e) =>
            (e.currentTarget.style.borderColor = "var(--border-focus)")
          }
          onBlur={(e) =>
            (e.currentTarget.style.borderColor = "var(--border-default)")
          }
        />
      </div>

      {filter && filtered.length === 0 ? (
        <div className="sc-card p-6 text-center sc-prose opacity-70">
          No sheets match &ldquo;{filter}&rdquo;.
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4">
          {filtered.map((sheet) => (
            <SheetThumbnail
              key={sheet.id}
              sheet={sheet}
              onClick={() => setViewerSheetId(sheet.id)}
            />
          ))}
        </div>
      )}

      <SheetViewer
        sheet={viewerSheet}
        onClose={() => setViewerSheetId(null)}
        onAskClaude={(s) => {
          setViewerSheetId(null);
          onAskClaude(s);
        }}
      />
    </div>
  );
}
