import { useEffect, useRef, useState } from "react";
import {
  TransformWrapper,
  TransformComponent,
  type ReactZoomPanPinchRef,
} from "react-zoom-pan-pinch";
import { X } from "lucide-react";
import type { SheetSummary } from "@workspace/api-client-react";

interface SheetViewerProps {
  sheet: SheetSummary | null;
  onClose: () => void;
  onAskClaude: (sheet: SheetSummary) => void;
}

type LoadStatus = "loading" | "loaded" | "error";

export function SheetViewer({ sheet, onClose, onAskClaude }: SheetViewerProps) {
  const [zoom, setZoom] = useState(1);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const imgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    if (!sheet) return;
    setZoom(1);
    setStatus("loading");
    setReloadKey(0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet, onClose]);

  useEffect(() => {
    if (!sheet) return;
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth > 0) {
      setStatus("loaded");
    }
  });

  useEffect(() => {
    if (!sheet || status !== "loading") return;
    const t = window.setTimeout(() => {
      setStatus((s) => (s === "loading" ? "error" : s));
    }, 10000);
    return () => window.clearTimeout(t);
  }, [sheet, status, reloadKey]);

  if (!sheet) return null;

  const baseUrl = `${import.meta.env.BASE_URL}api/sheets/${sheet.id}/full.png`;
  const fullUrl = reloadKey > 0 ? `${baseUrl}?r=${reloadKey}` : baseUrl;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Sheet ${sheet.sheetNumber} ${sheet.sheetName}`}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        background: "rgba(8,12,18,0.95)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          height: 60,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 16px",
          borderBottom: "1px solid var(--border-default)",
          background: "var(--bg-card)",
          gap: 12,
        }}
      >
        <div className="flex items-center gap-3" style={{ minWidth: 0 }}>
          <span className="sc-label">{sheet.sheetNumber}</span>
          <span
            className="sc-medium"
            style={{
              color: "var(--text-primary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={sheet.sheetName}
          >
            {sheet.sheetName}
          </span>
        </div>
        <div className="sc-meta opacity-70" style={{ minWidth: 56, textAlign: "center" }}>
          {Math.round(zoom * 100)}%
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="sc-btn-sm"
            onClick={() => onAskClaude(sheet)}
          >
            Ask Claude about this sheet
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close sheet viewer"
            title="Close (Esc)"
            style={{
              width: 28,
              height: 28,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              background: "transparent",
              border: "1px solid var(--border-default)",
              color: "var(--text-secondary)",
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {status === "loading" && (
          <div
            className="sc-prose"
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              opacity: 0.7,
              pointerEvents: "none",
            }}
          >
            Loading sheet…
          </div>
        )}
        {status === "error" && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              zIndex: 1,
            }}
          >
            <div className="sc-prose" style={{ opacity: 0.8 }}>
              Couldn't load this sheet.
            </div>
            <button
              type="button"
              className="sc-btn-sm"
              onClick={() => {
                setStatus("loading");
                setReloadKey((k) => k + 1);
              }}
            >
              Reload
            </button>
          </div>
        )}
        <TransformWrapper
          initialScale={1}
          minScale={0.25}
          maxScale={8}
          wheel={{ step: 0.2 }}
          doubleClick={{ disabled: false, mode: "reset" }}
          onTransformed={(ref: ReactZoomPanPinchRef) =>
            setZoom(ref.state.scale)
          }
        >
          <TransformComponent
            wrapperStyle={{ width: "100%", height: "100%" }}
            contentStyle={{
              width: "100%",
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <img
              ref={imgRef}
              src={fullUrl}
              alt={`${sheet.sheetNumber} ${sheet.sheetName}`}
              onLoad={() => {
                console.log("[SheetViewer] onLoad", sheet.id);
                setStatus("loaded");
              }}
              onError={() => {
                console.log("[SheetViewer] onError", sheet.id);
                setStatus("error");
              }}
              draggable={false}
              style={{
                maxWidth: "calc(100vw - 32px)",
                maxHeight: "calc(100vh - 60px - 32px)",
                objectFit: "contain",
                background: "white",
                opacity: status === "loaded" ? 1 : 0,
                transition: "opacity 0.2s ease-out",
                userSelect: "none",
              }}
            />
          </TransformComponent>
        </TransformWrapper>
      </div>
    </div>
  );
}
