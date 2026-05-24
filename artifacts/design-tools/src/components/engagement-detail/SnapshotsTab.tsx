import { useState, type ReactNode } from "react";
import { KpiTile } from "@workspace/portal-ui";
import type { EngagementDetail, SnapshotDetail } from "@workspace/api-client-react";
import { Clock, ChevronDown, ChevronUp, Code, Info, User } from "lucide-react";
import { relativeTime } from "../../lib/relativeTime";

type Snapshot = NonNullable<EngagementDetail["snapshots"]>[number];

interface SnapshotsTabProps {
  engagementId: string;
  snapshots: Snapshot[];
  hasSnapshots: boolean;
  snapshotDetail: SnapshotDetail | undefined;
  selectedSnapshotId: string | null;
  onSelectSnapshot: (snapshotId: string) => void;
  bimModelPanel: ReactNode;
  bimElementCount: number;
  jsonExpanded: boolean;
  setJsonExpanded: (next: boolean) => void;
  captured: string | undefined;
}

export function SnapshotsTab({
  engagementId,
  snapshots,
  hasSnapshots,
  snapshotDetail,
  selectedSnapshotId,
  onSelectSnapshot,
  bimModelPanel,
  bimElementCount,
  jsonExpanded,
  setJsonExpanded,
  captured,
}: SnapshotsTabProps) {
  const [drawerOpen, setDrawerOpen] = useState(true);

  const selected =
    snapshots.find((s) => s.id === selectedSnapshotId) ?? snapshots[0];

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3">
      {/* KPI strip — preserved from the original tab for at-a-glance scanning */}
      <div className="grid grid-cols-4 gap-3 shrink-0">
        <KpiTile
          label="SHEETS"
          value={snapshotDetail?.sheetCount}
          footnote={captured}
          testId="engagement-kpi-sheets"
        />
        <KpiTile
          label="ROOMS"
          value={snapshotDetail?.roomCount}
          footnote={captured}
          testId="engagement-kpi-rooms"
        />
        <KpiTile
          label="LEVELS"
          value={snapshotDetail?.levelCount}
          footnote={captured}
          testId="engagement-kpi-levels"
        />
        <KpiTile
          label="WALLS"
          value={snapshotDetail?.wallCount}
          footnote={captured}
          testId="engagement-kpi-walls"
        />
      </div>

      {/* Viewer-as-hero canvas: BIM panel fills the space; timeline + drawer overlay at the bottom */}
      <div
        className="relative flex-1 min-h-0 rounded-lg overflow-hidden"
        style={{
          border: "1px solid #1e2a3a",
          background: "#050914",
          minHeight: 520,
        }}
      >
        <div className="absolute inset-0">{bimModelPanel}</div>

        {/* Bottom overlay: collapsible detail drawer + timeline strip.
            Timeline container always renders so the
            `engagement-snapshot-timeline` testid stays stable across
            empty / populated states (matches prior contract). */}
        <div className="absolute bottom-0 left-0 right-0 z-20 flex flex-col pointer-events-none">
            {/* Collapsible snapshot-detail drawer (only when a snapshot is selectable) */}
            {hasSnapshots && (
            <div
              className={`mx-3 mb-2 transition-all duration-300 ease-in-out origin-bottom pointer-events-auto ${
                drawerOpen
                  ? "opacity-100 translate-y-0 scale-y-100"
                  : "opacity-0 translate-y-2 scale-y-0 h-0 overflow-hidden"
              }`}
              style={{
                background: "rgba(11, 18, 32, 0.85)",
                backdropFilter: "blur(16px)",
                WebkitBackdropFilter: "blur(16px)",
                border: "1px solid #1e2a3a",
                borderRadius: "12px 12px 4px 4px",
                boxShadow: "0 -10px 30px -10px rgba(0,0,0,0.5)",
              }}
              data-testid="snapshot-detail-drawer"
            >
              <div className="flex items-start justify-between p-4">
                <div className="flex flex-col gap-3 max-w-2xl">
                  <div className="flex items-center gap-3">
                    <div
                      className="flex items-center justify-center w-8 h-8 rounded-full shrink-0"
                      style={{ background: "#112a33", color: "#5fd0e0" }}
                    >
                      <Clock className="w-4 h-4" />
                    </div>
                    <div>
                      <h2 className="text-base font-medium text-white">
                        Snapshot from{" "}
                        {selected ? relativeTime(selected.receivedAt) : "—"}
                      </h2>
                      <p className="text-xs text-slate-400 mt-0.5">
                        Captured automatically during sync
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-3 gap-5 mt-1">
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-slate-500 font-medium mb-1">
                        Captured by
                      </div>
                      <div className="flex items-center gap-2 text-xs text-slate-300">
                        <div className="w-5 h-5 rounded-full bg-slate-700 flex items-center justify-center">
                          <User className="w-3 h-3 text-slate-300" />
                        </div>
                        {snapshotDetail?.payload &&
                        typeof (snapshotDetail.payload as Record<string, unknown>)
                          .capturedBy === "string"
                          ? ((snapshotDetail.payload as Record<string, unknown>)
                              .capturedBy as string)
                          : "Revit sync"}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-slate-500 font-medium mb-1">
                        Snapshot ID
                      </div>
                      <div className="text-xs font-mono text-slate-300 truncate">
                        {selected?.id ?? "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-slate-500 font-medium mb-1">
                        Status
                      </div>
                      <div className="text-xs text-emerald-400 flex items-center gap-1.5">
                        <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                        Processed cleanly
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex flex-col items-end gap-2">
                  <button
                    type="button"
                    aria-label="Collapse snapshot details"
                    className="p-1.5 text-slate-400 hover:text-white rounded-md transition-colors"
                    style={{ background: "transparent" }}
                    onClick={() => setDrawerOpen(false)}
                  >
                    <ChevronDown className="w-5 h-5" />
                  </button>
                  <button
                    type="button"
                    className="sc-btn-sm flex items-center gap-2"
                    onClick={() => setJsonExpanded(!jsonExpanded)}
                  >
                    <Code className="w-3.5 h-3.5" />
                    {jsonExpanded ? "Hide Raw JSON" : "View Raw JSON"}
                  </button>
                </div>
              </div>

              {jsonExpanded && (
                <div
                  data-testid="raw-json-card"
                  style={{
                    borderTop: "1px solid #1e2a3a",
                    background: "rgba(5, 9, 20, 0.6)",
                  }}
                >
                  {snapshotDetail ? (
                    <pre
                      className="sc-mono-sm m-0"
                      style={{
                        padding: 12,
                        maxHeight: 240,
                        overflow: "auto",
                        whiteSpace: "pre-wrap",
                        wordWrap: "break-word",
                        fontSize: 11,
                        color: "#94a3b8",
                      }}
                    >
                      {JSON.stringify(snapshotDetail.payload, null, 2)}
                    </pre>
                  ) : (
                    <div
                      className="sc-prose opacity-60"
                      style={{ padding: 12, fontSize: 11 }}
                    >
                      Loading snapshot…
                    </div>
                  )}
                </div>
              )}
            </div>
            )}

            {/* Timeline strip */}
            <div
              className="h-20 flex items-center px-3 gap-2 overflow-x-auto pointer-events-auto"
              style={{
                background: "rgba(11, 18, 32, 0.92)",
                backdropFilter: "blur(16px)",
                WebkitBackdropFilter: "blur(16px)",
                borderTop: "1px solid #1e2a3a",
                boxShadow: "0 -10px 30px -10px rgba(0,0,0,0.5)",
              }}
              data-testid="engagement-snapshot-timeline"
            >
              <div className="flex items-center mr-3" style={{ color: "#435e80" }}>
                <Clock className="w-5 h-5" />
              </div>
              {!hasSnapshots && (
                <div
                  className="sc-body opacity-70 text-sm"
                  style={{ color: "#94a3b8" }}
                >
                  No snapshots yet. Send one from Revit.
                </div>
              )}
              {snapshots.map((snap) => {
                const isSelected = snap.id === selectedSnapshotId;
                return (
                  <button
                    type="button"
                    key={snap.id}
                    data-testid={`snapshot-row-${snap.id}`}
                    data-selected={isSelected ? "true" : "false"}
                    onClick={() => {
                      onSelectSnapshot(snap.id);
                      setDrawerOpen(true);
                    }}
                    className="relative flex-shrink-0 flex flex-col justify-center h-14 min-w-[150px] px-4 rounded-md text-left transition-all"
                    style={{
                      background: isSelected ? "#112a33" : "#0f1724",
                      border: isSelected
                        ? "1px solid #5fd0e0"
                        : "1px solid #1e2a3a",
                      boxShadow: isSelected
                        ? "0 0 15px -3px rgba(95,208,224,0.3)"
                        : undefined,
                    }}
                  >
                    <div
                      className="text-xs font-semibold"
                      style={{ color: isSelected ? "#5fd0e0" : "#cbd5e1" }}
                    >
                      {relativeTime(snap.receivedAt)}
                    </div>
                    <div
                      className="text-[10px] mt-1 font-mono tracking-tight flex gap-1.5"
                      style={{ color: isSelected ? "rgba(95,208,224,0.8)" : "#64748b" }}
                    >
                      <span>{snap.sheetCount ?? "—"}sh</span>
                      <span>·</span>
                      <span>{snap.roomCount ?? "—"}rm</span>
                      <span>·</span>
                      <span>{snap.levelCount ?? "—"}lv</span>
                      <span>·</span>
                      <span>{snap.wallCount ?? "—"}w</span>
                    </div>
                    {isSelected && (
                      <div
                        className="absolute -top-[1px] left-1/2 -translate-x-1/2 w-8 h-[2px] rounded-full"
                        style={{
                          background: "#5fd0e0",
                          boxShadow: "0 0 8px rgba(95,208,224,0.8)",
                        }}
                      />
                    )}
                  </button>
                );
              })}

              <div className="flex-1" />

              {!drawerOpen && (
                <button
                  type="button"
                  onClick={() => setDrawerOpen(true)}
                  className="flex items-center gap-2 px-3 py-2 rounded-md text-xs font-medium transition-colors"
                  style={{
                    background: "#151e2e",
                    border: "1px solid #2d4362",
                    color: "#cbd5e1",
                  }}
                >
                  <Info className="w-3.5 h-3.5" />
                  Snapshot Details
                  <ChevronUp className="w-3 h-3 ml-1" style={{ color: "#64748b" }} />
                </button>
              )}
            </div>
          </div>

        {!hasSnapshots && bimElementCount === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div
              className="sc-prose text-center opacity-70 px-6 py-4 rounded-md"
              style={{
                background: "rgba(11, 18, 32, 0.7)",
                border: "1px solid #1e2a3a",
              }}
              data-testid={`snapshots-empty-${engagementId}`}
            >
              No snapshots yet. Send one from Revit.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
