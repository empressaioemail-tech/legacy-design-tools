import { useState, type CSSProperties } from "react";
import { useEngagement } from "../../tile-shell/providers/EngagementProvider";
import { useSpatial } from "../../tile-shell/providers/SpatialProvider";
import { TileStatusBanner } from "../../tile-shell/components/TileStatusBanner";
import { runReport, getReport } from "../../lib/planReviewBff";

export default function TopographyTile() {
  const { engagementId, setEngagementReportResult } = useEngagement();
  const { pushOverlay } = useSpatial();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRun() {
    if (!engagementId) return;
    setBusy(true);
    setError(null);
    try {
      await runReport(engagementId, "topography");
      const report = await getReport(engagementId, "topography");
      setEngagementReportResult("topography", {
        status: report.status === "ok" ? "ok" : "error",
        result: report.result,
        error: report.error,
      });
      const geojson = (report.result as { contoursGeoJson?: { type: string; features: unknown[] } })
        ?.contoursGeoJson;
      if (geojson) {
        pushOverlay({
          id: "topography-contours",
          kind: "topography-contours",
          label: "Topography contours",
          geojson,
          opacity: 0.7,
        });
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Topography run failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <TileStatusBanner status="live" label="Topography" />
      <button
        type="button"
        data-testid="topography-run"
        disabled={!engagementId || busy}
        onClick={() => void handleRun()}
        style={runButtonStyle(!engagementId || busy)}
      >
        {busy ? "Running…" : "Run topography"}
      </button>
      {error ? <span style={{ fontSize: 12, color: "var(--danger-text)" }}>{error}</span> : null}
    </div>
  );
}

function runButtonStyle(disabled: boolean): CSSProperties {
  return {
    padding: "8px 14px",
    borderRadius: 6,
    border: "none",
    background: "var(--accent, var(--info-text))",
    color: "var(--accent-contrast, #fff)",
    fontSize: 12,
    fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    alignSelf: "flex-start",
  };
}
