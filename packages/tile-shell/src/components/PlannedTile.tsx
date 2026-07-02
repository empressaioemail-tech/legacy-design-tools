import { TileStatusBanner } from "./TileStatusBanner";
import type { TileCategory } from "../types";

export function PlannedTile({
  id,
  label,
  category,
}: {
  id: string;
  label: string;
  category: TileCategory;
}) {
  return (
    <div
      data-testid={`planned-tile-${id}`}
      style={{
        padding: "var(--h-space-md)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--h-space-sm)",
        height: "100%",
      }}
    >
      <TileStatusBanner
        status="planned"
        label={label}
        reason="Not yet built — see cortex-reporting dispatch spec"
      />
      <span
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--h-text-muted)",
        }}
      >
        {category}
      </span>
      <h3 style={{ margin: 0, fontSize: 15 }}>{label}</h3>
      <p style={{ margin: 0, fontSize: 12, color: "var(--h-text-muted)" }}>
        Planned — not yet built. Spec reference: tile id{" "}
        <code>{id}</code> in the cortex function registry.
      </p>
    </div>
  );
}
