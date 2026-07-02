import { useCallback, useEffect, useState } from "react";
import { EngagementProvider } from "./providers/EngagementProvider";
import { SpatialProvider } from "./providers/SpatialProvider";
import { CodeProvider } from "./providers/CodeProvider";
import { AnnotationSelectionProvider } from "./providers/AnnotationSelectionProvider";
import { DocumentViewerNavigationProvider } from "./providers/DocumentViewerNavigationProvider";
import { SpaceBar, snapshotState, type SnapshotState } from "./components/SpaceBar";
import { TilePicker } from "./components/TilePicker";
import { GridCanvas } from "./components/GridCanvas";
import { AddressSearchBox } from "./components/AddressSearchBox";
import { layoutIdForTileCount, parseLayoutCols, parseLayoutRows } from "./layouts";
import type { PresetSpace, TileCategory, TileDef, TileStatus } from "./types";
import {
  useEngagement,
  type ActiveParcel,
} from "./providers/EngagementProvider";

/** Snapshot shape persisted by a saved space. */
export type SpaceSnapshot = {
  tileIds: string[];
  layoutId: string;
  colFr: number[];
  rowFr: number[];
};

/**
 * The saved-space persistence surface the shell drives. The app supplies a
 * concrete implementation (localStorage-backed in legacy-design-tools). Kept
 * as a prop object so the package carries no app-lib dependency.
 */
export type SavedSpacesApi = {
  savedSpaceId: (name: string) => string;
  isSavedSpaceId: (id: string) => boolean;
  savedSpaceName: (id: string) => string;
  loadSavedSpaces: () => Record<string, SpaceSnapshot>;
  saveCurrentSpace: (name: string, state: SpaceSnapshot) => void;
  listSavedSpaceEntries: () => Array<{ id: string; label: string }>;
  deleteSavedSpace: (name: string) => void;
};

/** A live-status wire entry as returned by the admin-functions endpoint. */
export type AdminFunctionStatus = { id: string; status: string };

export type CortexShellProps = {
  initialPresetId?: string;
  /** Resolve a tile definition by id. Supplied from the app tile registry. */
  getTile: (id: string) => TileDef | undefined;
  /** All tiles, used by the picker. Supplied from the app tile registry. */
  allTiles: TileDef[];
  /** Ordered category labels for the picker. */
  categories: readonly TileCategory[];
  /** Preset spaces. Supplied from the app presets module. */
  presets: PresetSpace[];
  /** Fetches live tile statuses for registry badges. */
  fetchAdminFunctions: () => Promise<AdminFunctionStatus[]>;
  /** Saved-space persistence surface. */
  savedSpaces: SavedSpacesApi;
  /**
   * Export the selected engagement's deliverable PDF. Supplied by the app
   * (which owns the BFF client + browser download). When present, the SpaceBar
   * shows an Export action while an engagement is selected. Keeps the package
   * free of any app-lib / BFF-client dependency.
   */
  onExportEngagement?: (engagementId: string) => Promise<void> | void;
  /**
   * Geocode a free-text address query into a parcel for the shared active-parcel
   * context (top-bar address-search box — setter #2). App-supplied because the
   * app owns the BFF client. When present, the SpaceBar shows the search box.
   */
  onAddressSearch?: (query: string) => Promise<ActiveParcel | null>;
  /**
   * Optional hook fired after an address-search parcel is written to the shared
   * context — e.g. resolve/create an engagement for the parcel and load detail.
   */
  onAddressResolved?: (parcel: ActiveParcel) => Promise<void> | void;
};

type CortexShellInnerProps = {
  initialPresetId: string;
  initialTiles: string[];
  initialLayoutId: string;
  getTile: (id: string) => TileDef | undefined;
  allTiles: TileDef[];
  categories: readonly TileCategory[];
  presets: PresetSpace[];
  fetchAdminFunctions: () => Promise<AdminFunctionStatus[]>;
  savedSpaces: SavedSpacesApi;
  onExportEngagement?: (engagementId: string) => Promise<void> | void;
  onAddressSearch?: (query: string) => Promise<ActiveParcel | null>;
  onAddressResolved?: (parcel: ActiveParcel) => Promise<void> | void;
};

