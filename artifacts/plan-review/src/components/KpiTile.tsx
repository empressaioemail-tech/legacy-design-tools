import { ArrowUp, ArrowDown } from "lucide-react";

/**
 * KPI tile. Omit `trend` + `trendLabel` to render a "no data yet"
 * placeholder caption in place of the trend chip.
 */
export function KpiTile({
  label,
  value,
  trend,
  trendLabel,
}: {
  label: string;
  value: string;
  trend?: "up" | "down";
  trendLabel?: string;
}) {
  return (
    <div className="sc-card p-4" data-testid={`kpi-tile-${label}`}>
      <div className="sc-label mb-2">{label}</div>
      <div className="sc-kpi-md mb-1">{value}</div>
      <div className="flex items-center gap-1">
        {trend ? (
          <>
            {trend === "up" ? (
              <ArrowUp className="w-3 h-3 text-[var(--success-text)]" />
            ) : (
              <ArrowDown className="w-3 h-3 text-[var(--success-text)]" />
            )}
            <span className="sc-meta lowercase">{trendLabel}</span>
          </>
        ) : (
          <span
            className="sc-meta lowercase opacity-60"
            data-testid={`kpi-tile-${label}-no-data`}
          >
            no data yet
          </span>
        )}
      </div>
    </div>
  );
}
