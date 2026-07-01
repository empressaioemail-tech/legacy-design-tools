import { useState } from "react";
import { useEngagement } from "../../tile-shell/providers/EngagementProvider";
import { useSpatial } from "../../tile-shell/providers/SpatialProvider";
import { TileStatusBanner } from "../../tile-shell/components/TileStatusBanner";
import { runReport, getReport } from "../../lib/planReviewBff";

export default function HydrologyTile() {
  const { engagementId, setEngagementReportResult } = useEngagement();
  const { pushOverlay } = useSpatial();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRun() {
    if (!engagementId) return;
    setBusy(true);
    setError(null);
    try {
      await runReport(engagementId, "hydrology");
      const report = await getReport(engagementId, "hydrology");
      setEngagementReportResult("hydrology", {
        status: report.status === "ok" ? "ok" : "error",
        result: report.result,
        error: report.error,
      });
      const flowLines = (report.result as { flowLinesGeoJson?: { type: string; features: unknown[] } })
        ?.flowLinesGeoJson;
      if (flowLines) {
        pushOverlay({
          id: "hydrology-flow",
          kind: "hydrology-flow",
          label: "Hydrology flow lines",
          geojson: flowLines,
        });
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Hydrology run failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <TileStatusBanner
        status="degraded"
        label="Hydrology"
        reason="pysheds not installed in Cloud Run worker."
      />
      <button
        type="button"
        data-testid="hydrology-run"
        disabled={!engagementId || busy}
        onClick={() => void handleRun()}
        style={{
          padding: "8px 14px",
          borderRadius: 6,
          border: "none",
          background: "var(--accent, var(--info-text))",
          color: "var(--accent-contrast, #fff)",
          fontSize: 12,
          fontWeight: 600,
          cursor: !engagementId || busy ? "not-allowed" : "pointer",
          opacity: !engagementId || busy ? 0.5 : 1,
          alignSelf: "flex-start",
        }}
      >
        {busy ? "Running…" : "Run hydrology"}
      </button>
      {error ? <span style={{ fontSize: 12, color: "var(--danger-text)" }}>{error}</span> : null}
    </div>
  );
}