function CortexShellInner({
  initialPresetId,
  initialTiles,
  initialLayoutId,
  getTile,
  allTiles,
  categories,
  presets,
  fetchAdminFunctions,
  savedSpaces: spacesApi,
  onExportEngagement,
  onAddressSearch,
  onAddressResolved,
}: CortexShellInnerProps) {
  const {
    isSavedSpaceId,
    listSavedSpaceEntries,
    loadSavedSpaces,
    saveCurrentSpace,
    deleteSavedSpace,
    savedSpaceId,
    savedSpaceName,
  } = spacesApi;

  const { engagementId } = useEngagement();
  const [exporting, setExporting] = useState(false);

  const handleExport = useCallback(() => {
    if (!engagementId || !onExportEngagement || exporting) return;
    setExporting(true);
    void Promise.resolve(onExportEngagement(engagementId)).finally(() =>
      setExporting(false),
    );
  }, [engagementId, onExportEngagement, exporting]);
  const [activePresetId, setActivePresetId] = useState(initialPresetId);
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
  const [savedSpaces, setSavedSpaces] = useState(() => listSavedSpaceEntries());

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
  }, [fetchAdminFunctions]);

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
    if (isSavedSpaceId(presetId)) {
      const name = savedSpaceName(presetId);
      const snap = loadSavedSpaces()[name];
      if (!snap) return;
      setActivePresetId(presetId);
      applySnapshot(
        snapshotState(engagementId ?? undefined, snap.tileIds, snap.layoutId, name),
        `${name} space loaded`,
      );
      setColFr([...snap.colFr]);
      setRowFr([...snap.rowFr]);
      return;
    }
    const preset = presets.find((p) => p.id === presetId);
    if (!preset) return;
    setActivePresetId(presetId);
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
    setActiveTiles((prev) => {
      const next = prev.filter((t) => t !== id);
      const nextLayout = layoutIdForTileCount(next.length);
      setLayoutId(nextLayout);
      setColFr(Array(parseLayoutCols(nextLayout)).fill(1));
      setRowFr(Array(parseLayoutRows(nextLayout)).fill(1));
      return next;
    });
  }

  if (fullscreenId) {
    const def = getTile(fullscreenId);
    return (
      <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
        <button
          type="button"
          onClick={() => setFullscreenId(null)}
          style={{ padding: "var(--h-space-sm)", alignSelf: "flex-start" }}
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
        background: "var(--h-surface-0)",
      }}
    >
      <SpaceBar
        presets={presets}
        activePresetId={activePresetId}
        activeTiles={activeTiles}
        layoutId={layoutId}
        undoLabel={undoLabel}
        savedSpaces={savedSpaces}
        onApplyPreset={handleApplyPreset}
        onUndo={handleUndo}
        onExport={
          onExportEngagement && engagementId ? handleExport : undefined
        }
        exporting={exporting}
        addressSearch={
          onAddressSearch ? (
            <AddressSearchBox
              onGeocode={onAddressSearch}
              onResolved={onAddressResolved}
            />
          ) : undefined
        }
        onOpenPicker={() => setPickerOpen(true)}
        onSaveSpace={() => {
          const preset =
            presets.find((p) => p.id === activePresetId) ??
            savedSpaces.find((s) => s.id === activePresetId);
          const defaultName = preset?.label ?? "My space";
          const name = window.prompt("Space name:", defaultName);
          if (!name?.trim()) return;
          saveCurrentSpace(name.trim(), {
            tileIds: [...activeTiles],
            layoutId,
            colFr: [...colFr],
            rowFr: [...rowFr],
          });
          setSavedSpaces(listSavedSpaceEntries());
          setActivePresetId(savedSpaceId(name.trim()));
        }}
        onDeleteSpace={(spaceId) => {
          if (!isSavedSpaceId(spaceId)) return;
          const name = savedSpaceName(spaceId);
          deleteSavedSpace(name);
          setSavedSpaces(listSavedSpaceEntries());
          if (activePresetId === spaceId) {
            handleApplyPreset(presets[0]!.id);
          }
        }}
      />
      <TilePicker
        open={pickerOpen}
        tiles={allTiles}
        categories={categories}
        activeTiles={activeTiles}
        onClose={() => setPickerOpen(false)}
        onToggleTile={handleToggleTile}
        liveStatuses={liveStatuses}
      />
      <GridCanvas
        tileIds={activeTiles}
        getTile={getTile}
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
  getTile,
  allTiles,
  categories,
  presets,
  fetchAdminFunctions,
  savedSpaces,
  onExportEngagement,
  onAddressSearch,
  onAddressResolved,
}: CortexShellProps) {
  const preset =
    presets.find((p) => p.id === initialPresetId) ?? presets[0]!;

  return (
    <EngagementProvider>
      <SpatialProvider>
        <CodeProvider>
          <AnnotationSelectionProvider>
            <DocumentViewerNavigationProvider>
              <CortexShellInner
                initialPresetId={preset.id}
                initialTiles={preset.tiles}
                initialLayoutId={preset.layoutId}
                getTile={getTile}
                allTiles={allTiles}
                categories={categories}
                presets={presets}
                fetchAdminFunctions={fetchAdminFunctions}
                savedSpaces={savedSpaces}
                onExportEngagement={onExportEngagement}
                onAddressSearch={onAddressSearch}
                onAddressResolved={onAddressResolved}
              />
            </DocumentViewerNavigationProvider>
          </AnnotationSelectionProvider>
        </CodeProvider>
      </SpatialProvider>
    </EngagementProvider>
  );
}
