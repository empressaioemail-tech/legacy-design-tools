import { useCallback, useEffect, useState } from "react";
import { EngagementProvider } from "./providers/EngagementProvider";
import { SpatialProvider } from "./providers/SpatialProvider";
import { CodeProvider } from "./providers/CodeProvider";
import { SpaceBar, snapshotState, type SnapshotState } from "./components/SpaceBar";
import { TilePicker } from "./components/TilePicker";
import { GridCanvas } from "./components/GridCanvas";
import { PRESET_SPACES } from "./presets";
import { layoutIdForTileCount, parseLayoutCols, parseLayoutRows } from "./layouts";
import { getTile } from "./tiles";
import { fetchAdminFunctions } from "../lib/planReviewBff";
import type { TileStatus } from "./types";
import { useEngagement } from "./providers/EngagementProvider";

function CortexShellInner({
  initialTiles,
  initialLayoutId,
}: {
  initialTiles: string[];
  initialLayoutId: string;
}) {
  const { engagementId } = useEngagement();
  const [activeTiles, setActiveTiles] = useState(initialTiles);
  const [layoutId, setLayoutId] = useState(initialLayoutId);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [undoStack, setUndoStack] = useState<SnapshotState | null>(null);
  const [undoLabel, setUndoLabel] = useState<string | null>(null);
  const [fullscreenId, setFullscreenId] = useState<string | null>(null);
  const [overflowTileId, setOverflowTileId] = useState<string | null>(null);
  const [liveStatuses, setLiveStatuses] = useState<Record<string, TileStatus>>(
    {},
  );

  const [colFr, setColFr] = useState(() =>
    Array(parseLayoutCols(initialLayoutId)).fill(1),
  );
  const [rowFr, setRowFr] = useState(() =>
    Array(parseLayoutRows(initialLayoutId)).fill(1),
  );

  useEffect(() => {
    fetchAdminFunctions()
      .then((tiles) => {
        const map: Record<string, TileStatus> = {};
        for (const t of tiles) {
          map[t.id] = t.status as TileStatus;
        }
        setLiveStatuses(map);
      })
      .catch(() => {
        /* registry badges fall back to static tile status */
      });
  }, []);

  const applySnapshot = useCallback(
    (snap: SnapshotState, label: string | null) => {
      setUndoStack(
        snapshotState(engagementId ?? undefined, activeTiles, layoutId, "undo"),
      );
      setActiveTiles(snap.tiles);
      setLayoutId(snap.layoutId);
      setUndoLabel(label);
      setColFr(Array(parseLayoutCols(snap.layoutId)).fill(1));
      setRowFr(Array(parseLayoutRows(snap.layoutId)).fill(1));
    },
    [activeTiles, engagementId, layoutId],
  );

  function handleApplyPreset(presetId: string) {
    const preset = PRESET_SPACES.find((p) => p.id === presetId);
    if (!preset) return;
    applySnapshot(
      snapshotState(engagementId ?? undefined, preset.tiles, preset.layoutId, preset.label),
      `${preset.label} space loaded`,
    );
  }

  function handleUndo() {
    if (!undoStack) return;
    setActiveTiles(undoStack.tiles);
    setLayoutId(undoStack.layoutId);
    setUndoStack(null);
    setUndoLabel(null);
  }

  function handleToggleTile(id: string) {
    setActiveTiles((prev) => {
      const next = prev.includes(id)
        ? prev.filter((t) => t !== id)
        : [...prev, id];
      const nextLayout = layoutIdForTileCount(next.length);
      setLayoutId(nextLayout);
      setColFr(Array(parseLayoutCols(nextLayout)).fill(1));
      setRowFr(Array(parseLayoutRows(nextLayout)).fill(1));
      return next;
    });
  }

  function handleRemoveTile(id: string) {
    setActiveTiles((prev) => prev.filter((t) => t !== id));
  }

  if (fullscreenId) {
    const def = getTile(fullscreenId);
    return (
      <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
        <button
          type="button"
          onClick={() => setFullscreenId(null)}
          style={{ padding: 8, alignSelf: "flex-start" }}
        >
          ← Exit fullscreen
        </button>
        <div style={{ flex: 1, overflow: "auto" }}>{def?.el()}</div>
      </div>
    );
  }

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-base)",
      }}
    >
      <SpaceBar
        activeTiles={activeTiles}
        layoutId={layoutId}
        undoLabel={undoLabel}
        onApplyPreset={handleApplyPreset}
        onUndo={handleUndo}
        onOpenPicker={() => setPickerOpen(true)}
        onSaveSpace={() => {
          const snap = snapshotState(
            engagementId ?? undefined,
            activeTiles,
            layoutId,
            "saved",
          );
          localStorage.setItem("cortex-saved-space", JSON.stringify(snap));
        }}
      />
      <TilePicker
        open={pickerOpen}
        activeTiles={activeTiles}
        onClose={() => setPickerOpen(false)}
        onToggleTile={handleToggleTile}
        liveStatuses={liveStatuses}
      />
      <GridCanvas
        tileIds={activeTiles}
        layoutId={layoutId}
        colFr={colFr}
        rowFr={rowFr}
        onColFrChange={setColFr}
        onRowFrChange={setRowFr}
        onRemoveTile={handleRemoveTile}
        onFullscreen={setFullscreenId}
        overflowTileId={overflowTileId}
        onSelectOverflow={setOverflowTileId}
      />
    </div>
  );
}

export function CortexShell({
  initialPresetId = "plan-review",
}: {
  initialPresetId?: string;
}) {
  const preset =
    PRESET_SPACES.find((p) => p.id === initialPresetId) ?? PRESET_SPACES[0]!;

  return (
    <EngagementProvider>
      <SpatialProvider>
        <CodeProvider>
          <CortexShellInner
            initialTiles={preset.tiles}
            initialLayoutId={preset.layoutId}
          />
        </CodeProvider>
      </SpatialProvider>
    </EngagementProvider>
  );
}
