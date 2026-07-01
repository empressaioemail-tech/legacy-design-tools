import { useEffect, useState } from "react";
import { useEngagement } from "../../tile-shell/providers/EngagementProvider";
import { TileStatusBanner } from "../../tile-shell/components/TileStatusBanner";
import {
  extractEngagementSheets,
  fetchEngagementSheets,
  type PlanReviewSheetWire,
} from "../../lib/planReviewBff";

export default function SheetExtractionTile() {
  const { engagementId } = useEngagement();
  const [sheets, setSheets] = useState<PlanReviewSheetWire[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (!engagementId) {
      setSheets([]);
      setSelectedId(null);
      return;
    }
    let cancelled = false;
    fetchEngagementSheets(engagementId)
      .then((res) => {
        if (cancelled) return;
        setSheets(res.sheets);
        setSelectedId(res.sheets[0]?.sheetId ?? null);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setSheets([]);
          setError(err instanceof Error ? err.message : "Failed to load sheets");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [engagementId]);

  async function handleExtract() {
    if (!engagementId) return;
    setBusy(true);
    setError(null);
    try {
      await extractEngagementSheets(engagementId);
      const res = await fetchEngagementSheets(engagementId);
      setSheets(res.sheets);
      if (res.sheets.length === 0) {
        setError("No sheets found — upload a snapshot with sheet PNGs first.");
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Sheet extraction failed");
    } finally {
      setBusy(false);
    }
  }

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
      <TileStatusBanner status="live" label="Sheet Extraction" />
      {!engagementId ? (
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
          Select a case first.
        </p>
      ) : sheets.length === 0 ? (
        <>
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
            No extracted sheets yet.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleExtract()}
            style={btnStyle(busy)}
          >
            {busy ? "Extracting…" : "Extract sheets"}
          </button>
        </>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 6 }}>
          {sheets.map((s) => (
            <li key={s.sheetId}>
              <button
                type="button"
                onClick={() => setSelectedId(s.sheetId)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: 8,
                  borderRadius: 6,
                  border:
                    selectedId === s.sheetId
                      ? "1px solid var(--accent, var(--info-text))"
                      : "1px solid var(--border-subtle)",
                  background: "var(--bg-elevated)",
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                <strong>{s.label || "Sheet"}</strong> — p.{s.pageNumber}
                {s.contentBody ? " · extracted" : ""}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <div role="alert" style={{ fontSize: 12, color: "var(--danger-text)" }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

function btnStyle(disabled: boolean) {
  return {
    padding: "8px 14px",
    borderRadius: 6,
    border: "none",
    background: "var(--accent, var(--info-text))",
    color: "var(--accent-contrast, #fff)",
    fontSize: 12,
    fontWeight: 600,
    cursor: disabled ? "wait" : "pointer",
    alignSelf: "flex-start" as const,
    opacity: disabled ? 0.7 : 1,
  };
}
