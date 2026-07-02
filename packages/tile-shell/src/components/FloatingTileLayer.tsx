import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";

export type FloatRect = { x: number; y: number; w: number; h: number };
export type FloatingTile = { id: string; rect: FloatRect; z: number };

/**
 * Floating (popped-out) tile panes with dock-back — adapted from the trading
 * app's FloatingChartLayer. Each pane is position:fixed, draggable by its head
 * and resizable from the corner, brought to front on interaction, and has a
 * "Dock" button that returns the tile to the grid + triggers a template reflow.
 *
 * Like the grid, a pane's BODY registers a slot node; TileHost portals the same
 * mount-once tile element into it, so popping out and docking back never
 * remounts the tile. We adopt the trading app's template-reflow + dock-back
 * model, NOT a net-new magnetic snap-to-neighbour engine (explicitly
 * out-of-scope for this phase).
 */
export function FloatingTileLayer({
  floats,
  labelFor,
  registerSlot,
  onDock,
  onRectChange,
  onFocus,
}: {
  floats: FloatingTile[];
  labelFor: (id: string) => string;
  registerSlot: (id: string, node: HTMLElement | null) => void;
  onDock: (id: string) => void;
  onRectChange: (id: string, rect: FloatRect) => void;
  onFocus: (id: string) => void;
}) {
  return (
    <>
      {floats.map((f) => (
        <FloatingPane
          key={f.id}
          float={f}
          label={labelFor(f.id)}
          registerSlot={registerSlot}
          onDock={() => onDock(f.id)}
          onRectChange={(rect) => onRectChange(f.id, rect)}
          onFocus={() => onFocus(f.id)}
        />
      ))}
    </>
  );
}

function FloatingPane({
  float,
  label,
  registerSlot,
  onDock,
  onRectChange,
  onFocus,
}: {
  float: FloatingTile;
  label: string;
  registerSlot: (id: string, node: HTMLElement | null) => void;
  onDock: () => void;
  onRectChange: (rect: FloatRect) => void;
  onFocus: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const rectRef = useRef(float.rect);
  rectRef.current = float.rect;

  useEffect(() => {
    registerSlot(float.id, bodyRef.current);
    return () => registerSlot(float.id, null);
  }, [float.id, registerSlot]);

  function startDrag(e: ReactMouseEvent) {
    e.preventDefault();
    onFocus();
    const startX = e.clientX;
    const startY = e.clientY;
    const base = { ...rectRef.current };
    function move(ev: MouseEvent) {
      onRectChange({
        ...base,
        x: base.x + (ev.clientX - startX),
        y: base.y + (ev.clientY - startY),
      });
    }
    function up() {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  function startResize(e: ReactMouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    onFocus();
    const startX = e.clientX;
    const startY = e.clientY;
    const base = { ...rectRef.current };
    function move(ev: MouseEvent) {
      onRectChange({
        ...base,
        w: Math.max(240, base.w + (ev.clientX - startX)),
        h: Math.max(160, base.h + (ev.clientY - startY)),
      });
    }
    function up() {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  return (
    <div
      className="ts-float-pane"
      data-testid={`float-pane-${float.id}`}
      onMouseDown={onFocus}
      style={{
        left: float.rect.x,
        top: float.rect.y,
        width: float.rect.w,
        height: float.rect.h,
        zIndex: 1000 + float.z,
      }}
    >
      <div className="ts-float-head" onMouseDown={startDrag}>
        <span style={{ flex: 1, fontSize: 11, fontWeight: 600 }}>{label}</span>
        <button
          type="button"
          data-testid={`float-dock-${float.id}`}
          onClick={onDock}
          title="Dock back into the grid"
          style={{
            border: "1px solid var(--h-border-subtle)",
            background: "var(--h-surface-3)",
            color: "var(--h-text-primary)",
            borderRadius: 6,
            fontSize: 11,
            fontWeight: 600,
            padding: "2px 10px",
            cursor: "pointer",
          }}
        >
          ⤓ Dock
        </button>
      </div>
      <div
        ref={bodyRef}
        className="ts-float-body"
        style={{ display: "flex", flexDirection: "column", minHeight: 0 }}
      />
      <div
        className="ts-float-resize"
        data-testid={`float-resize-${float.id}`}
        onMouseDown={startResize}
      />
    </div>
  );
}
