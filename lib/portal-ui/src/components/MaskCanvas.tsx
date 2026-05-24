import { useCallback, useEffect, useRef, useState } from "react";

export interface MaskCanvasProps {
  /** Source image the mask must match (dimensions). */
  imageUrl: string;
  brushSize?: number;
  disabled?: boolean;
  testId?: string;
  /** Called when the mask PNG blob changes (white paint on black). */
  onMaskChange: (blob: Blob | null) => void;
}

const MAX_UNDO = 20;

/**
 * doc 40e B.4 — brush mask editor for AI Eraser / Inpaint (white on black).
 */
export function MaskCanvas({
  imageUrl,
  brushSize = 24,
  disabled = false,
  testId = "mask-canvas",
  onMaskChange,
}: MaskCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [undoStack, setUndoStack] = useState<ImageData[]>([]);
  const [size, setSize] = useState(brushSize);

  const exportMask = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => onMaskChange(blob), "image/png");
  }, [onMaskChange]);

  const snapshot = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return null;
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }, []);

  const restore = useCallback((data: ImageData | null) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !data) return;
    ctx.putImageData(data, 0, 0);
    exportMask();
  }, [exportMask]);

  const clearMask = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    setUndoStack([]);
    exportMask();
  }, [exportMask]);

  useEffect(() => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (!canvas || !wrap) return;
      const maxW = wrap.clientWidth || 480;
      const scale = Math.min(1, maxW / img.width);
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      setUndoStack([]);
      setReady(true);
      exportMask();
    };
    img.onerror = () => setReady(false);
    img.src = imageUrl;
  }, [imageUrl, exportMask]);

  const paint = useCallback(
    (clientX: number, clientY: number, startStroke: boolean) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx || disabled) return;
      const rect = canvas.getBoundingClientRect();
      const x = ((clientX - rect.left) / rect.width) * canvas.width;
      const y = ((clientY - rect.top) / rect.height) * canvas.height;
      if (startStroke) {
        const snap = snapshot();
        if (snap) {
          setUndoStack((prev) => [...prev.slice(-MAX_UNDO + 1), snap]);
        }
      }
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(x, y, size / 2, 0, Math.PI * 2);
      ctx.fill();
    },
    [disabled, size, snapshot],
  );

  const undo = useCallback(() => {
    setUndoStack((prev) => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      const last = next.pop()!;
      restore(last);
      return next;
    });
  }, [restore]);

  return (
    <div data-testid={testId} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        ref={wrapRef}
        style={{
          position: "relative",
          border: "1px solid var(--border-default)",
          borderRadius: 4,
          overflow: "hidden",
          background: "#111",
        }}
      >
        <img
          src={imageUrl}
          alt=""
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "contain",
            opacity: 0.45,
            pointerEvents: "none",
          }}
        />
        <canvas
          ref={canvasRef}
          data-testid={`${testId}-surface`}
          style={{
            position: "relative",
            display: "block",
            width: "100%",
            cursor: disabled ? "not-allowed" : "crosshair",
            touchAction: "none",
          }}
          onPointerDown={(e) => {
            if (disabled) return;
            drawingRef.current = true;
            canvasRef.current?.setPointerCapture(e.pointerId);
            paint(e.clientX, e.clientY, true);
          }}
          onPointerMove={(e) => {
            if (!drawingRef.current || disabled) return;
            paint(e.clientX, e.clientY, false);
          }}
          onPointerUp={() => {
            if (!drawingRef.current) return;
            drawingRef.current = false;
            exportMask();
          }}
          onPointerLeave={() => {
            if (!drawingRef.current) return;
            drawingRef.current = false;
            exportMask();
          }}
        />
        {!ready && (
          <div
            className="sc-meta"
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-muted)",
            }}
          >
            Loading image…
          </div>
        )}
      </div>
      <div className="flex items-center" style={{ gap: 12, flexWrap: "wrap" }}>
        <label className="sc-meta" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          Brush
          <input
            type="range"
            min={4}
            max={96}
            value={size}
            disabled={disabled}
            onChange={(e) => setSize(Number(e.target.value))}
            data-testid={`${testId}-brush-size`}
          />
        </label>
        <button
          type="button"
          className="sc-btn-ghost"
          disabled={disabled || undoStack.length === 0}
          onClick={undo}
          data-testid={`${testId}-undo`}
        >
          Undo
        </button>
        <button
          type="button"
          className="sc-btn-ghost"
          disabled={disabled}
          onClick={clearMask}
          data-testid={`${testId}-clear`}
        >
          Clear mask
        </button>
      </div>
    </div>
  );
}
