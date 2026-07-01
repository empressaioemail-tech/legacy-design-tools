import type { ReactNode } from "react";

export function TileWrapper({
  tileId,
  label,
  gridArea,
  children,
  onClose,
  onFullscreen,
}: {
  tileId: string;
  label: string;
  gridArea: string;
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
        border: "1px solid var(--border-subtle)",
        borderRadius: 8,
        overflow: "hidden",
        background: "var(--surface-1, var(--bg-base))",
        minHeight: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 8px",
          borderBottom: "1px solid var(--border-subtle)",
          background: "var(--bg-elevated)",
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
      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>{children}</div>
    </div>
  );
}

const chromeButtonStyle: React.CSSProperties = {
  border: "none",
  background: "transparent",
  cursor: "pointer",
  fontSize: 14,
  color: "var(--text-secondary)",
  padding: "2px 6px",
};
