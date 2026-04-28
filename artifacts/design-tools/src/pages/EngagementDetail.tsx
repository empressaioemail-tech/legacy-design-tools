import { useEffect, useState } from "react";
import { useParams, Link } from "wouter";
import {
  useGetEngagement,
  useGetSnapshot,
  getGetEngagementQueryKey,
  getGetSnapshotQueryKey,
} from "@workspace/api-client-react";
import { AppShell } from "../components/AppShell";
import { ClaudeChat } from "../components/ClaudeChat";
import { useEngagementsStore } from "../store/engagements";
import { relativeTime } from "../lib/relativeTime";

const STATUS_ACCENT: Record<string, { bg: string; color: string }> = {
  active: { bg: "rgba(0,180,216,0.15)", color: "var(--cyan)" },
  on_hold: { bg: "rgba(245,158,11,0.18)", color: "#f59e0b" },
  archived: { bg: "var(--bg-input)", color: "var(--text-muted)" },
};

function StatusPill({ status }: { status: string }) {
  const accent = STATUS_ACCENT[status] ?? STATUS_ACCENT.active;
  return (
    <span
      className="sc-pill"
      style={{
        background: accent.bg,
        color: accent.color,
        textTransform: "uppercase",
        fontSize: 11,
        letterSpacing: "0.05em",
        padding: "3px 8px",
        borderRadius: 4,
      }}
    >
      {status.replace("_", " ")}
    </span>
  );
}

function KpiTile({
  label,
  value,
  footnote,
}: {
  label: string;
  value: number | string | null | undefined;
  footnote?: string;
}) {
  return (
    <div className="sc-card p-4">
      <div className="sc-label">{label}</div>
      <div className="sc-kpi-md mt-2">{value ?? "—"}</div>
      {footnote && <div className="sc-meta mt-1 opacity-70">{footnote}</div>}
    </div>
  );
}

