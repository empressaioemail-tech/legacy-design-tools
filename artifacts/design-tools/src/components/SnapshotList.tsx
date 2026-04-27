import { useEffect } from "react";
import { useListSnapshots } from "@workspace/api-client-react";
import { useSnapshotsStore } from "../store/snapshots";

export function SnapshotList() {
  const { data } = useListSnapshots({ query: { refetchInterval: 5000 } });
  const snapshots = data ?? [];
  const selectedId = useSnapshotsStore((s) => s.selectedId);
  const select = useSnapshotsStore((s) => s.select);
  const setSnapshots = useSnapshotsStore((s) => s.setSnapshots);

  useEffect(() => {
    if (data) setSnapshots(data);
  }, [data, setSnapshots]);

  return (
    <div className="sc-card flex flex-col w-60 flex-shrink-0 h-full">
      <div className="sc-card-header sc-row-sb">
        <span className="sc-label">SNAPSHOTS</span>
        <span className="sc-meta">{snapshots.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto sc-scroll">
        {snapshots.length === 0 ? (
          <div className="p-4 sc-body text-center">
            No snapshots yet. From Revit, click 'Send to Design Tools' to push your current model here.
          </div>
        ) : (
          snapshots.map((snap) => {
            const isSelected = snap.id === selectedId;
            return (
              <div
                key={snap.id}
                className={`sc-card-row sc-card-clickable flex flex-col ${isSelected ? "sc-accent-cyan" : ""}`}
                style={{ background: isSelected ? "var(--bg-highlight)" : undefined }}
                onClick={() => select(snap.id)}
              >
                <div className="sc-medium">{snap.projectName}</div>
                <div className="sc-meta mt-1">
                  {new Date(snap.receivedAt).toLocaleTimeString()}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
