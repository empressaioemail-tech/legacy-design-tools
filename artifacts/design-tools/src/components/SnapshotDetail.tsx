import { useState, useEffect } from "react";
import { useGetSnapshot, getGetSnapshotQueryKey } from "@workspace/api-client-react";
import { useSnapshotsStore } from "../store/snapshots";

export function SnapshotDetail() {
  const { selectedId, setDetail } = useSnapshotsStore();
  const { data: snapshot } = useGetSnapshot(selectedId || "", { 
    query: { 
      enabled: !!selectedId, 
      queryKey: getGetSnapshotQueryKey(selectedId || "") 
    } 
  });
  const [jsonExpanded, setJsonExpanded] = useState(false);

  useEffect(() => {
    if (snapshot && selectedId) {
      setDetail(selectedId, snapshot);
    }
  }, [snapshot, selectedId, setDetail]);

  if (!selectedId) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="sc-prose text-center opacity-60">
          Select a snapshot or send one from Revit.
        </div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="sc-prose text-center opacity-60">Loading...</div>
      </div>
    );
  }

  const p = snapshot.payload as any;
  const sheets = Array.isArray(p?.sheets) ? p.sheets.length : "—";
  const rooms = Array.isArray(p?.rooms) ? p.rooms.length : "—";
  const levels = Array.isArray(p?.levels) ? p.levels.length : "—";
  const walls = Array.isArray(p?.walls) ? p.walls.length : "—";

  return (
    <div className="flex-1 flex flex-col overflow-y-auto sc-scroll px-1">
      <div className="flex items-center justify-between h-[60px] flex-shrink-0">
        <h2 className="text-[22px] m-0">{snapshot.projectName}</h2>
        <div className="sc-mono-sm opacity-70">
          {new Date(snapshot.receivedAt).toLocaleString()}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3 mb-6">
        <div className="sc-card p-4">
          <div className="sc-label">Sheets</div>
          <div className="sc-kpi-md mt-2">{sheets}</div>
        </div>
        <div className="sc-card p-4">
          <div className="sc-label">Rooms</div>
          <div className="sc-kpi-md mt-2">{rooms}</div>
        </div>
        <div className="sc-card p-4">
          <div className="sc-label">Levels</div>
          <div className="sc-kpi-md mt-2">{levels}</div>
        </div>
        <div className="sc-card p-4">
          <div className="sc-label">Walls</div>
          <div className="sc-kpi-md mt-2">{walls}</div>
        </div>
      </div>

      <div className="sc-card">
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
          <div className="p-0 border-t" style={{ borderColor: 'var(--border-default)' }}>
            <pre className="sc-mono-sm sc-scroll m-0" style={{ 
              background: 'var(--bg-input)', 
              padding: 12, 
              maxHeight: 400, 
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordWrap: 'break-word'
            }}>
              {JSON.stringify(snapshot.payload, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
