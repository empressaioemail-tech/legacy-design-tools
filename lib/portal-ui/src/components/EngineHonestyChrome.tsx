import type { ReadContract as AtomReadContract } from "@hauska/atom-contract/read-contract";
import type { ReadContract as WireReadContract } from "@workspace/api-client-react";
import { ReadContractChrome } from "./ReadContractChrome";
import { legacyHonestyToReadContract } from "@workspace/engine-core";

export type EngineHonestySource = {
  adapter: string;
  citationIds?: string[];
};

/** @deprecated Migrate callers to {@link ReadContract} wire field. */
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

/**
 * F4 — renders read-contract widthed confidence. Accepts readContract
 * directly or legacy EngineHonesty (converted at render boundary).
 */
export function EngineHonestyChrome({
  honesty,
  readContract,
  testIdPrefix = "engine-honesty",
}: {
  /** @deprecated Use readContract */
  honesty?: EngineHonesty | null;
  readContract?: WireReadContract | AtomReadContract | null;
  testIdPrefix?: string;
}) {
  const contract: WireReadContract | null =
    (readContract as WireReadContract | null | undefined) ??
    (honesty
      ? (legacyHonestyToReadContract(honesty) as unknown as WireReadContract)
      : null);
  if (!contract) return null;

  const vintage = honesty ? formatDataVintage(honesty.dataVintage) : null;
  const citationCount = honesty?.source.citationIds?.length ?? 0;
  const adapter = honesty?.source.adapter;

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
      <ReadContractChrome readContract={contract} testIdPrefix={testIdPrefix} />
      {honesty?.coverage.degraded ? (
        <span
          data-testid={`${testIdPrefix}-coverage-degraded`}
          title={honesty.coverage.reason ?? "Partial or web-grounded coverage"}
          style={{
            background: "var(--warning-dim)",
            color: "var(--warning-text)",
            padding: "1px 6px",
            borderRadius: 3,
            fontSize: 10,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
          }}
        >
          {honesty.coverage.reason === "web-grounded" ||
          honesty.coverage.reason?.includes("web")
            ? "Web-grounded"
            : "Partial coverage"}
        </span>
      ) : null}
      {vintage ? (
        <span
          data-testid={`${testIdPrefix}-data-vintage`}
          className="sc-meta"
          style={{ opacity: 0.75, fontSize: 10 }}
        >
          Data as of {vintage}
        </span>
      ) : null}
      {adapter ? (
        <span
          data-testid={`${testIdPrefix}-source`}
          className="sc-meta"
          style={{ opacity: 0.55, fontSize: 10 }}
        >
          via {adapter}
          {citationCount > 0 ? ` · ${citationCount} cited` : ""}
        </span>
      ) : null}
    </div>
  );
}
