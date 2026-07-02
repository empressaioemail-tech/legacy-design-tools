import {
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import type { TileDef } from "../types";
import { LAYOUTS, gridAreasForTiles } from "../layouts";
import { TileWrapper } from "./TileWrapper";

/**
 * The tile canvas. Renders tiles as a CSS-Grid of cards (grid mode) or a
 * seamless vertical stack (list/report mode), in either edit or view mode.
 *
 * Tile CONTENT is NOT rendered here — each tile's body registers a slot node
 * with the shared slot registry, and TileHost portals the mount-once tile
 * element into it. This keeps reorder/resize/edit-view/list-grid transitions
 * remount-free for heavy tiles.
 */
export function GridCanvas({
  tileIds,
  getTile,
  layoutId,
  colFr,
  rowFr,
  editing,
  layoutMode,
  registerSlot,
  onColFrChange,
  onRowFrChange,
  onReorder,
  onRemoveTile,
  onFullscreen,
  onPopOut,
  overflowTileId,
  onSelectOverflow,
}: {
  tileIds: string[];
  getTile: (id: string) => TileDef | undefined;
  layoutId: string;
  colFr: number[];
  rowFr: number[];
  editing: boolean;
  /** 'grid' = card grid; 'list' = seamless vertical report stack. */
  layoutMode: "grid" | "list";
  /** Register a tile-body slot node so TileHost can portal content in. */
  registerSlot: (id: string, node: HTMLElement | null) => void;
  onColFrChange: (cols: number[]) => void;
  onRowFrChange: (rows: number[]) => void;
  /** Swap two tiles in the active-tiles array (drag-to-reorder). */
  onReorder: (dragId: string, dropId: string) => void;
  onRemoveTile: (id: string) => void;
  onFullscreen: (id: string | null) => void;
  onPopOut: (id: string) => void;
  overflowTileId: string | null;
  onSelectOverflow: (id: string) => void;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);

  const isList = layoutMode === "list";
  const visibleIds = isList ? tileIds : tileIds.slice(0, 4);
  const overflow = !isList && tileIds.length > 4 ? tileIds.slice(4) : [];
  const areas = gridAreasForTiles(visibleIds);
  const templateAreas = (LAYOUTS[layoutId] ?? LAYOUTS["4"]!)
    .split("/")
    .map((s) => s.trim())
    .join(" ");

  const gridTemplateColumns = colFr.map((f) => `${f}fr`).join(" ");
  const gridTemplateRows = rowFr.map((f) => `${f}fr`).join(" ");

  const colSum = colFr.reduce((a, b) => a + b, 0);
  const rowSum = rowFr.reduce((a, b) => a + b, 0);
  const colBoundaryPct =
    colFr.length >= 2 && colSum > 0 ? (colFr[0]! / colSum) * 100 : null;
  const rowBoundaryPct =
    rowFr.length >= 2 && rowSum > 0 ? (rowFr[0]! / rowSum) * 100 : null;

  function handleDrop(target: string) {
    if (dragId && dragId !== target) onReorder(dragId, target);
    setDragId(null);
    setDropId(null);
  }

  function tile(id: string, gridArea?: string) {
    const def = getTile(id);
    if (!def) return null;
    return (
      <TileWrapper
        key={id}
        tileId={id}
        label={def.label}
        gridArea={gridArea}
        fill={id === "map"}
        editing={editing}
        dragging={dragId === id}
        dropTarget={editing && dropId === id && dragId !== id}
        onClose={() => onRemoveTile(id)}
        onFullscreen={() => onFullscreen(id)}
        onPopOut={() => onPopOut(id)}
        onDragStart={() => setDragId(id)}
        onDragEnd={() => {
          setDragId(null);
          setDropId(null);
        }}
        onDragOverTile={(e: ReactDragEvent) => {
          e.preventDefault();
          if (dropId !== id) setDropId(id);
        }}
        onDropTile={() => handleDrop(id)}
      >
        <SlotAnchor id={id} registerSlot={registerSlot} />
      </TileWrapper>
    );
  }

  if (isList) {
    return (
      <div
        data-testid="tile-list"
        className={`ts-tilelist ${editing ? "ts-edit" : "ts-view"}`}
      >
        {visibleIds.map((id) => tile(id))}
      </div>
    );
  }

  const solo = visibleIds.length === 1;
  const gridClass = [
    "ts-tilegrid",
    editing ? "ts-edit" : "ts-view",
    !editing && !solo ? "ts-seamless" : "",
    solo ? "ts-solo" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
      {overflow.length > 0 ? (
        <div
          style={{
            padding: "6px 12px",
            borderBottom: "1px solid var(--h-border-subtle)",
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: 11, color: "var(--h-text-muted)" }}>Overflow:</span>
          {overflow.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => onSelectOverflow(id)}
              style={{
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: 4,
                border: "1px solid var(--h-border-subtle)",
                background:
                  overflowTileId === id ? "var(--h-surface-2)" : "transparent",
              }}
            >
              {getTile(id)?.label ?? id}
            </button>
          ))}
        </div>
      ) : null}

      <div
        ref={gridRef}
        data-testid="grid-canvas"
        className={gridClass}
        style={{
          flex: 1,
          gridTemplateAreas: templateAreas,
          gridTemplateColumns,
          gridTemplateRows,
        }}
      >
        {visibleIds.map((id, i) => tile(id, areas[i]))}

        {colBoundaryPct !== null ? (
          <ResizeHandle
            orientation="col"
            boundaryPct={colBoundaryPct}
            containerRef={gridRef}
            frTotal={colSum}
            onFrChange={onColFrChange}
          />
        ) : null}
        {rowBoundaryPct !== null ? (
          <ResizeHandle
            orientation="row"
            boundaryPct={rowBoundaryPct}
            containerRef={gridRef}
            frTotal={rowSum}
            onFrChange={onRowFrChange}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * The DOM node a tile's mount-once content is portaled into. Registers itself
 * with the slot registry on mount and unregisters on unmount, so TileHost
 * re-targets the portal as the layout reflows.
 */
function SlotAnchor({
  id,
  registerSlot,
}: {
  id: string;
  registerSlot: (id: string, node: HTMLElement | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    registerSlot(id, ref.current);
    return () => registerSlot(id, null);
  }, [id, registerSlot]);
  return (
    <div
      ref={ref}
      data-tile-slot={id}
      style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}
    />
  );
}

function ResizeHandle({
  orientation,
  boundaryPct,
  containerRef,
  frTotal,
  onFrChange,
}: {
  orientation: "col" | "row";
  boundaryPct: number;
  containerRef: RefObject<HTMLDivElement | null>;
  frTotal: number;
  onFrChange: (fr: number[]) => void;
}) {
  const dragging = useRef(false);

  function onMouseDown(e: ReactMouseEvent) {
    e.preventDefault();
    dragging.current = true;
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();

    function onMove(ev: MouseEvent) {
      if (!dragging.current) return;
      if (orientation === "col") {
        const ratio = Math.min(
          0.95,
          Math.max(0.05, (ev.clientX - rect.left) / rect.width),
        );
        onFrChange([ratio * frTotal, (1 - ratio) * frTotal]);
      } else {
        const ratio = Math.min(
          0.95,
          Math.max(0.05, (ev.clientY - rect.top) / rect.height),
        );
        onFrChange([ratio * frTotal, (1 - ratio) * frTotal]);
      }
    }

    function onUp() {
      dragging.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return (
    <div
      role="separator"
      aria-orientation={orientation === "col" ? "vertical" : "horizontal"}
      onMouseDown={onMouseDown}
      className={`ts-resize-handle ts-${orientation}`}
      style={
        orientation === "col"
          ? { left: `${boundaryPct}%` }
          : { top: `${boundaryPct}%` }
      }
    />
  );
}
