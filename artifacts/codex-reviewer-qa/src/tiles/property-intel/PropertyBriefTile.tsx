import { useState, type CSSProperties } from "react";
import { useEngagement } from "../../tile-shell/providers/EngagementProvider";
import { TileStatusBanner } from "../../tile-shell/components/TileStatusBanner";
import { getReport, runReport } from "../../lib/planReviewBff";

const runButtonStyle = (disabled: boolean): CSSProperties => ({
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
});

async function pollReport(
  engagementId: string,
  type: string,
  attempts = 12,
): Promise<{ status: string; result?: unknown; error?: string }> {
  for (let i = 0; i < attempts; i++) {
    const report = await getReport(engagementId, type);
    if (report.status !== "running") return report;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { status: "running" };
}

export default function PropertyBriefTile() {
  const { engagementId } = useEngagement();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(null);

  async function handleRun() {
    if (!engagementId) return;
    setBusy(true);
    setError(null);
    try {
      await runReport(engagementId, "property-brief");
      const report = await pollReport(engagementId, "property-brief");
      if (report.status === "error") {
        setError(report.error ?? "Property brief generation failed");
        return;
      }
      if (report.status === "running") {
        setError("Brief still generating — try again shortly.");
        return;
      }
      if (report.status === "not-run") {
        setError("No briefing sources yet — ensure engagement is geocoded.");
        return;
      }
      setResult(report.result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Property brief run failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ReportTileShell
      label="Property Brief"
      engagementId={engagementId}
      busy={busy}
      error={error}
      onRun={() => void handleRun()}
      result={result}
      emptyHint="Run property brief to fetch site context, parcel layers, and narrative sections."
    />
  );
}

export function ReportTileShell(props: {
  label: string;
  engagementId: string | null;
  busy: boolean;
  error: string | null;
  onRun: () => void;
  result: unknown;
  emptyHint: string;
  runLabel?: string;
  quotaBanner?: string | null;
}) {
  const {
    label,
    engagementId,
    busy,
    error,
    onRun,
    result,
    emptyHint,
    runLabel = "Run report",
    quotaBanner,
  } = props;

  return (
    <div
      style={{
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        overflow: "auto",
        height: "100%",
      }}
    >
      <TileStatusBanner status="live" label={label} />
      {!engagementId ? (
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
          Select a case first.
        </p>
      ) : (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={onRun}
            style={runButtonStyle(!engagementId || busy)}
          >
            {busy ? "Running…" : runLabel}
          </button>
          {quotaBanner ? (
            <div
              role="status"
              style={{ fontSize: 12, color: "var(--warning-text, #b8860b)" }}
            >
              {quotaBanner}
            </div>
          ) : null}
          {error ? (
            <div role="alert" style={{ fontSize: 12, color: "var(--danger-text)" }}>
              {error}
            </div>
          ) : null}
          {result ? (
            <details open style={{ fontSize: 12 }}>
              <summary style={{ cursor: "pointer", marginBottom: 6 }}>
                Result (collapsible JSON)
              </summary>
              <pre
                style={{
                  margin: 0,
                  padding: 8,
                  background: "var(--bg-elevated)",
                  borderRadius: 6,
                  overflow: "auto",
                  maxHeight: 280,
                  fontSize: 11,
                }}
              >
                {JSON.stringify(result, null, 2)}
              </pre>
            </details>
          ) : (
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
              {emptyHint}
            </p>
          )}
        </>
      )}
    </div>
  );
}
