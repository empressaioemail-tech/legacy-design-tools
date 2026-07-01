import { TILE_CATEGORIES, TILE_REGISTRY } from "../tiles";
import type { TileStatus } from "../types";

const STATUS_DOT: Record<TileStatus, string> = {
  live: "#22c55e",
  degraded: "var(--danger-text, #f87171)",
  partial: "var(--warning-text, #fbbf24)",
  planned: "var(--text-muted, #94a8b8)",
};

const STATUS_LABEL: Record<TileStatus, string> = {
  live: "Live",
  degraded: "Degraded",
  partial: "Partial",
  planned: "Planned",
};

export function TilePicker({
  open,
  activeTiles,
  onClose,
  onToggleTile,
  liveStatuses,
}: {
  open: boolean;
  activeTiles: string[];
  onClose: () => void;
  onToggleTile: (id: string) => void;
  liveStatuses?: Record<string, TileStatus>;
}) {
  if (!open) return null;

  return (
    <aside
      data-testid="tile-picker"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        bottom: 0,
        width: 320,
        zIndex: 50,
        background: "var(--bg-elevated)",
        borderRight: "1px solid var(--border-subtle)",
        boxShadow: "4px 0 24px rgba(0,0,0,0.15)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "12px 16px",
          borderBottom: "1px solid var(--border-subtle)",
        }}
      >
        <span style={{ flex: 1, fontWeight: 700, fontSize: 14 }}>
          All Functions
        </span>
        <button type="button" onClick={onClose} style={{ fontSize: 12 }}>
          Close
        </button>
      </div>
      <div style={{ overflow: "auto", flex: 1, padding: 12 }}>
        {TILE_CATEGORIES.map((category) => {
          const tiles = Object.values(TILE_REGISTRY).filter(
            (t) => t.category === category,
          );
          return (
            <section key={category} style={{ marginBottom: 16 }}>
              <h3
                style={{
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  color: "var(--text-muted)",
                  margin: "0 0 8px",
                }}
              >
                {category}
              </h3>
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {tiles.map((tile) => {
                  const status =
                    liveStatuses?.[tile.id] ?? tile.status;
                  const active = activeTiles.includes(tile.id);
                  return (
                    <li key={tile.id} style={{ marginBottom: 4 }}>
                      <button
                        type="button"
                        data-testid={`picker-tile-${tile.id}`}
                        onClick={() => onToggleTile(tile.id)}
                        style={{
                          width: "100%",
                          textAlign: "left",
                          padding: "8px 10px",
                          borderRadius: 6,
                          border: active
                            ? "1px solid var(--accent)"
                            : "1px solid var(--border-subtle)",
                          background: active
                            ? "var(--info-dim)"
                            : "transparent",
                          cursor: "pointer",
                          fontSize: 12,
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                        }}
                      >
                        <span
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: "50%",
                            background: STATUS_DOT[status],
                            flexShrink: 0,
                          }}
                          aria-hidden
                        />
                        <span style={{ flex: 1 }}>{tile.label}</span>
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 600,
                            color: STATUS_DOT[status],
                            textTransform: "uppercase",
                            letterSpacing: "0.04em",
                          }}
                        >
                          {STATUS_LABEL[status]}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </aside>
  );
}
