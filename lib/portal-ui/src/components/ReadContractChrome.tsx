import type { ReadContract } from "@workspace/api-client-react";

type WidthedConfidence = ReadContract["axes"]["calibratedConfidence"];
type CalibrationProvenance = WidthedConfidence["provenance"];
const PROVENANCE_LABEL: Record<CalibrationProvenance, string> = {
  asserted: "Asserted",
  backtest: "Backtest",
  seed: "Seed",
  live: "Live-earned",
};

const STRATUM_LABEL: Record<
  ReadContract["axes"]["consequence"]["stratum"],
  string
> = {
  routine: "Routine",
  elevated: "Elevated",
  critical: "Critical",
  essential: "Essential",
};

function formatEstimate(c: WidthedConfidence): number {
  return Math.round((c.estimate as number) * 100);
}

function formatWidth(c: WidthedConfidence): string {
  const half = (c.intervalWidth * 100) / 2;
  const center = formatEstimate(c);
  const lo = Math.max(0, Math.round(center - half));
  const hi = Math.min(100, Math.round(center + half));
  return `${lo}–${hi}%`;
}

function hasRenderableConfidence(c: WidthedConfidence): boolean {
  return (
    Number.isFinite(c.estimate as number) &&
    Number.isFinite(c.intervalWidth) &&
    c.intervalWidth > 0 &&
    !!c.provenance
  );
}

export function ReadContractChrome({
  readContract,
  testIdPrefix = "read-contract",
  showConsequence = true,
}: {
  readContract: ReadContract | null | undefined;
  testIdPrefix?: string;
  showConsequence?: boolean;
}) {
  if (!readContract) return null;

  const primary = readContract.axes.calibratedConfidence;
  if (!hasRenderableConfidence(primary)) return null;

  const pct = formatEstimate(primary);
  const widthLabel = formatWidth(primary);
  const provenanceLabel = PROVENANCE_LABEL[primary.provenance];
  const thin = primary.n < 1;
  const stratum = readContract.axes.consequence.stratum;

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
      {thin ? (
        <span
          data-testid={`${testIdPrefix}-thin-signal`}
          title="Thin calibration signal — interval widened"
          style={{
            background: "var(--warning-dim)",
            color: "var(--warning-text)",
            padding: "1px 6px",
            borderRadius: 3,
            textTransform: "uppercase",
          }}
        >
          Thin signal
        </span>
      ) : null}
      <span
        data-testid={`${testIdPrefix}-confidence`}
        title={`${provenanceLabel} ${widthLabel} (n=${primary.n})`}
        style={{
          background:
            primary.provenance === "live"
              ? "var(--cyan-accent-bg)"
              : "var(--border-subtle)",
          color:
            primary.provenance === "live"
              ? "var(--cyan)"
              : "var(--text-secondary)",
          padding: "1px 6px",
          borderRadius: 3,
        }}
      >
        {provenanceLabel} {widthLabel}
      </span>
      <span
        data-testid={`${testIdPrefix}-estimate`}
        className="sc-meta"
        style={{ opacity: 0.75 }}
        aria-hidden
      >
        {pct}% ±{(primary.intervalWidth * 100) / 2 | 0}%
      </span>
      {showConsequence && stratum !== "routine" ? (
        <span
          data-testid={`${testIdPrefix}-consequence`}
          className="sc-meta"
          style={{ opacity: 0.65 }}
        >
          {STRATUM_LABEL[stratum]} consequence
        </span>
      ) : null}
      <span
        data-testid={`${testIdPrefix}-assembled`}
        className="sc-meta"
        style={{ opacity: 0.45 }}
      >
        n={primary.n}
      </span>
    </div>
  );
}