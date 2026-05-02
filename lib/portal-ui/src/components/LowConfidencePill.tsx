export interface LowConfidencePillProps {
  confidence: number;
  testid?: string;
}

export function LowConfidencePill({
  confidence,
  testid = "low-confidence-pill",
}: LowConfidencePillProps) {
  const pct = Math.max(0, Math.min(100, Math.round(confidence * 100)));
  return (
    <span
      data-testid={testid}
      title={`Model confidence ${pct}%`}
      style={{
        background: "var(--warning-dim)",
        color: "var(--warning-text)",
        fontSize: 10,
        padding: "1px 6px",
        borderRadius: 3,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
      }}
    >
      Low conf
    </span>
  );
}
