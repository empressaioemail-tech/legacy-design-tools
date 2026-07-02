import type { CSSProperties, ReactNode } from "react";

export function TileWrapper({
  tileId,
  label,
  gridArea,
  fill = false,
  children,
  onClose,
  onFullscreen,
}: {
  tileId: string;
  label: string;
  gridArea: string;
  fill?: boolean;
  children: ReactNode;
  onClose: () => void;
  onFullscreen: () => void;
}) {
  return (
    <div
      data-testid={`tile-wrapper-${tileId}`}
      style={{
        gridArea,
        display: "flex",
        flexDirection: "column",
        border: "1px solid var(--h-border-subtle)",
        borderRadius: 8,
        overflow: "hidden",
        background: "var(--h-surface-1)",
        minHeight: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 8px",
          borderBottom: "1px solid var(--h-border-subtle)",
          background: "var(--h-surface-1)",
          cursor: "grab",
        }}
      >
        <span style={{ flex: 1, fontSize: 11, fontWeight: 600 }}>{label}</span>
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
      <div
        style={{
          flex: 1,
          overflow: fill ? "hidden" : "auto",
          minHeight: 0,
          display: fill ? "flex" : "block",
          flexDirection: fill ? "column" : undefined,
          position: "relative",
        }}
      >
        {children}
      </div>
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
