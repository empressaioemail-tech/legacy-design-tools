import { useCallback, useRef, useState, type ReactNode } from "react";
import type { EngagementDetail, SnapshotDetail } from "@workspace/api-client-react";
import {
  Clock,
  ChevronDown,
  ChevronUp,
  Code,
  Expand,
  ExternalLink,
  Info,
  User,
} from "lucide-react";
import { relativeTime } from "../../lib/relativeTime";
import { TabHeader } from "../cockpit/TabChrome";

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
  onOpenSheets?: () => void;
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
  onOpenSheets,
}: SnapshotsTabProps) {
  const [drawerOpen, setDrawerOpen] = useState(true);
  const viewportRef = useRef<HTMLDivElement>(null);

  const selected =
    snapshots.find((s) => s.id === selectedSnapshotId) ?? snapshots[0];

  const toggleFullscreen = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void el.requestFullscreen();
    }
  }, []);

  const headerActions =
    bimElementCount > 0 ? (
      <>
        <button
          type="button"
          className="sc-btn-ghost sc-btn-sm"
          data-testid="snapshots-bim-fullscreen"
          onClick={toggleFullscreen}
          title="Full screen 3D"
        >
          <Expand size={14} aria-hidden /> Full screen 3D
        </button>
        {onOpenSheets && (selected?.sheetCount ?? 0) > 0 ? (
          <button
            type="button"
            className="sc-btn-ghost sc-btn-sm"
            data-testid="snapshots-open-sheets"
            onClick={onOpenSheets}
          >
            <ExternalLink size={14} aria-hidden />
            Sheets ({selected?.sheetCount ?? 0})
          </button>
        ) : null}
      </>
    ) : null;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <TabHeader
        overline="Model"
        title="Snapshots"
        subtitle="BIM sync history and 3D viewer — rotate, zoom, and inspect elements from Revit."
        testId="snapshots-tab-header"
        actions={headerActions}
      />
      <div className="snapshots-hero-viewport-wrap flex-1 min-h-0">
        <div ref={viewportRef} className="snapshots-hero-viewport">
          <div className="snapshots-hero-bim-layer">{bimModelPanel}</div>

          <div className="snapshots-hero-overlay-stack">
            {hasSnapshots && (
              <div
                className="snapshots-hero-drawer"
                data-open={drawerOpen ? "true" : "false"}
                data-testid="snapshot-detail-drawer"
              >
                <div className="flex items-start justify-between p-4">
                  <div className="flex flex-col gap-3 max-w-2xl">
                    <div className="flex items-center gap-3">
                      <div className="snapshots-hero-drawer-icon">
                        <Clock className="w-4 h-4" />
                      </div>
                      <div>
                        <h2 className="snapshots-hero-drawer-title">
                          Snapshot from{" "}
                          {selected ? relativeTime(selected.receivedAt) : "—"}
                        </h2>
                        <p className="snapshots-hero-drawer-sub">
                          Captured automatically during sync
                        </p>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-3 gap-5 mt-1">
                      <div>
                        <div className="snapshots-hero-field-label">Captured by</div>
                        <div className="snapshots-hero-field-value flex items-center gap-2">
                          <div
                            className="w-5 h-5 rounded-full flex items-center justify-center"
                            style={{ background: "var(--bg-highlight)" }}
                          >
                            <User className="w-3 h-3" style={{ color: "var(--text-secondary)" }} />
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
                        <div className="snapshots-hero-field-label">Snapshot ID</div>
                        <div className="snapshots-hero-field-value font-mono truncate">
                          {selected?.id ?? "—"}
                        </div>
                      </div>
                      <div>
                        <div className="snapshots-hero-field-label">Status</div>
                        <div className="snapshots-hero-field-value snapshots-hero-field-value--success">
                          <div
                            className="w-1.5 h-1.5 rounded-full"
                            style={{ background: "var(--success)" }}
                          />
                          Processed cleanly
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col items-end gap-2">
                    <button
                      type="button"
                      aria-label="Collapse snapshot details"
                      className="p-1.5 rounded-md transition-colors"
                      style={{ color: "var(--text-secondary)" }}
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
                  <div className="snapshots-hero-json-panel" data-testid="raw-json-card">
                    {snapshotDetail ? (
                      <pre className="sc-mono-sm snapshots-hero-json-pre">
                        {JSON.stringify(snapshotDetail.payload, null, 2)}
                      </pre>
                    ) : (
                      <div className="sc-prose opacity-60 snapshots-hero-json-pre">
                        Loading snapshot…
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            <div
              className="snapshots-hero-timeline"
              data-testid="engagement-snapshot-timeline"
            >
              <div className="snapshots-hero-timeline-clock">
                <Clock className="w-5 h-5" />
              </div>
              {!hasSnapshots && (
                <p className="snapshots-hero-timeline-empty sc-body">
                  No snapshots yet. Send one from Revit.
                </p>
              )}
              {snapshots.map((snap) => {
                const isSelected = snap.id === selectedSnapshotId;
                return (
                  <button
                    type="button"
                    key={snap.id}
                    data-testid={`snapshot-row-${snap.id}`}
                    onClick={() => {
                      onSelectSnapshot(snap.id);
                      setDrawerOpen(true);
                    }}
                    className="snapshots-hero-timeline-card"
                    data-selected={isSelected ? "true" : "false"}
                  >
                    <div className="snapshots-hero-timeline-card-title">
                      {relativeTime(snap.receivedAt)}
                    </div>
                    <div
                      className="snapshots-hero-timeline-card-meta"
                      data-testid={`snapshot-row-meta-${snap.id}`}
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
                      <div className="snapshots-hero-timeline-card-indicator" />
                    )}
                  </button>
                );
              })}

              <div className="flex-1" />

              {!drawerOpen && (
                <button
                  type="button"
                  onClick={() => setDrawerOpen(true)}
                  className="snapshots-hero-details-toggle"
                >
                  <Info className="w-3.5 h-3.5" />
                  Snapshot Details
                  <ChevronUp
                    className="w-3 h-3 ml-1"
                    style={{ color: "var(--text-muted)" }}
                  />
                </button>
              )}
            </div>
          </div>

          {!hasSnapshots && bimElementCount === 0 && (
            <div className="snapshots-hero-viewport-empty">
              <div
                className="sc-prose text-center opacity-70 px-6 py-4 rounded-md snapshots-hero-empty-center"
                data-testid={`snapshots-empty-${engagementId}`}
              >
                No snapshots yet. Send one from Revit.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
