import {
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from "react";

/**
 * A single tile shell (header chrome + body). Used by GridCanvas and the list
 * layout. The header (`ts-tile-head`) is hidden by CSS in view/seamless mode and
 * is the drag handle in edit mode. Body chrome is styled entirely through the
 * `ts-tile*` classes in shell.css so the edit/view fuse is a pure class toggle.
 */
export function TileWrapper({
  tileId,
  label,
  gridArea,
  fill = false,
  editing = false,
  dragging = false,
  dropTarget = false,
  children,
  onClose,
  onFullscreen,
  onPopOut,
  onDragStart,
  onDragEnd,
  onDragOverTile,
  onDropTile,
}: {
  tileId: string;
  label: string;
  gridArea?: string;
  fill?: boolean;
  editing?: boolean;
  dragging?: boolean;
  dropTarget?: boolean;
  children: ReactNode;
  onClose: () => void;
  onFullscreen: () => void;
  /** Pop the tile out into a floating pane (edit affordance). */
  onPopOut?: () => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onDragOverTile?: (e: ReactDragEvent) => void;
  onDropTile?: () => void;
}) {
  const cls = [
    "ts-tile",
    dragging ? "ts-dragging" : "",
    dropTarget ? "ts-drop-target" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      data-testid={`tile-wrapper-${tileId}`}
      className={cls}
      style={gridArea ? { gridArea } : undefined}
      onDragOver={editing ? onDragOverTile : undefined}
      onDrop={
        editing && onDropTile
          ? (e) => {
              e.preventDefault();
              onDropTile();
            }
          : undefined
      }
    >
      <div
        className={`ts-tile-head${editing ? " ts-draggable" : ""}`}
        draggable={editing}
        onDragStart={
          editing
            ? (e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", tileId);
                onDragStart?.();
              }
            : undefined
        }
        onDragEnd={editing ? onDragEnd : undefined}
      >
        {editing ? (
          <span className="ts-tile-grip" aria-hidden data-testid={`tile-grip-${tileId}`}>
            ⠿
          </span>
        ) : null}
        <span style={{ flex: 1, fontSize: 11, fontWeight: 600 }}>{label}</span>
        {editing && onPopOut ? (
          <button
            type="button"
            aria-label="Pop out tile"
            data-testid={`tile-popout-${tileId}`}
            onClick={onPopOut}
            style={chromeButtonStyle}
            title="Pop out into a floating pane"
          >
            ⧉
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Fullscreen"
          data-testid={`tile-fullscreen-${tileId}`}
          onClick={onFullscreen}
          style={chromeButtonStyle}
        >
          ⛶
        </button>
        <button
          type="button"
          aria-label="Close tile"
          data-testid={`tile-close-${tileId}`}
          onClick={onClose}
          style={chromeButtonStyle}
        >
          ×
        </button>
      </div>
      <div className={`ts-tile-body${fill ? " ts-fill" : ""}`}>{children}</div>
    </div>
  );
}

const chromeButtonStyle: CSSProperties = {
  border: "none",
  background: "transparent",
  cursor: "pointer",
  fontSize: 14,
  color: "var(--h-text-muted)",
  padding: "2px 6px",
};
