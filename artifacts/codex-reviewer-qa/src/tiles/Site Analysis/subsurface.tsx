import { useState } from "react";
import { useEngagement } from "../../tile-shell/providers/EngagementProvider";
import { TileStatusBanner } from "../../tile-shell/components/TileStatusBanner";
import { runReport, getReport } from "../../lib/planReviewBff";

export default function SubsurfaceTile() {
  const { engagementId, setEngagementReportResult } = useEngagement();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleRun() {
    if (!engagementId) return;
    setBusy(true);
    setError(null);
    try {
      await runReport(engagementId, "subsurface");
      const report = await getReport(engagementId, "subsurface");
      if (report.status === "unavailable") {
        setError(
          (report.result as { reason?: string })?.reason ??
            "USDA endpoint unreachable",
        );
        setEngagementReportResult("subsurface", {
          status: "error",
          error: "unavailable",
          result: report.result,
        });
        return;
      }
      setResult(report.result);
      setEngagementReportResult("subsurface", {
        status: report.status === "ok" ? "ok" : "error",
        result: report.result,
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Subsurface run failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <TileStatusBanner
        status="partial"
        label="Subsurface Suitability"
        reason="SSURGO ECONNRESET — USDA TLS issue."
      />
      <button
        type="button"
        data-testid="subsurface-run"
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
        {busy ? "Running…" : "Run SSURGO subsurface"}
      </button>
      {error ? <span style={{ fontSize: 12, color: "var(--danger-text)" }}>{error}</span> : null}
      {result ? (
        <pre
          style={{
            fontSize: 10,
            overflow: "auto",
            maxHeight: 160,
            background: "var(--bg-elevated)",
            padding: 8,
            borderRadius: 4,
          }}
        >
          {JSON.stringify(result, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}
