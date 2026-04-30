import { useEffect, useMemo, useState } from "react";
import { DashboardLayout } from "@workspace/portal-ui";
import {
  getGetSnapshotSheetsQueryKey,
  useGetSnapshotSheets,
  useListSnapshots,
  type SnapshotSummary,
} from "@workspace/api-client-react";
import { navGroups } from "../components/NavGroups";
import { SheetCard } from "../components/SheetCard";
import { relativeTime } from "../lib/relativeTime";

export default function Sheets() {
  const { data: snapshots, isLoading: snapshotsLoading } = useListSnapshots();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (selectedId === null && snapshots && snapshots.length > 0) {
      setSelectedId(snapshots[0].id);
    }
  }, [snapshots, selectedId]);

  return (
    <DashboardLayout
      title="Sheets"
      navGroups={navGroups}
      brandLabel="SMARTCITY OS"
      brandProductName="Plan Review"
      search={{ placeholder: "Search submittals..." }}
    >
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="text-[22px] font-bold font-['Oxygen'] text-[var(--text-primary)]">
            Snapshot sheets
          </h2>
          <div className="sc-body mt-1">
            Browse the drawing sheets ingested from each Revit snapshot.
            Hover a chip to see the exact upload time and snapshot id.
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
          <div className="sc-card lg:col-span-1">
            <div className="sc-card-header sc-row-sb">
              <span className="sc-label">SNAPSHOTS</span>
              <span className="sc-meta">
                {snapshots ? `${snapshots.length} total` : ""}
              </span>
            </div>
            <SnapshotList
              snapshots={snapshots ?? []}
              isLoading={snapshotsLoading}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </div>

          <div className="lg:col-span-2 flex flex-col gap-3">
            <SheetGridForSnapshot
              snapshotId={selectedId}
              snapshotName={
                snapshots?.find((s) => s.id === selectedId)?.projectName ?? null
              }
            />
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}

interface SnapshotListProps {
  snapshots: SnapshotSummary[];
  isLoading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function SnapshotList(props: SnapshotListProps) {
  const { snapshots, isLoading, selectedId, onSelect } = props;

  if (isLoading) {
    return (
      <div className="p-4 sc-body opacity-60" data-testid="snapshots-loading">
        Loading snapshots…
      </div>
    );
  }

  if (snapshots.length === 0) {
    return (
      <div className="p-4 sc-body opacity-80" data-testid="snapshots-empty">
        No snapshots yet. Once the Revit add-in posts a snapshot, it
        will appear here.
      </div>
    );
  }

  return (
    <div className="flex flex-col" data-testid="snapshots-list">
      {snapshots.map((s) => {
        const isActive = s.id === selectedId;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onSelect(s.id)}
            className="sc-card-row text-left"
            data-testid={`snapshot-row-${s.id}`}
            style={{
              padding: "10px 12px",
              background: isActive ? "var(--bg-active)" : "transparent",
              borderLeft: isActive
                ? "2px solid var(--cyan)"
                : "2px solid transparent",
              borderBottom: "1px solid var(--border-default)",
              cursor: "pointer",
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            <span
              className="sc-medium truncate"
              style={{
                color: isActive ? "var(--cyan-text)" : "var(--text-primary)",
                fontSize: 13,
              }}
              title={s.projectName}
            >
              {s.projectName}
            </span>
            <span
              className="sc-meta"
              style={{ color: "var(--text-secondary)", fontSize: 11 }}
            >
              {s.engagementName} · {s.sheetCount ?? 0} sheets ·{" "}
              {relativeTime(s.receivedAt)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

interface SheetGridForSnapshotProps {
  snapshotId: string | null;
  snapshotName: string | null;
}

function SheetGridForSnapshot(props: SheetGridForSnapshotProps) {
  const { snapshotId, snapshotName } = props;
  const enabled = !!snapshotId;
  const { data: sheets, isLoading } = useGetSnapshotSheets(snapshotId ?? "", {
    query: {
      enabled,
      queryKey: getGetSnapshotSheetsQueryKey(snapshotId ?? ""),
    },
  });

  const sortedSheets = useMemo(() => {
    if (!sheets) return [];
    return [...sheets].sort((a, b) => a.sortOrder - b.sortOrder);
  }, [sheets]);

  if (!snapshotId) {
    return (
      <div className="sc-card p-6 text-center">
        <div className="sc-body opacity-70">
          Select a snapshot to see its sheets.
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="sc-card p-6 text-center" data-testid="sheets-loading">
        <div className="sc-body opacity-60">Loading sheets…</div>
      </div>
    );
  }

  if (sortedSheets.length === 0) {
    return (
      <div className="sc-card p-6 text-center" data-testid="sheets-empty">
        <div className="sc-body opacity-80">
          This snapshot has no sheets yet.
        </div>
      </div>
    );
  }

  return (
    <div className="sc-card flex flex-col">
      <div className="sc-card-header sc-row-sb">
        <span className="sc-label">
          SHEETS{snapshotName ? ` · ${snapshotName.toUpperCase()}` : ""}
        </span>
        <span className="sc-meta">{sortedSheets.length} sheets</span>
      </div>
      <div
        className="grid grid-cols-1 md:grid-cols-2 gap-3 p-4"
        data-testid="sheets-grid"
      >
        {sortedSheets.map((sheet) => (
          <SheetCard key={sheet.id} sheet={sheet} />
        ))}
      </div>
    </div>
  );
}
