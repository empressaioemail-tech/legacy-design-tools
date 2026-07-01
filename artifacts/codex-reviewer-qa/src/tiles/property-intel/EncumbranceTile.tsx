import { useState } from "react";
import { useEngagement } from "../../tile-shell/providers/EngagementProvider";
import { getReport, runReport } from "../../lib/planReviewBff";
import { ReportTileShell } from "./PropertyBriefTile";

export default function EncumbranceTile() {
  const { engagementId } = useEngagement();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(null);

  async function handleRun() {
    if (!engagementId) return;
    setBusy(true);
    setError(null);
    try {
      await runReport(engagementId, "encumbrances");
      const report = await getReport(engagementId, "encumbrances");
      if (report.status === "not-run") {
        setError(
          "No encumbrances on file — upload CC&R or deed restriction PDFs via the engagement encumbrance route.",
        );
        setResult(null);
        return;
      }
      setResult(report.result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Encumbrance load failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ReportTileShell
      label="Encumbrance Report"
      engagementId={engagementId}
      busy={busy}
      error={error}
      onRun={() => void handleRun()}
      result={result}
      runLabel="Load encumbrances"
      emptyHint="Load liens, deed restrictions, and CC&Rs stored against this engagement."
    />
  );
}
