const STATUS_ACCENT: Record<string, { bg: string; color: string }> = {
  active: { bg: "var(--cyan-accent-bg)", color: "var(--cyan)" },
  on_hold: { bg: "var(--warning-dim)", color: "var(--warning)" },
  archived: { bg: "var(--bg-input)", color: "var(--text-muted)" },
};

export function StatusPill({ status }: { status: string }) {
  const accent = STATUS_ACCENT[status] ?? STATUS_ACCENT.active;
  return (
    <span
      className="sc-pill"
      style={{
        background: accent.bg,
        color: accent.color,
        textTransform: "uppercase",
        fontSize: 11,
        letterSpacing: "0.05em",
        padding: "3px 8px",
        borderRadius: 4,
      }}
    >
      {status.replace("_", " ")}
    </span>
  );
}
