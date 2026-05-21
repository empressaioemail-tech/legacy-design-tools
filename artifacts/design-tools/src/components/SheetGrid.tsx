import { useMemo, useState } from "react";
import {
  useGetSnapshotSheets,
  getGetSnapshotSheetsQueryKey,
  type SheetSummary,
} from "@workspace/api-client-react";
import { SheetThumbnail } from "./SheetThumbnail";
import { SheetViewer } from "./SheetViewer";
import { useEngagementsStore } from "../store/engagements";

interface SheetGridProps {
  snapshotId: string | null;
  /** Engagement the sheets belong to — keys the chat-context selection. */
  engagementId: string;
  onAskClaude: (sheet: SheetSummary) => void;
}

export function SheetGrid({
  snapshotId,
  engagementId,
  onAskClaude,
}: SheetGridProps) {
  const [filter, setFilter] = useState("");
  const [viewerSheetId, setViewerSheetId] = useState<string | null>(null);
  // WS-C (QA-07) — sheets ticked here are pushed into the in-app agent's
  // chat context (reuses the same `attachedSheets` path the "Ask Claude"
  // affordance uses).
  const attachedSheetsByEngagement = useEngagementsStore(
    (s) => s.attachedSheetsByEngagement,
  );
  const attachSheet = useEngagementsStore((s) => s.attachSheet);
  const detachSheet = useEngagementsStore((s) => s.detachSheet);
  const attachedSheets = attachedSheetsByEngagement[engagementId] ?? [];

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
          {filtered.map((sheet) => {
            const selected = attachedSheets.some((s) => s.id === sheet.id);
            return (
              <div key={sheet.id} style={{ position: "relative" }}>
                <label
                  data-testid={`sheet-select-${sheet.id}`}
                  title={
                    selected
                      ? "Sheet is in chat context — untick to remove"
                      : "Tick to send this sheet to chat context"
                  }
                  style={{
                    position: "absolute",
                    top: 6,
                    left: 6,
                    zIndex: 2,
                    display: "inline-flex",
                    alignItems: "center",
                    background: "var(--bg-card)",
                    border: `1px solid ${
                      selected ? "var(--cyan)" : "var(--border-default)"
                    }`,
                    borderRadius: 4,
                    padding: "3px 5px",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    aria-label={`Send sheet ${sheet.sheetNumber} to chat context`}
                    onChange={() =>
                      selected
                        ? detachSheet(engagementId, sheet.id)
                        : attachSheet(engagementId, sheet)
                    }
                  />
                </label>
                <SheetThumbnail
                  sheet={sheet}
                  onClick={() => setViewerSheetId(sheet.id)}
                />
              </div>
            );
          })}
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
