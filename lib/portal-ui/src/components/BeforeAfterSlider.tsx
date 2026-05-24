import { useCallback, useRef, useState } from "react";

export interface BeforeAfterSliderProps {
  beforeSrc: string;
  afterSrc: string;
  beforeLabel?: string;
  afterLabel?: string;
  testId?: string;
}

/**
 * doc 40e C.1 — side-by-side comparison slider for still renders.
 */
export function BeforeAfterSlider({
  beforeSrc,
  afterSrc,
  beforeLabel = "Source",
  afterLabel = "Render",
  testId = "before-after-slider",
}: BeforeAfterSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [pct, setPct] = useState(50);
  const draggingRef = useRef(false);

  const setFromClientX = useCallback((clientX: number) => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const next = ((clientX - rect.left) / rect.width) * 100;
    setPct(Math.min(100, Math.max(0, next)));
  }, []);

  return (
    <div data-testid={testId} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        ref={trackRef}
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: "16 / 10",
          borderRadius: 4,
          overflow: "hidden",
          border: "1px solid var(--border-default)",
          userSelect: "none",
          touchAction: "none",
        }}
        onPointerDown={(e) => {
          draggingRef.current = true;
          trackRef.current?.setPointerCapture(e.pointerId);
          setFromClientX(e.clientX);
        }}
        onPointerMove={(e) => {
          if (!draggingRef.current) return;
          setFromClientX(e.clientX);
        }}
        onPointerUp={() => {
          draggingRef.current = false;
        }}
      >
        <img
          src={afterSrc}
          alt={afterLabel}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }}
        />
        <div
          style={{
            position: "absolute",
            inset: 0,
            clipPath: `inset(0 ${100 - pct}% 0 0)`,
          }}
        >
          <img
            src={beforeSrc}
            alt={beforeLabel}
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
          />
        </div>
        <div
          aria-hidden
          data-testid={`${testId}-handle`}
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: `${pct}%`,
            width: 2,
            marginLeft: -1,
            background: "var(--cyan)",
            boxShadow: "0 0 0 1px rgba(0,0,0,0.35)",
          }}
        />
      </div>
      <div className="flex justify-between sc-meta" style={{ opacity: 0.75 }}>
        <span>{beforeLabel}</span>
        <span>{afterLabel}</span>
      </div>
    </div>
  );
}
