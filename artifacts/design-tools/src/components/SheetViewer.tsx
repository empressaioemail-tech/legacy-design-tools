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
      className="cockpit-sheet-lightbox"
    >
      <div className="cockpit-sheet-lightbox-header">
        <div className="cockpit-sheet-lightbox-title">
          <span className="sc-label">{sheet.sheetNumber}</span>
          <span
            className="cockpit-sheet-lightbox-name"
            title={sheet.sheetName}
          >
            {sheet.sheetName}
          </span>
        </div>
        <div className="cockpit-sheet-lightbox-zoom">
          {Math.round(zoom * 100)}%
        </div>
        <div className="cockpit-sheet-lightbox-actions">
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
            className="cockpit-sheet-lightbox-close"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="cockpit-sheet-lightbox-body">
        {status === "loading" && (
          <div className="cockpit-sheet-lightbox-status">
            Loading sheet…
          </div>
        )}
        {status === "error" && (
          <div className="cockpit-sheet-lightbox-error">
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
          onTransform={(ref: ReactZoomPanPinchRef) =>
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
              onLoad={() => setStatus("loaded")}
              onError={() => setStatus("error")}
              draggable={false}
              className="cockpit-sheet-lightbox-img"
              data-loaded={status === "loaded" ? "true" : "false"}
            />
          </TransformComponent>
        </TransformWrapper>
      </div>
    </div>
  );
}
