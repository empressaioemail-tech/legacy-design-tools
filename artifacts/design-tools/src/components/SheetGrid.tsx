import { useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import {
  useGetSnapshotSheets,
  getGetSnapshotSheetsQueryKey,
  type SheetSummary,
} from "@workspace/api-client-react";
import { SheetThumbnail } from "./SheetThumbnail";
import { SheetViewer } from "./SheetViewer";
import { useEngagementsStore } from "../store/engagements";
import { isFloorPlanSheet } from "../lib/isFloorPlanSheet";

interface SheetGridProps {
  snapshotId: string | null;
  /** Engagement the sheets belong to — keys the chat-context selection. */
  engagementId: string;
  onAskClaude: (sheet: SheetSummary) => void;
  /** Navigate to floor plan viz with this sheet pre-selected (stub). */
  onVisualizeFloorPlan?: (sheet: SheetSummary) => void;
}

export function SheetGrid({
  snapshotId,
  engagementId,
  onAskClaude,
  onVisualizeFloorPlan,
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
    <div className="cockpit-sheet-grid-wrap">
      <div className="cockpit-sheet-grid-toolbar">
        <span className="sc-label">SHEETS · {sheets.length}</span>
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by number or name"
          className="cockpit-sheet-grid-search"
        />
      </div>

      {filter && filtered.length === 0 ? (
        <div className="sc-card p-6 text-center sc-prose opacity-70">
          No sheets match &ldquo;{filter}&rdquo;.
        </div>
      ) : (
        <div className="cockpit-sheet-grid">
          {filtered.map((sheet) => {
            const selected = attachedSheets.some((s) => s.id === sheet.id);
            return (
              <div key={sheet.id} className="cockpit-sheet-grid-item">
                <label
                  data-testid={`sheet-select-${sheet.id}`}
                  title={
                    selected
                      ? "Sheet is in chat context — untick to remove"
                      : "Tick to send this sheet to chat context"
                  }
                  className="cockpit-sheet-grid-check"
                  data-selected={selected ? "true" : "false"}
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
                {onVisualizeFloorPlan && isFloorPlanSheet(sheet) ? (
                  <button
                    type="button"
                    className="cockpit-sheet-grid-viz sc-btn-ghost sc-btn-sm"
                    data-testid={`sheet-visualize-floorplan-${sheet.id}`}
                    title="Visualize floor plan"
                    onClick={() => onVisualizeFloorPlan(sheet)}
                  >
                    <Sparkles size={14} aria-hidden />
                    Visualize floor plan
                  </button>
                ) : null}
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