export function EngagementDetail() {
  const params = useParams();
  const id = params.id as string;
  const [jsonExpanded, setJsonExpanded] = useState(true);

  const { data: engagement } = useGetEngagement(id, {
    query: {
      enabled: !!id,
      queryKey: getGetEngagementQueryKey(id),
      refetchInterval: 5000,
    },
  });

  const selectedSnapshotIdByEngagement = useEngagementsStore(
    (s) => s.selectedSnapshotIdByEngagement,
  );
  const selectSnapshot = useEngagementsStore((s) => s.selectSnapshot);

  const explicitlySelected = selectedSnapshotIdByEngagement[id] ?? null;
  const defaultSelected = engagement?.snapshots?.[0]?.id ?? null;
  const selectedSnapshotId = explicitlySelected ?? defaultSelected;

  // Auto-pin most-recent on first load so manual selection sticks
  useEffect(() => {
    if (
      explicitlySelected === null &&
      defaultSelected &&
      !(id in selectedSnapshotIdByEngagement)
    ) {
      selectSnapshot(id, defaultSelected);
    }
  }, [
    id,
    defaultSelected,
    explicitlySelected,
    selectedSnapshotIdByEngagement,
    selectSnapshot,
  ]);

  const { data: snapshotDetail } = useGetSnapshot(selectedSnapshotId ?? "", {
    query: {
      enabled: !!selectedSnapshotId,
      queryKey: getGetSnapshotQueryKey(selectedSnapshotId ?? ""),
    },
  });

  if (!engagement) {
    return (
      <AppShell title="Loading…">
        <div className="sc-prose opacity-60">Loading engagement…</div>
      </AppShell>
    );
  }

  const snapshots = engagement.snapshots ?? [];
  const hasSnapshots = snapshots.length > 0;
  const captured = snapshotDetail
    ? `from snapshot ${relativeTime(snapshotDetail.receivedAt)}`
    : undefined;

  return (
    <AppShell
      title={engagement.name}
      rightPanel={<ClaudeChat engagementId={id} hasSnapshots={hasSnapshots} />}
    >
      <div className="flex flex-col gap-5 h-full">
        <div className="flex items-center justify-between flex-shrink-0">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-3">
              <h2 className="text-[22px] m-0">{engagement.name}</h2>
              <StatusPill status={engagement.status} />
            </div>
            <div className="sc-meta opacity-70">
              {engagement.address ?? "No address set"}
              {engagement.jurisdiction ? ` · ${engagement.jurisdiction}` : ""}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/" className="sc-btn-ghost">
              ← Projects
            </Link>
            <button
              className="sc-btn-ghost"
              disabled
              title="Coming soon"
              style={{ opacity: 0.5, cursor: "not-allowed" }}
            >
              Edit details
            </button>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-3">
          <KpiTile
            label="SHEETS"
            value={snapshotDetail?.sheetCount}
            footnote={captured}
          />
          <KpiTile
            label="ROOMS"
            value={snapshotDetail?.roomCount}
            footnote={captured}
          />
          <KpiTile
            label="LEVELS"
            value={snapshotDetail?.levelCount}
            footnote={captured}
          />
          <KpiTile
            label="WALLS"
            value={snapshotDetail?.wallCount}
            footnote={captured}
          />
        </div>

        <div className="grid lg:grid-cols-3 gap-4 flex-1 min-h-0">
          <div className="sc-card flex flex-col col-span-1 min-h-0">
            <div className="sc-card-header sc-row-sb">
              <span className="sc-label">SNAPSHOTS</span>
              <span className="sc-meta">{snapshots.length}</span>
            </div>
            <div className="flex-1 overflow-y-auto sc-scroll">
              {!hasSnapshots ? (
                <div className="p-4 sc-body text-center opacity-70">
                  No snapshots yet. Send one from Revit.
                </div>
              ) : (
                snapshots.map((s) => {
                  const isSelected = s.id === selectedSnapshotId;
                  return (
                    <div
                      key={s.id}
                      className={`sc-card-row sc-card-clickable flex flex-col ${
                        isSelected ? "sc-accent-cyan" : ""
                      }`}
                      style={{
                        background: isSelected
                          ? "var(--bg-highlight)"
                          : undefined,
                      }}
                      onClick={() => selectSnapshot(id, s.id)}
                    >
                      <div className="sc-medium">
                        {relativeTime(s.receivedAt)}
                      </div>
                      <div className="sc-meta mt-1">
                        {s.sheetCount ?? "—"}sh · {s.roomCount ?? "—"}rm ·{" "}
                        {s.levelCount ?? "—"}lv · {s.wallCount ?? "—"}w
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="col-span-2 min-h-0">
            {!hasSnapshots ? (
              <div className="sc-card p-8 h-full flex items-center justify-center">
                <div className="sc-prose text-center opacity-70">
                  No snapshots yet. Send one from Revit.
                </div>
              </div>
            ) : !snapshotDetail ? (
              <div className="sc-card p-8 h-full flex items-center justify-center">
                <div className="sc-prose opacity-60">Loading snapshot…</div>
              </div>
            ) : (
              <div className="sc-card flex flex-col h-full">
                <div className="sc-card-header sc-row-sb">
                  <span className="sc-label">RAW JSON</span>
                  <button
                    className="sc-btn-sm"
                    onClick={() => setJsonExpanded(!jsonExpanded)}
                  >
                    {jsonExpanded ? "Collapse" : "Expand"}
                  </button>
                </div>
                {jsonExpanded && (
                  <div
                    className="flex-1 overflow-hidden"
                    style={{
                      borderTop: "1px solid var(--border-default)",
                    }}
                  >
                    <pre
                      className="sc-mono-sm sc-scroll m-0"
                      style={{
                        background: "var(--bg-input)",
                        padding: 12,
                        maxHeight: 600,
                        overflow: "auto",
                        whiteSpace: "pre-wrap",
                        wordWrap: "break-word",
                      }}
                    >
                      {JSON.stringify(snapshotDetail.payload, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
