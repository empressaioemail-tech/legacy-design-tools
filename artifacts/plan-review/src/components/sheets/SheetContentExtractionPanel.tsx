import { useQueryClient } from "@tanstack/react-query";
import {
  useGetSheetContentExtraction,
  getGetSheetContentExtractionQueryKey,
  useTriggerSheetContentExtraction,
  type SheetSummary,
  type SheetStructuredAnnotation,
} from "@workspace/api-client-react";

/**
 * Cortex L2a (Lane C.4 / C.4.2) — sheet-content-extraction panel.
 *
 * Plan-review (reviewer) side: surfaces the structured extracted
 * content for the selected sheet alongside the sheet image — OCR text
 * segments plus structured annotations (revision clouds, dimensions,
 * schedule rows, callouts). A "Run extraction" affordance triggers the
 * extraction pass, co-designed with cc-agent-M's
 * `cortex_sheet_content_extraction_*` MCP tools (same atom, same
 * endpoint).
 */

const ANNOTATION_KIND_LABELS: Record<
  SheetStructuredAnnotation["kind"],
  string
> = {
  "revision-cloud": "Revision cloud",
  dimension: "Dimension",
  "schedule-row": "Schedule row",
  callout: "Callout",
};

export function SheetContentExtractionPanel({
  sheet,
}: {
  sheet: SheetSummary;
}) {
  const qc = useQueryClient();
  const { data, isLoading } = useGetSheetContentExtraction(sheet.id, {
    query: {
      enabled: !!sheet.id,
      queryKey: getGetSheetContentExtractionQueryKey(sheet.id),
    },
  });

  const trigger = useTriggerSheetContentExtraction({
    mutation: {
      onSuccess: async () => {
        await qc.invalidateQueries({
          queryKey: getGetSheetContentExtractionQueryKey(sheet.id),
        });
      },
    },
  });

  const extraction = data?.sheetContentExtraction ?? null;
  const busy = trigger.isPending;

  return (
    <div
      className="sc-card"
      data-testid="sheet-content-extraction-panel"
      style={{ display: "flex", flexDirection: "column" }}
    >
      <div
        className="sc-card-header sc-row-sb"
        style={{ display: "flex", alignItems: "center" }}
      >
        <span className="sc-label">EXTRACTED CONTENT</span>
        <button
          type="button"
          className="sc-btn-ghost sc-btn-sm"
          disabled={busy}
          data-testid="sheet-content-extraction-run"
          onClick={() => trigger.mutate({ sheetId: sheet.id })}
        >
          {busy
            ? "Extracting…"
            : extraction
              ? "Re-run extraction"
              : "Run extraction"}
        </button>
      </div>

      <div className="p-4" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {isLoading ? (
          <div
            className="sc-meta"
            data-testid="sheet-content-extraction-loading"
            style={{ color: "var(--text-muted)" }}
          >
            Loading extracted content…
          </div>
        ) : !extraction ? (
          <div
            className="sc-meta"
            data-testid="sheet-content-extraction-empty"
            style={{ color: "var(--text-muted)" }}
          >
            This sheet has not been extracted yet. Run the extraction
            pass to classify its OCR text and structured annotations.
          </div>
        ) : (
          <>
            <div
              className="sc-meta"
              data-testid="sheet-content-extraction-meta"
              style={{ color: "var(--text-muted)" }}
            >
              {extraction.extractedTextSegments.length} text segment
              {extraction.extractedTextSegments.length === 1 ? "" : "s"} ·{" "}
              {extraction.structuredAnnotations.length} annotation
              {extraction.structuredAnnotations.length === 1 ? "" : "s"} ·
              OCR model {extraction.ocrModel}
            </div>

            {extraction.extractedTextSegments.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span className="sc-label" style={{ color: "var(--text-secondary)" }}>
                  TEXT SEGMENTS
                </span>
                {extraction.extractedTextSegments.map((seg, i) => (
                  <div
                    key={i}
                    data-testid={`sheet-content-segment-${i}`}
                    style={{
                      background: "var(--bg-input)",
                      border: "1px solid var(--border-default)",
                      borderRadius: 4,
                      padding: "8px 10px",
                      fontSize: 12,
                      color: "var(--text-primary)",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {seg.text}
                  </div>
                ))}
              </div>
            )}

            {extraction.structuredAnnotations.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span className="sc-label" style={{ color: "var(--text-secondary)" }}>
                  STRUCTURED ANNOTATIONS
                </span>
                {extraction.structuredAnnotations.map((ann, i) => (
                  <div
                    key={i}
                    data-testid={`sheet-content-annotation-${i}`}
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "baseline",
                      fontSize: 12,
                    }}
                  >
                    <span
                      style={{
                        flexShrink: 0,
                        padding: "1px 6px",
                        borderRadius: 999,
                        background: "var(--info-dim)",
                        color: "var(--info-text)",
                        fontSize: 10,
                        fontWeight: 600,
                        textTransform: "uppercase",
                      }}
                    >
                      {ANNOTATION_KIND_LABELS[ann.kind] ?? ann.kind}
                    </span>
                    <span style={{ color: "var(--text-primary)" }}>
                      {ann.content}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
