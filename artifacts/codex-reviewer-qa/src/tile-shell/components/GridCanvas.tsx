import { useRef } from "react";
import { getTile } from "../tiles";
import { LAYOUTS, gridAreasForTiles } from "../layouts";
import { TileWrapper } from "./TileWrapper";

export function GridCanvas({
  tileIds,
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
  const visibleIds = tileIds.slice(0, 4);
  const overflow = tileIds.length > 4 ? tileIds.slice(4) : [];
  const areas = gridAreasForTiles(visibleIds);
  const templateAreas = (LAYOUTS[layoutId] ?? LAYOUTS["4"]!)
    .split("/")
    .map((s) => s.trim())
    .join(" ");

  const gridTemplateColumns = colFr.map((f) => `${f}fr`).join(" ");
  const gridTemplateRows = rowFr.map((f) => `${f}fr`).join(" ");

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      {overflow.length > 0 ? (
        <div
          style={{
            padding: "6px 12px",
            borderBottom: "1px solid var(--border-subtle)",
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Overflow:</span>
          {overflow.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => onSelectOverflow(id)}
              style={{
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: 4,
                border: "1px solid var(--border-subtle)",
                background:
                  overflowTileId === id ? "var(--info-dim)" : "transparent",
              }}
            >
              {getTile(id)?.label ?? id}
            </button>
          ))}
        </div>
      ) : null}

      <div
        data-testid="grid-canvas"
        style={{
          flex: 1,
          display: "grid",
          gridTemplateAreas: templateAreas,
          gridTemplateColumns,
          gridTemplateRows,
          gap: 2,
          padding: 8,
          minHeight: 400,
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

        <ResizeHandle
          orientation="col"
          onDrag={(delta) => {
            if (colFr.length < 2) return;
            const next = [...colFr];
            next[0] = Math.max(0.2, next[0]! + delta);
            next[1] = Math.max(0.2, next[1]! - delta);
            onColFrChange(next);
          }}
        />
        <ResizeHandle
          orientation="row"
          onDrag={(delta) => {
            if (rowFr.length < 2) return;
            const next = [...rowFr];
            next[0] = Math.max(0.2, next[0]! + delta);
            next[1] = Math.max(0.2, next[1]! - delta);
            onRowFrChange(next);
          }}
        />
      </div>
    </div>
  );
}

function ResizeHandle({
  orientation,
  onDrag,
}: {
  orientation: "col" | "row";
  onDrag: (delta: number) => void;
}) {
  const dragging = useRef(false);

  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    dragging.current = true;

    function onMove(ev: MouseEvent) {
      if (!dragging.current) return;
      onDrag(
        orientation === "col" ? ev.movementX * 0.01 : ev.movementY * 0.01,
      );
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
              left: "50%",
              width: 8,
              cursor: "col-resize",
              transform: "translateX(-50%)",
            }
          : {
              left: 0,
              right: 0,
              top: "50%",
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
