export type EngineHonestySource = {
  adapter: string;
  citationIds?: string[];
};

export type EngineHonesty = {
  confidence: {
    value: number;
    kind: "calibrated" | "asserted" | "deterministic";
  };
  dataVintage: string | null;
  coverage: { degraded: boolean; reason?: string };
  source: EngineHonestySource;
};

export type { EngineHonesty as EngineHonestyWire };

const CONFIDENCE_KIND_LABEL: Record<
  EngineHonesty["confidence"]["kind"],
  string
> = {
  calibrated: "Calibrated confidence",
  asserted: "Asserted confidence",
  deterministic: "Deterministic",
};

function formatDataVintage(dataVintage: string | null): string | null {
  if (!dataVintage) return null;
  const d = new Date(dataVintage);
  if (Number.isNaN(d.getTime())) return dataVintage;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function EngineHonestyChrome({
  honesty,
  testIdPrefix = "engine-honesty",
}: {
  honesty: EngineHonesty | null | undefined;
  testIdPrefix?: string;
}) {
  if (!honesty) return null;

  const pct = Math.max(
    0,
    Math.min(100, Math.round(honesty.confidence.value * 100)),
  );
  const vintage = formatDataVintage(honesty.dataVintage);
  const kindLabel = CONFIDENCE_KIND_LABEL[honesty.confidence.kind];
  const citationCount = honesty.source.citationIds?.length ?? 0;

  return (
    <div
      data-testid={testIdPrefix}
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        alignItems: "center",
        fontSize: 10,
        letterSpacing: "0.04em",
      }}
    >
      {honesty.coverage.degraded ? (
        <span
          data-testid={`${testIdPrefix}-coverage-degraded`}
          title={honesty.coverage.reason ?? "Partial or web-grounded coverage"}
          style={{
            background: "var(--warning-dim)",
            color: "var(--warning-text)",
            padding: "1px 6px",
            borderRadius: 3,
            textTransform: "uppercase",
          }}
        >
          {honesty.coverage.reason === "web-grounded" ||
          honesty.coverage.reason?.includes("web")
            ? "Web-grounded"
            : "Partial coverage"}
        </span>
      ) : null}
      <span
        data-testid={`${testIdPrefix}-confidence-kind`}
        title={`${kindLabel} — ${pct}%`}
        style={{
          background:
            honesty.confidence.kind === "asserted"
              ? "var(--border-subtle)"
              : "var(--cyan-accent-bg)",
          color:
            honesty.confidence.kind === "asserted"
              ? "var(--text-secondary)"
              : "var(--cyan)",
          padding: "1px 6px",
          borderRadius: 3,
        }}
      >
        {kindLabel} {pct}%
      </span>
      {vintage ? (
        <span
          data-testid={`${testIdPrefix}-data-vintage`}
          className="sc-meta"
          style={{ opacity: 0.75 }}
        >
          Data as of {vintage}
        </span>
      ) : null}
      <span
        data-testid={`${testIdPrefix}-source`}
        className="sc-meta"
        style={{ opacity: 0.55 }}
      >
        via {honesty.source.adapter}
        {citationCount > 0 ? ` · ${citationCount} cited` : ""}
      </span>
    </div>
  );
}
