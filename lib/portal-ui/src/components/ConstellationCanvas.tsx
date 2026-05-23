import { useEffect, useRef, useState } from "react";

export interface ConstellationCanvasProps {
  testId?: string;
  /** Disable animation when reduced motion is preferred or FPS drops. */
  enabled?: boolean;
}

/**
 * doc 40e C.7 — lightweight star-field background for RendersTab.
 */
export function ConstellationCanvas({
  testId = "constellation-canvas",
  enabled = true,
}: ConstellationCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [disabled, setDisabled] = useState(!enabled);

  useEffect(() => {
    if (!enabled) {
      setDisabled(true);
      return;
    }
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mq.matches) {
      setDisabled(true);
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const stars = Array.from({ length: 48 }, () => ({
      x: Math.random(),
      y: Math.random(),
      r: Math.random() * 1.4 + 0.3,
      vx: (Math.random() - 0.5) * 0.0004,
      vy: (Math.random() - 0.5) * 0.0004,
    }));

    let raf = 0;
    let last = performance.now();
    let frames = 0;
    let fpsWindowStart = performance.now();

    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      canvas.width = parent.clientWidth;
      canvas.height = parent.clientHeight;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement ?? canvas);

    const tick = (now: number) => {
      frames += 1;
      if (now - fpsWindowStart > 2000) {
        const fps = frames / ((now - fpsWindowStart) / 1000);
        frames = 0;
        fpsWindowStart = now;
        if (fps < 24) {
          setDisabled(true);
          cancelAnimationFrame(raf);
          ro.disconnect();
          return;
        }
      }
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "rgba(120, 180, 255, 0.55)";
      for (const s of stars) {
        s.x += s.vx;
        s.y += s.vy;
        if (s.x < 0 || s.x > 1) s.vx *= -1;
        if (s.y < 0 || s.y > 1) s.vy *= -1;
        ctx.beginPath();
        ctx.arc(s.x * w, s.y * h, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      last = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [enabled]);

  if (disabled) return null;

  return (
    <canvas
      ref={canvasRef}
      data-testid={testId}
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        opacity: 0.35,
      }}
    />
  );
}
