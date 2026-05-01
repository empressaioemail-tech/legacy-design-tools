import { useEffect, useMemo, useState } from "react";
import { DashboardLayout } from "@workspace/portal-ui";
import {
  getGetSnapshotSheetHistoryQueryKey,
  getGetSnapshotSheetsQueryKey,
  useGetSnapshotSheetHistory,
  useGetSnapshotSheets,
  useListSnapshots,
  type AtomHistoryEvent,
  type SnapshotSummary,
} from "@workspace/api-client-react";
import { useNavGroups } from "../components/NavGroups";
import { SheetCard, TIMELINE_HISTORY_LIMIT } from "../components/SheetCard";
import { relativeTime } from "../lib/relativeTime";

export default function Sheets() {
  const navGroups = useNavGroups();
  const { data: snapshots, isLoading: snapshotsLoading } = useListSnapshots();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Top-bar search filters the sheet grid for the currently selected
  // snapshot by sheet number, sheet name, or revision (Task #111).
  // The query is held at the page so the layout's `Header` and the
  // `SheetGridForSnapshot` child both see the same value, mirroring
  // the wiring in EngagementsList (Task #95).
  const [searchQuery, setSearchQuery] = useState("");

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
      search={{
        placeholder: "Search sheets...",
        value: searchQuery,
        onChange: setSearchQuery,
      }}
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
              searchQuery={searchQuery}
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
  searchQuery: string;
}

function SheetGridForSnapshot(props: SheetGridForSnapshotProps) {
  const { snapshotId, snapshotName, searchQuery } = props;
  const enabled = !!snapshotId;
  const { data: sheets, isLoading } = useGetSnapshotSheets(snapshotId ?? "", {
    query: {
      enabled,
      queryKey: getGetSnapshotSheetsQueryKey(snapshotId ?? ""),
    },
  });

  // Single batch request for the inline mini-timeline data across every
  // sheet card in this snapshot. Replaces the previous per-card
  // `useGetAtomHistory` fan-out (one request per sheet → O(N) calls).
  // The batch endpoint returns one entry per sheet so cards can render
  // a stable shape without an extra lookup.
  const historyParams = { limit: TIMELINE_HISTORY_LIMIT };
  const { data: batchHistory } = useGetSnapshotSheetHistory(
    snapshotId ?? "",
    historyParams,
    {
      query: {
        enabled,
        queryKey: getGetSnapshotSheetHistoryQueryKey(
          snapshotId ?? "",
          historyParams,
        ),
        staleTime: 30_000,
      },
    },
  );
  const eventsBySheetId = useMemo(() => {
    const map = new Map<string, AtomHistoryEvent[]>();
    if (!batchHistory) return map;
    for (const entry of batchHistory.histories) {
      map.set(entry.sheetId, entry.events);
    }
    return map;
  }, [batchHistory]);

  const sortedSheets = useMemo(() => {
    if (!sheets) return [];
    return [...sheets].sort((a, b) => a.sortOrder - b.sortOrder);
  }, [sheets]);

  const trimmedQuery = searchQuery.trim().toLowerCase();
  const filteredSheets = useMemo(() => {
    if (!trimmedQuery) return sortedSheets;
    return sortedSheets.filter((sheet) => {
      const haystack = [
        sheet.sheetNumber,
        sheet.sheetName,
        sheet.revisionNumber,
      ]
        .filter((v): v is string => !!v)
        .join(" ")
        .toLowerCase();
      return haystack.includes(trimmedQuery);
    });
  }, [sortedSheets, trimmedQuery]);

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
        <span className="sc-meta">
          {trimmedQuery
            ? `${filteredSheets.length} of ${sortedSheets.length} sheets`
            : `${sortedSheets.length} sheets`}
        </span>
      </div>
      {filteredSheets.length === 0 ? (
        <div
          className="p-6 text-center sc-body"
          data-testid="sheets-no-matches"
        >
          No sheets match “{searchQuery.trim()}”. Try a different sheet
          number, name, or revision.
        </div>
      ) : (
        <div
          className="grid grid-cols-1 md:grid-cols-2 gap-3 p-4"
          data-testid="sheets-grid"
        >
          {filteredSheets.map((sheet) => (
            <SheetCard
              key={sheet.id}
              sheet={sheet}
              historyEvents={eventsBySheetId.get(sheet.id) ?? null}
            />
          ))}
        </div>
      )}
    </div>
  );
}
