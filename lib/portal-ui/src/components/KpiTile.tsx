import type { ReactNode } from "react";

export interface KpiTileProps {
  label: string;
  value: number | string | null | undefined;
  footnote?: ReactNode;
  /**
   * Optional testid override. Defaults to
   * `kpi-tile-{lowercased-label}` so consumers can target individual
   * tiles deterministically without relying on visible text or order.
   */
  testId?: string;
}

export function KpiTile({ label, value, footnote, testId }: KpiTileProps) {
  const resolvedTestId = testId ?? `kpi-tile-${label.toLowerCase()}`;
  return (
    <div className="sc-card p-4" data-testid={resolvedTestId}>
      <div className="sc-label">{label}</div>
      <div className="sc-kpi-md mt-2" data-testid={`${resolvedTestId}-value`}>
        {value ?? "—"}
      </div>
      {footnote && <div className="sc-meta mt-1 opacity-70">{footnote}</div>}
    </div>
  );
}
