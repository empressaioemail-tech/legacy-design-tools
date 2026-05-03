/**
 * SheetsTab (PLR-7)
 *
 * Composes `SheetNavigatorRail` (left) + `SheetPreviewPane` (right)
 * for one submission. Auto-selects the first sheet on load. When the
 * submission has only one sheet the rail collapses (the preview pane
 * fills the tab).
 */
import { useEffect, useMemo, useState } from "react";
import {
  useListSubmissionSheets,
  type SheetSummary,
} from "@workspace/api-client-react";
import { SheetNavigatorRail } from "./SheetNavigatorRail";
import { SheetPreviewPane } from "./SheetPreviewPane";

export interface SheetsTabProps {
  submissionId: string;
}

export function SheetsTab({ submissionId }: SheetsTabProps) {
  const { data, isLoading, isError } = useListSubmissionSheets(submissionId);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const sheets = useMemo(() => data ?? [], [data]);

  useEffect(() => {
    if (sheets.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!selectedId || !sheets.some((s) => s.id === selectedId)) {
      setSelectedId(sheets[0]!.id);
    }
  }, [sheets, selectedId]);

  const selected: SheetSummary | null =
    sheets.find((s) => s.id === selectedId) ?? null;

  // Collapse the rail when the submission has a single sheet.
  const showRail = sheets.length > 1;

  if (isLoading && sheets.length === 0) {
    return (
      <div
        data-testid="sheets-tab-loading"
        style={{
          padding: 16,
          fontSize: 12,
          color: "var(--text-muted)",
        }}
      >
        Loading sheets…
      </div>
    );
  }

  if (isError) {
    return (
      <div
        data-testid="sheets-tab-error"
        style={{
          padding: 16,
          fontSize: 12,
          color: "var(--text-muted)",
        }}
      >
        Could not load sheets for this submission.
      </div>
    );
  }

  if (sheets.length === 0) {
    return (
      <div
        data-testid="sheets-tab-empty"
        style={{
          padding: 16,
          fontSize: 12,
          color: "var(--text-muted)",
        }}
      >
        No sheets ingested for this submission yet.
      </div>
    );
  }

  return (
    <div
      data-testid="sheets-tab"
      style={{
        display: "flex",
        flexDirection: "row",
        gap: 0,
        height: "min(70vh, 720px)",
        minHeight: 360,
      }}
    >
      {showRail && (
        <SheetNavigatorRail
          submissionId={submissionId}
          selectedSheetId={selectedId}
          onSelect={(s) => setSelectedId(s.id)}
        />
      )}
      <SheetPreviewPane sheet={selected} />
    </div>
  );
}
