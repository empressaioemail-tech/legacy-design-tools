import "./shell.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EngagementProvider } from "./providers/EngagementProvider";
import { SpatialProvider } from "./providers/SpatialProvider";
import { CodeProvider } from "./providers/CodeProvider";
import { AnnotationSelectionProvider } from "./providers/AnnotationSelectionProvider";
import { DocumentViewerNavigationProvider } from "./providers/DocumentViewerNavigationProvider";
import { SpaceBar, snapshotState, type SnapshotState } from "./components/SpaceBar";
import { TilePicker } from "./components/TilePicker";
import { GridCanvas } from "./components/GridCanvas";
import { HeaderSearchBar } from "./components/HeaderSearchBar";
import { ShellToolbar } from "./components/ShellToolbar";
import { ModuleMap } from "./components/ModuleMap";
import {
  FloatingTileLayer,
  type FloatingTile,
  type FloatRect,
} from "./components/FloatingTileLayer";
import { TileHost, createSlotRegistry } from "./components/TileHost";
import { layoutIdForTileCount, parseLayoutCols, parseLayoutRows } from "./layouts";
import type { PresetSpace, TileCategory, TileDef, TileStatus } from "./types";
import {
  useEngagement,
  type ActiveContext,
  type ActiveParcel,
} from "./providers/EngagementProvider";

/** Snapshot shape persisted by a saved space. */
export type SpaceSnapshot = {
  tileIds: string[];
  layoutId: string;
  colFr: number[];
  rowFr: number[];
  /** Layout mode of the saved space. Optional for backward compatibility. */
  layoutMode?: "grid" | "list";
  /**
   * Optional pinned active context (project/address/parcel) for this space.
   * When present, loading the space EXPOSES the pinned context to the caller
   * (via return/callback) but does NOT auto-apply it over a live context. The
   * app decides whether to prompt the user or silently adopt.
   */
  context?: ActiveContext;
};

/**
 * The saved-space persistence surface the shell drives. The app supplies a
 * concrete implementation. All list/load/save/delete are async so the app may
 * back them with a server store (BFF, tenant-keyed) with an optional
 * localStorage fast-path. Sync localStorage impls still satisfy this by
 * returning resolved values.
 */
export type SavedSpacesApi = {
  savedSpaceId: (name: string) => string;
  isSavedSpaceId: (id: string) => boolean;
  savedSpaceName: (id: string) => string;
  /** Load one space snapshot by name (null if missing). */
  loadSavedSpace: (name: string) => Promise<SpaceSnapshot | null>;
  saveCurrentSpace: (name: string, state: SpaceSnapshot) => Promise<void>;
  listSavedSpaceEntries: () => Promise<Array<{ id: string; label: string }>>;
  deleteSavedSpace: (name: string) => Promise<void>;
};

/** A live-status wire entry as returned by the admin-functions endpoint. */
export type AdminFunctionStatus = { id: string; status: string };

/**
 * A space seed applied ONCE on first mount instead of the default preset. The
 * app supplies this when it resolves a deep-link (`?share=<token>` /
 * `?space=<name>`) before render: the shell opens directly on the shared/named
 * space (tiles + layout) with its pinned parcel context adopted, rather than the
 * hardcoded initial preset. When absent, mount is unchanged (default preset).
 */
export type InitialSpaceSeed = {
  /** The persisted snapshot to open the workspace on. */
  snapshot: SpaceSnapshot;
  /** Optional label (space name) for the active-preset id / undo copy. */
  label?: string;
};

export type CortexShellProps = {
  initialPresetId?: string;
  getTile: (id: string) => TileDef | undefined;
  allTiles: TileDef[];
  categories: readonly TileCategory[];
  presets: PresetSpace[];
  fetchAdminFunctions: () => Promise<AdminFunctionStatus[]>;
  savedSpaces: SavedSpacesApi;
  /**
   * Optional deep-link seed. When present, the shell opens on this space's
   * snapshot (tiles/layout/tracks) and adopts its pinned parcel context, instead
   * of the default preset. Resolved by the app from a `?share=`/`?space=` URL
   * param before render.
   */
  initialSpaceSeed?: InitialSpaceSeed | null;
  onExportEngagement?: (engagementId: string) => Promise<void> | void;
  /** Geocode a free-text address query into a parcel (header search). */
  onAddressSearch?: (query: string) => Promise<ActiveParcel | null>;
  /** Optional debounced typeahead preview for the header search. */
  onAddressPreview?: (query: string) => Promise<ActiveParcel | null>;
  onAddressResolved?: (parcel: ActiveParcel) => Promise<void> | void;
};

type CortexShellInnerProps = Omit<
  CortexShellProps,
  "initialPresetId" | "presets" | "initialSpaceSeed"
