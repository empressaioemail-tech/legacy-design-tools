import { TILE_REGISTRY } from "../tiles";
import { TileStatusBanner } from "./TileStatusBanner";

export function PlannedTile({ id }: { id: string }) {
  const def = TILE_REGISTRY[id];
  const label = def?.label ?? id;

  return (
    <div
      data-testid={`planned-tile-${id}`}
      style={{
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        height: "100%",
      }}
    >
      <TileStatusBanner
        status="planned"
        label={label}
        reason="Not yet built — see cortex-reporting dispatch spec"
      />
      <h3 style={{ margin: 0, fontSize: 15 }}>{label}</h3>
      <p style={{ margin: 0, fontSize: 12, color: "var(--text-secondary)" }}>
        Planned — not yet built. Spec reference: tile id{" "}
        <code>{id}</code> in the cortex function registry.
      </p>
    </div>
  );
}
