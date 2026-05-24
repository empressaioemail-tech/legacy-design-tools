import {
  useCallback,
  useEffect,
  useRef,
  type RefObject,
} from "react";
import * as THREE from "three";
import { Home } from "lucide-react";
import { ViewCubeRenderer } from "./ViewCubeRenderer";
import {
  VIEW_CUBE_ORBIT_ROTATE_SPEED,
} from "./viewCubeCamera";
import { VIEW_CUBE_CANVAS_SIZE, type ViewCubeRegionId } from "./viewCubeModel";

/** Pixels before a pointer-down becomes a drag (not a face click). */
const VIEW_CUBE_DRAG_SLOP_PX = 2;

export type { ViewCubeRegionId } from "./viewCubeModel";

export interface ViewCubeWidgetProps {
  /** Live main viewport camera — cube mirrors its inverse quaternion each frame. */
  mainCamera: RefObject<THREE.Camera | null>;
  onSelectRegion: (region: ViewCubeRegionId) => void;
  onOrbitDrag?: (deltaX: number, deltaY: number) => void;
  onOrbitDragStart?: () => void;
  onOrbitDragEnd?: () => void;
  onCompassHeadingDrag?: (deltaRadians: number) => void;
  onCompassSnap?: (cardinal: "n" | "e" | "s" | "w") => void;
  onHome?: () => void;
  disabled?: boolean;
  className?: string;
}

/**
 * Revit-style ViewCube — real BoxGeometry mesh in a mini WebGL canvas.
 * Bi-directional sync via inverse main-camera quaternion; face clicks via raycast.
 */
export function ViewCubeWidget({
  mainCamera,
  onSelectRegion,
  onOrbitDrag,
  onOrbitDragStart,
  onOrbitDragEnd,
  onCompassHeadingDrag,
  onCompassSnap,
  onHome,
  disabled = false,
  className,
}: ViewCubeWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<ViewCubeRenderer | null>(null);
  const dragRef = useRef<{
    mode: "cube" | "compass";
    lastX: number;
    lastY: number;
    moved: boolean;
  } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || disabled) return;

    const cubeRenderer = new ViewCubeRenderer(container, {
      w: VIEW_CUBE_CANVAS_SIZE.width,
      h: VIEW_CUBE_CANVAS_SIZE.height,
    });
    rendererRef.current = cubeRenderer;

    let frame = 0;
    const loop = () => {
      const cam = mainCamera.current;
      if (cam) {
        cubeRenderer.setOrientationFromMainCamera(cam);
      }
      cubeRenderer.render();
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(frame);
      cubeRenderer.dispose();
      rendererRef.current = null;
    };
  }, [mainCamera, disabled]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (disabled) return;
      const r = rendererRef.current;
      if (!r) return;
      const compass = r.raycastCompass(e.clientX, e.clientY);
      const onCube = r.raycastCubeBody(e.clientX, e.clientY);
      if (compass && !onCube) {
        dragRef.current = {
          mode: "compass",
          lastX: e.clientX,
          lastY: e.clientY,
          moved: false,
        };
      } else if (onCube) {
        onOrbitDragStart?.();
        dragRef.current = {
          mode: "cube",
          lastX: e.clientX,
          lastY: e.clientY,
          moved: false,
        };
      } else {
        return;
      }
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [disabled, onOrbitDragStart],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const r = rendererRef.current;
      if (disabled || !r) return;
      const drag = dragRef.current;
      if (drag) {
        const dx = e.clientX - drag.lastX;
        const dy = e.clientY - drag.lastY;
        if (Math.hypot(dx, dy) > VIEW_CUBE_DRAG_SLOP_PX) drag.moved = true;
        drag.lastX = e.clientX;
        drag.lastY = e.clientY;
        if (drag.mode === "cube" && onOrbitDrag) {
          onOrbitDrag(dx, dy);
        } else if (drag.mode === "compass" && onCompassHeadingDrag) {
          onCompassHeadingDrag(-dx * VIEW_CUBE_ORBIT_ROTATE_SPEED * 2);
        }
      } else {
        r.updateHover(e.clientX, e.clientY);
      }
    },
    [disabled, onOrbitDrag, onCompassHeadingDrag],
  );

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (dragRef.current?.mode === "cube") {
      onOrbitDragEnd?.();
    }
    dragRef.current = null;
    rendererRef.current?.setHoverFace(null);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  }, [onOrbitDragEnd]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (disabled) return;
      if (dragRef.current?.moved) return;
      const r = rendererRef.current;
      if (!r) return;
      const face = r.raycastFace(e.clientX, e.clientY);
      if (face) {
        onSelectRegion(face);
        return;
      }
      const cardinal = r.raycastCompass(e.clientX, e.clientY);
      if (cardinal) onCompassSnap?.(cardinal);
    },
    [disabled, onSelectRegion, onCompassSnap],
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (disabled) return;
      const r = rendererRef.current;
      if (r?.raycastCubeBody(e.clientX, e.clientY)) onHome?.();
    },
    [disabled, onHome],
  );

  return (
    <div
      className={["bim-viewport-viewcube", className].filter(Boolean).join(" ")}
      data-testid="bim-viewport-viewcube"
      data-disabled={disabled ? "true" : "false"}
      role="navigation"
      aria-label="3D view orientation. Click faces for standard views."
      aria-disabled={disabled}
    >
      <div
        ref={containerRef}
        className="bim-viewport-viewcube-canvas-wrap"
        data-testid="bim-viewport-viewcube-canvas-wrap"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={(e) => {
          handlePointerUp(e);
          rendererRef.current?.setHoverFace(null);
        }}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
      />

      {onHome ? (
        <button
          type="button"
          className="bim-viewport-viewcube-home"
          data-testid="bim-viewport-viewcube-home"
          disabled={disabled}
          title="Reset view (Home)"
          aria-label="Reset view to home framing"
          onClick={() => onHome()}
        >
          <Home size={12} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
