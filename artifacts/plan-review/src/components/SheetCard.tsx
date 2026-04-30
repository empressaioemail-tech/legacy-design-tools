import {
  getGetAtomSummaryQueryKey,
  useGetAtomSummary,
  type SheetSummary,
  type AtomSummary,
} from "@workspace/api-client-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";
import { relativeTime } from "../lib/relativeTime";
import { Clock, FileText } from "lucide-react";

interface SheetCardProps {
  sheet: SheetSummary;
}

export function SheetCard({ sheet }: SheetCardProps) {
  const { data: summary, isLoading, isError } = useGetAtomSummary(
    "sheet",
    sheet.id,
    undefined,
    {
      query: {
        queryKey: getGetAtomSummaryQueryKey("sheet", sheet.id),
        staleTime: 30_000,
      },
    },
  );

  return (
    <div
      className="sc-card"
      data-testid={`sheet-card-${sheet.id}`}
      style={{
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          <FileText
            size={14}
            className="text-[var(--cyan)] mt-0.5 flex-shrink-0"
          />
          <div className="min-w-0">
            <div
              className="sc-medium"
              style={{ color: "var(--text-primary)", fontSize: 13 }}
            >
              {sheet.sheetNumber}
            </div>
            <div
              className="sc-meta truncate"
              title={sheet.sheetName}
              style={{ color: "var(--text-secondary)", fontSize: 11 }}
            >
              {sheet.sheetName}
            </div>
          </div>
        </div>
        <FirstIngestedChip
          isLoading={isLoading}
          isError={isError}
          summary={summary ?? null}
          fallbackSnapshotId={sheet.snapshotId}
        />
      </div>
    </div>
  );
}

interface FirstIngestedChipProps {
  isLoading: boolean;
  isError: boolean;
  summary: AtomSummary | null;
  fallbackSnapshotId: string;
}

function FirstIngestedChip(props: FirstIngestedChipProps) {
  const { isLoading, isError, summary, fallbackSnapshotId } = props;

  if (isLoading) return <PlainChip label="Loading…" />;
  if (isError || !summary) return <PlainChip label="Unavailable" />;

  const { latestEventId, latestEventAt } = summary.historyProvenance;
  if (!latestEventId) {
    return (
      <PlainChip
        label="Not tracked"
        tooltip="No history events recorded yet for this sheet."
      />
    );
  }

  const date = new Date(latestEventAt);
  const typedSnapshotId = summary.typed["snapshotId"];
  const snapshotId =
    typeof typedSnapshotId === "string" && typedSnapshotId.length > 0
      ? typedSnapshotId
      : fallbackSnapshotId;
  const absolute = `${date.toLocaleString()} (${date.toISOString()})`;

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="sc-chip"
            data-testid="first-ingested-chip"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 8px",
              borderRadius: 999,
              border: "1px solid var(--border-default)",
              background: "var(--bg-input)",
              color: "var(--text-secondary)",
              fontSize: 11,
              lineHeight: "16px",
              cursor: "default",
              whiteSpace: "nowrap",
            }}
          >
            <Clock size={11} />
            <span>First ingested {relativeTime(latestEventAt)}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="left" align="start">
          <div style={{ fontSize: 11, lineHeight: "16px", maxWidth: 320 }}>
            <div>
              <strong>First ingested:</strong> {absolute}
            </div>
            <div style={{ marginTop: 2 }}>
              <strong>Snapshot:</strong>{" "}
              <span
                style={{
                  fontFamily: "ui-monospace, monospace",
                  wordBreak: "break-all",
                }}
              >
                {snapshotId}
              </span>
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function PlainChip({ label, tooltip }: { label: string; tooltip?: string }) {
  const chip = (
    <span
      className="sc-chip"
      data-testid="first-ingested-chip"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 8px",
        borderRadius: 999,
        border: "1px solid var(--border-default)",
        background: "var(--bg-input)",
        color: "var(--text-muted)",
        fontSize: 11,
        lineHeight: "16px",
        whiteSpace: "nowrap",
        cursor: tooltip ? "help" : "default",
      }}
    >
      <Clock size={11} />
      <span>{label}</span>
    </span>
  );

  if (!tooltip) return chip;

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>{chip}</TooltipTrigger>
        <TooltipContent side="left" align="start">
          <div style={{ fontSize: 11, lineHeight: "16px", maxWidth: 320 }}>
            {tooltip}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