> & {
  initialPresetId: string;
  initialTiles: string[];
  initialLayoutId: string;
  /** Optional seed tracks/mode carried by a deep-link space (over preset defaults). */
  initialColFr?: number[];
  initialRowFr?: number[];
  initialLayoutMode?: "grid" | "list";
  presets: PresetSpace[];
};

function CortexShellInner({
  initialPresetId,
  initialTiles,
  initialLayoutId,
  initialColFr,
  initialRowFr,
  initialLayoutMode,
  getTile,
  allTiles,
  categories,
  presets,
  fetchAdminFunctions,
  savedSpaces: spacesApi,
  onExportEngagement,
  onAddressSearch,
  onAddressPreview,
  onAddressResolved,
}: CortexShellInnerProps) {
  const {
    isSavedSpaceId,
    listSavedSpaceEntries,
    loadSavedSpace,
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
  const [savedSpaces, setSavedSpaces] = useState<
    Array<{ id: string; label: string }>
  >([]);

  // Phase 2/3/5 state.
  const [editing, setEditing] = useState(false);
  const [layoutMode, setLayoutMode] = useState<"grid" | "list">(
    initialLayoutMode ?? "grid",
  );
  const [floats, setFloats] = useState<FloatingTile[]>([]);
  const [moduleMapOpen, setModuleMapOpen] = useState(false);
  const zCounter = useRef(0);
  // When a preset/snapshot supplies an explicit layout + track sizes, skip the
  // next count-derived reflow so it is not clobbered. The reflow effect keys on
  // the docked-tile signature and is otherwise the single source of layout.
  const skipReflowRef = useRef(false);
  // Seed with the initial preset's tile signature so the first mount keeps the
  // preset's (possibly non-count-derived) layout instead of reflowing it.
  const lastGridSigRef = useRef(initialTiles.join("|"));

  // A deep-link seed carries explicit fractional tracks; honor them over the
  // count-derived even split so the shared space opens at its saved proportions.
  const [colFr, setColFr] = useState(() =>
    initialColFr && initialColFr.length === parseLayoutCols(initialLayoutId)
      ? [...initialColFr]
      : Array(parseLayoutCols(initialLayoutId)).fill(1),
  );
  const [rowFr, setRowFr] = useState(() =>
    initialRowFr && initialRowFr.length === parseLayoutRows(initialLayoutId)
      ? [...initialRowFr]
      : Array(parseLayoutRows(initialLayoutId)).fill(1),
  );

  // Mount-once slot registry: GridCanvas / FloatingTileLayer register slot DOM
  // nodes; TileHost portals each tile's element into its current slot.
  const slots = useMemo(() => createSlotRegistry(), []);
  const registerSlot = slots.registry.register;

  // The union of ids that must be mounted: active grid/list tiles + floats. A
  // floated tile stays mounted (its slot is the pane). We render each once here.
  const floatIds = useMemo(() => floats.map((f) => f.id), [floats]);
  const gridIds = useMemo(
    () => activeTiles.filter((id) => !floatIds.includes(id)),
    [activeTiles, floatIds],
  );
  const mountedIds = useMemo(
    () => Array.from(new Set([...activeTiles, ...floatIds])),
    [activeTiles, floatIds],
  );

  useEffect(() => {
    fetchAdminFunctions()
      .then((tiles) => {
        const map: Record<string, TileStatus> = {};
        for (const t of tiles) map[t.id] = t.status as TileStatus;
        setLiveStatuses(map);
      })
      .catch(() => {
        /* registry badges fall back to static tile status */
      });
  }, [fetchAdminFunctions]);

  const refreshSpaces = useCallback(() => {
    void listSavedSpaceEntries()
      .then(setSavedSpaces)
      .catch(() => setSavedSpaces([]));
  }, [listSavedSpaceEntries]);

  useEffect(() => {
    refreshSpaces();
  }, [refreshSpaces]);

  const applySnapshot = useCallback(
    (snap: SnapshotState, label: string | null) => {
      setUndoStack(
        snapshotState(engagementId ?? undefined, activeTiles, layoutId, "undo"),
      );
      // The snapshot carries an explicit layout; do not let the count-derived
      // reflow effect override it on this tile-set change.
      skipReflowRef.current = true;
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
      void loadSavedSpace(name).then((snap) => {
        if (!snap) return;
        setActivePresetId(presetId);
        applySnapshot(
          snapshotState(
            engagementId ?? undefined,
            snap.tileIds,
            snap.layoutId,
            name,
          ),
          `${name} space loaded`,
        );
        setColFr([...snap.colFr]);
        setRowFr([...snap.rowFr]);
        setLayoutMode(snap.layoutMode ?? "grid");
      });
      return;
    }
    const preset = presets.find((p) => p.id === presetId);
    if (!preset) return;
    setActivePresetId(presetId);
    applySnapshot(
      snapshotState(engagementId ?? undefined, preset.tiles, preset.layoutId, preset.label),
      `${preset.label} space loaded`,
    );
    setLayoutMode("grid");
  }

  function handleUndo() {
    if (!undoStack) return;
    setActiveTiles(undoStack.tiles);
    setLayoutId(undoStack.layoutId);
    setUndoStack(null);
    setUndoLabel(null);
  }

  function handleToggleTile(id: string) {
    setActiveTiles((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id],
    );
  }

  function handleRemoveTile(id: string) {
    setActiveTiles((prev) => prev.filter((t) => t !== id));
    setFloats((prev) => prev.filter((f) => f.id !== id));
  }

  // Drag-to-reorder: SWAP the two tiles' positions in the active array (the
  // count-keyed grid template re-places them by array order).
  const handleReorder = useCallback((dragId: string, dropId: string) => {
    setActiveTiles((prev) => {
      const i = prev.indexOf(dragId);
      const j = prev.indexOf(dropId);
      if (i < 0 || j < 0) return prev;
      const next = [...prev];
      next[i] = dropId;
      next[j] = dragId;
      return next;
    });
  }, []);

  // Pop a tile out into a floating pane. It stays in activeTiles (so it docks
  // back into the same template slot) but renders in the float layer; the grid
  // reflows to the remaining docked tiles.
  const handlePopOut = useCallback((id: string) => {
    setFloats((prev) => {
      if (prev.some((f) => f.id === id)) return prev;
      const offset = prev.length * 28;
      return [
        ...prev,
        {
          id,
          rect: { x: 120 + offset, y: 120 + offset, w: 480, h: 360 },
          z: ++zCounter.current,
        },
      ];
    });
  }, []);

  const handleDock = useCallback((id: string) => {
    setFloats((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const handleFloatRect = useCallback((id: string, rect: FloatRect) => {
    setFloats((prev) => prev.map((f) => (f.id === id ? { ...f, rect } : f)));
  }, []);

  const handleFloatFocus = useCallback((id: string) => {
    setFloats((prev) =>
      prev.map((f) => (f.id === id ? { ...f, z: ++zCounter.current } : f)),
    );
  }, []);

  const labelFor = useCallback(
    (id: string) => getTile(id)?.label ?? id,
    [getTile],
  );

  // The SINGLE source of layout truth for the grid: whenever the DOCKED
  // (non-floated) tile set changes — add, remove, pop-out, or dock-back — derive
  // the count-keyed template and reset the fractional tracks. Keyed on the
  // docked-id SIGNATURE (not just length) so a change that keeps the count but
  // swaps membership still reflows correctly, and so removing a floated tile
  // (which changes activeTiles but not the docked count) does not leave a stale
  // oversized template. An explicit preset/snapshot layout skips one reflow.
  const gridSig = gridIds.join("|");
  useEffect(() => {
    if (gridSig === lastGridSigRef.current) return;
    lastGridSigRef.current = gridSig;
    if (skipReflowRef.current) {
      skipReflowRef.current = false;
      return;
    }
    const want = layoutIdForTileCount(gridIds.length);
    setLayoutId(want);
    setColFr(Array(parseLayoutCols(want)).fill(1));
    setRowFr(Array(parseLayoutRows(want)).fill(1));
  }, [gridSig, gridIds.length]);

  function saveSpace() {
    const preset =
      presets.find((p) => p.id === activePresetId) ??
      savedSpaces.find((s) => s.id === activePresetId);
    const defaultName = preset?.label ?? "My space";
    const name = window.prompt("Space name:", defaultName);
    if (!name?.trim()) return;
    void Promise.resolve(
      saveCurrentSpace(name.trim(), {
        tileIds: [...activeTiles],
        layoutId,
        colFr: [...colFr],
        rowFr: [...rowFr],
        layoutMode,
      }),
    ).then(() => {
      refreshSpaces();
      setActivePresetId(savedSpaceId(name.trim()));
    });
  }

  function deleteSpace(spaceId: string) {
    if (!isSavedSpaceId(spaceId)) return;
    const name = savedSpaceName(spaceId);
    void Promise.resolve(deleteSavedSpace(name)).then(() => {
      refreshSpaces();
      if (activePresetId === spaceId) handleApplyPreset(presets[0]!.id);
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
      {onAddressSearch ? (
        <HeaderSearchBar
          onGeocode={onAddressSearch}
          onPreview={onAddressPreview}
          onResolved={onAddressResolved}
        />
      ) : null}

      <SpaceBar
        presets={presets}
        activePresetId={activePresetId}
        activeTiles={activeTiles}
        layoutId={layoutId}
        undoLabel={undoLabel}
        savedSpaces={savedSpaces}
        onApplyPreset={handleApplyPreset}
        onUndo={handleUndo}
        onExport={onExportEngagement && engagementId ? handleExport : undefined}
        exporting={exporting}
        onOpenPicker={() => setPickerOpen(true)}
        onSaveSpace={saveSpace}
        onDeleteSpace={deleteSpace}
      />

      <ShellToolbar
        editing={editing}
        onToggleEditing={() => setEditing((v) => !v)}
        layoutMode={layoutMode}
        onLayoutModeChange={setLayoutMode}
        floatCount={floats.length}
        onOpenModuleMap={() => setModuleMapOpen(true)}
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
        tileIds={gridIds}
        getTile={getTile}
        layoutId={layoutId}
        colFr={colFr}
        rowFr={rowFr}
        editing={editing}
        layoutMode={layoutMode}
        registerSlot={registerSlot}
        onColFrChange={setColFr}
        onRowFrChange={setRowFr}
        onReorder={handleReorder}
        onRemoveTile={handleRemoveTile}
        onFullscreen={setFullscreenId}
        onPopOut={handlePopOut}
        overflowTileId={overflowTileId}
        onSelectOverflow={setOverflowTileId}
      />

      <FloatingTileLayer
        floats={floats}
        labelFor={labelFor}
        registerSlot={registerSlot}
        onDock={handleDock}
        onRectChange={handleFloatRect}
        onFocus={handleFloatFocus}
      />

      {/* Mount-once tile content: rendered here, portaled into the current slot
          (grid cell, list section, or floating pane) so reflow never remounts. */}
      <TileHost
        activeIds={mountedIds}
        render={(id) => getTile(id)?.el() ?? null}
        getSlot={slots.get}
        subscribe={slots.subscribe}
      />

      {moduleMapOpen ? (
        <ModuleMap
          tiles={allTiles}
          onClose={() => setModuleMapOpen(false)}
          onAddTile={(id) => {
            if (!activeTiles.includes(id)) handleToggleTile(id);
            setModuleMapOpen(false);
          }}
        />
      ) : null}
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
  initialSpaceSeed,
  onExportEngagement,
  onAddressSearch,
  onAddressPreview,
  onAddressResolved,
}: CortexShellProps) {
  const preset = presets.find((p) => p.id === initialPresetId) ?? presets[0]!;

  // Deep-link seed resolution. When the app hands us a resolved shared/named
  // space (from a `?share=`/`?space=` URL param), open the workspace directly on
  // that snapshot: its tiles/layout/tracks/mode over the default preset, and its
  // pinned parcel context adopted as the initial active parcel. The
  // `savedSpaceId(label)` id keeps the SpaceBar's active-preset highlight and the
  // save-over-name flow consistent with an in-app space load.
  const seed = initialSpaceSeed ?? null;
  const seedSnap = seed?.snapshot ?? null;
  const initialPresetIdResolved =
    seed && seed.label ? savedSpaces.savedSpaceId(seed.label) : preset.id;
  const initialTiles = seedSnap?.tileIds ?? preset.tiles;
  const initialLayoutId = seedSnap?.layoutId ?? preset.layoutId;
  const initialColFr = seedSnap?.colFr;
  const initialRowFr = seedSnap?.rowFr;
  const initialLayoutMode = seedSnap?.layoutMode;
  const initialParcel = seedSnap?.context ?? undefined;

  return (
    <EngagementProvider initialParcel={initialParcel}>
      <SpatialProvider>
        <CodeProvider>
          <AnnotationSelectionProvider>
            <DocumentViewerNavigationProvider>
              <CortexShellInner
                initialPresetId={initialPresetIdResolved}
                initialTiles={initialTiles}
                initialLayoutId={initialLayoutId}
                initialColFr={initialColFr}
                initialRowFr={initialRowFr}
                initialLayoutMode={initialLayoutMode}
                getTile={getTile}
                allTiles={allTiles}
                categories={categories}
                presets={presets}
                fetchAdminFunctions={fetchAdminFunctions}
                savedSpaces={savedSpaces}
                onExportEngagement={onExportEngagement}
                onAddressSearch={onAddressSearch}
                onAddressPreview={onAddressPreview}
                onAddressResolved={onAddressResolved}
              />
            </DocumentViewerNavigationProvider>
          </AnnotationSelectionProvider>
        </CodeProvider>
      </SpatialProvider>
    </EngagementProvider>
  );
}
