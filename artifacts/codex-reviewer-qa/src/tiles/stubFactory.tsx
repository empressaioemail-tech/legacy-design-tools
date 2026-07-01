import { PlannedTile } from "../tile-shell/components/PlannedTile";
import { TILE_REGISTRY } from "../tile-shell/tiles";
import { TileStatusBanner } from "../tile-shell/components/TileStatusBanner";

/** Factory for registry entries that mount a PlannedTile or status banner stub. */
export function makeStubTile(id: string) {
  const def = () => TILE_REGISTRY[id];
  return function StubTile() {
    const tile = def();
    if (!tile) return <PlannedTile id={id} />;
    if (tile.status === "planned") return <PlannedTile id={id} />;
    return (
      <div style={{ padding: 12 }}>
        <TileStatusBanner
          status={tile.status}
          label={tile.label}
          reason={tile.degradedReason}
        />
        <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {tile.label} — shell registered; full tile UI pending.
        </p>
      </div>
    );
  };
}
