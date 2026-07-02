import type React from "react";
import type { TileCategory, TileStatus } from "../tile-shell/types";
import { PlannedTile, TileStatusBanner } from "@hauska/tile-shell";

export type StubTileMeta = {
  id: string;
  label: string;
  category: TileCategory;
  status: TileStatus;
  degradedReason?: string;
};

const disabledRunStyle: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 6,
  border: "1px solid var(--border-subtle)",
  background: "var(--bg-elevated)",
  color: "var(--text-muted)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "not-allowed",
  opacity: 0.6,
  alignSelf: "flex-start",
};

/** Factory for registry entries that mount a PlannedTile or status banner stub. */
export function makeStubTile(meta: StubTileMeta): () => React.ReactElement {
  return function StubTile() {
    if (meta.status === "planned") {
      return <PlannedTile id={meta.id} label={meta.label} category={meta.category} />;
    }

    const showDisabledRun =
      meta.status === "degraded" || meta.status === "partial";

    return (
      <div
        data-testid={`stub-tile-${meta.id}`}
        style={{
          padding: 12,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          height: "100%",
        }}
      >
        <TileStatusBanner
          status={meta.status}
          label={meta.label}
          reason={meta.degradedReason}
        />
        {showDisabledRun ? (
          <button type="button" disabled style={disabledRunStyle}>
            Run
          </button>
        ) : null}
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
          {meta.label} — shell registered; full tile UI pending.
        </p>
      </div>
    );
  };
}
