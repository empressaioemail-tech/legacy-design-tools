import { useRef, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import type { TileDef } from "../types";
import { LAYOUTS, gridAreasForTiles } from "../layouts";
import { TileWrapper } from "./TileWrapper";

export function GridCanvas({
  tileIds,
  getTile,
  layoutId,
  colFr,
  rowFr,
  onColFrChange,
  onRowFrChange,
  onRemoveTile,
  onFullscreen,
  overflowTileId,
  onSelectOverflow,
}: {
  tileIds: string[];
  getTile: (id: string) => TileDef | undefined;
  layoutId: string;
  colFr: number[];
  rowFr: number[];
  onColFrChange: (cols: number[]) => void;
  onRowFrChange: (rows: number[]) => void;
  onRemoveTile: (id: string) => void;
  onFullscreen: (id: string | null) => void;
  overflowTileId: string | null;
  onSelectOverflow: (id: string) => void;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const visibleIds = tileIds.slice(0, 4);
  const overflow = tileIds.length > 4 ? tileIds.slice(4) : [];
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
        style={{
          flex: 1,
          height: "100%",
          display: "grid",
          gridTemplateAreas: templateAreas,
          gridTemplateColumns,
          gridTemplateRows,
          alignContent: "stretch",
          gap: 2,
          padding: 8,
          minHeight: 0,
          position: "relative",
        }}
      >
        {visibleIds.map((id, i) => {
          const def = getTile(id);
          if (!def) return null;
          return (
            <TileWrapper
              key={id}
              tileId={id}
              label={def.label}
              gridArea={areas[i]}
              fill={id === "map"}
              onClose={() => onRemoveTile(id)}
              onFullscreen={() => onFullscreen(id)}
            >
              {def.el()}
            </TileWrapper>
          );
        })}

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
      className="grid-resize-handle"
      style={{
        position: "absolute",
        ...(orientation === "col"
          ? {
              top: 0,
              bottom: 0,
              left: `${boundaryPct}%`,
              width: 8,
              cursor: "col-resize",
              transform: "translateX(-50%)",
            }
          : {
              left: 0,
              right: 0,
              top: `${boundaryPct}%`,
              height: 8,
              cursor: "row-resize",
              transform: "translateY(-50%)",
            }),
        zIndex: 10,
        background: "transparent",
      }}
    />
  );
}
