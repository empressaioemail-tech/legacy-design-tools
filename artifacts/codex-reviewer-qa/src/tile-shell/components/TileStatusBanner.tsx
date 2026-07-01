import type { TileStatus } from "../types";

export function TileStatusBanner({
  status,
  label,
  reason,
}: {
  status: TileStatus;
  label: string;
  reason?: string;
}) {
  if (status === "live") return null;

  const tone =
    status === "planned"
      ? { bg: "var(--text-muted)", text: "var(--bg-base)" }
      : status === "partial"
        ? { bg: "var(--warning-dim)", text: "var(--warning-text)" }
        : { bg: "var(--danger-dim)", text: "var(--danger-text)" };

  const statusLabel =
    status === "planned"
      ? "Planned"
      : status === "partial"
        ? "Partial"
        : "Degraded";

  return (
    <div
      data-testid="tile-status-banner"
      role="status"
      style={{
        fontSize: 11,
        padding: "6px 10px",
        borderRadius: 6,
        marginBottom: 8,
        background: tone.bg,
        color: tone.text,
      }}
    >
      <strong>{label}</strong> — {statusLabel}
      {reason ? `: ${reason}` : ""}
    </div>
  );
}
