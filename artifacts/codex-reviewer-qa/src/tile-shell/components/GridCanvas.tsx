import { useState } from "react";
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
  const templateAreas = LAYOUTS[layoutId] ?? LAYOUTS["4"]!;

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
  const [dragging, setDragging] = useState(false);

  return (
    <div
      role="separator"
      aria-orientation={orientation === "col" ? "vertical" : "horizontal"}
      onMouseDown={() => setDragging(true)}
      onMouseUp={() => setDragging(false)}
      onMouseLeave={() => setDragging(false)}
      onMouseMove={(e) => {
        if (!dragging) return;
        onDrag(orientation === "col" ? e.movementX * 0.01 : e.movementY * 0.01);
      }}
      style={{
        position: "absolute",
        ...(orientation === "col"
          ? { top: 0, bottom: 0, left: "50%", width: 6, cursor: "col-resize" }
          : { left: 0, right: 0, top: "50%", height: 6, cursor: "row-resize" }),
        zIndex: 10,
        background: dragging ? "var(--accent)" : "transparent",
      }}
    />
  );
}
