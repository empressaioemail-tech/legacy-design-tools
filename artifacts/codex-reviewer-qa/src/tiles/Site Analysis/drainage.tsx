import { useState } from "react";
import { useEngagement } from "../../tile-shell/providers/EngagementProvider";
import { useSpatial } from "../../tile-shell/providers/SpatialProvider";
import { TileStatusBanner } from "../../tile-shell/components/TileStatusBanner";
import { runReport, getReport } from "../../lib/planReviewBff";

export default function DrainageTile() {
  const { engagementId, setEngagementReportResult } = useEngagement();
  const { pushOverlay } = useSpatial();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRun() {
    if (!engagementId) return;
    setBusy(true);
    setError(null);
    try {
      await runReport(engagementId, "drainage");
      const report = await getReport(engagementId, "drainage");
      setEngagementReportResult("drainage", {
        status: report.status === "ok" ? "ok" : "error",
        result: report.result,
      });
      const result = report.result as {
        flowLinesGeoJson?: { type: string; features: unknown[] };
        drainageZonesGeoJson?: { type: string; features: unknown[] };
      };
      if (result?.flowLinesGeoJson) {
        pushOverlay({
          id: "drainage-flow",
          kind: "hydrology-flow",
          label: "Drainage flow lines",
          geojson: result.flowLinesGeoJson,
        });
      }
      if (result?.drainageZonesGeoJson) {
        pushOverlay({
          id: "drainage-zones",
          kind: "drainage-zones",
          label: "Drainage zones",
          geojson: result.drainageZonesGeoJson,
          opacity: 0.4,
        });
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Drainage run failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <TileStatusBanner status="live" label="Drainage" />
      <button
        type="button"
        data-testid="drainage-run"
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
        {busy ? "Running…" : "Run drainage"}
      </button>
      {error ? <span style={{ fontSize: 12, color: "var(--danger-text)" }}>{error}</span> : null}
    </div>
  );
}
