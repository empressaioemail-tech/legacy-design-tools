import type { CSSProperties } from "react";

const STATUS_ACCENT: Record<string, { bg: string; color: string }> = {
  active: { bg: "var(--cyan-accent-bg)", color: "var(--cyan)" },
  on_hold: { bg: "var(--warning-dim)", color: "var(--warning)" },
  archived: { bg: "var(--bg-input)", color: "var(--text-muted)" },
};

const BASE_STYLE: CSSProperties = {
  textTransform: "uppercase",
  fontSize: 11,
  letterSpacing: "0.05em",
  padding: "3px 8px",
  borderRadius: 4,
};

export interface StatusPillProps {
  status: string;
}

export function StatusPill({ status }: StatusPillProps) {
  const accent = STATUS_ACCENT[status] ?? STATUS_ACCENT.active;
  return (
    <span
      className="sc-pill"
      data-testid={`status-pill-${status}`}
      style={{
        ...BASE_STYLE,
        background: accent.bg,
        color: accent.color,
      }}
    >
      {status.replace("_", " ")}
    </span>
  );
}
