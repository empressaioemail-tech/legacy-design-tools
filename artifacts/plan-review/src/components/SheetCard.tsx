import {
  getGetAtomSummaryQueryKey,
  useGetAtomSummary,
  type AtomHistoryEvent,
  type AtomSummary,
  type SheetSummary,
} from "@workspace/api-client-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { relativeTime } from "../lib/relativeTime";
import { Clock, FileText, History } from "lucide-react";

interface SheetCardProps {
  sheet: SheetSummary;
  /**
   * Recent history events for this sheet, supplied by the parent's
   * snapshot-scoped batch query (`useGetSnapshotSheetHistory`). Pass
   * `null` while the batch is loading or when no events are available;
   * the card hides its mini-timeline rather than rendering a placeholder
   * row, matching the behavior from when each card fetched its own
   * history.
   */
  historyEvents: AtomHistoryEvent[] | null;
}

/**
 * Mini-timeline cap. Two rows is the most we can show inline without
 * crowding the card; the popover surfaces a richer list (up to
 * `TIMELINE_HISTORY_LIMIT`).
 */
const TIMELINE_INLINE_COUNT = 2;
/**
 * Per-sheet page size for the snapshot-scoped batch history query. Kept
 * in this module so the parent page and the card agree on the cap
 * without duplicating the constant.
 */
export const TIMELINE_HISTORY_LIMIT = 5;

export function SheetCard({ sheet, historyEvents }: SheetCardProps) {
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

  const events = historyEvents ?? [];

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
      {events.length > 0 && (
        <RecentActivityTimeline sheetId={sheet.id} events={events} />
      )}
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

interface RecentActivityTimelineProps {
  sheetId: string;
  events: AtomHistoryEvent[];
}

/**
 * Inline mini-timeline at the bottom of the sheet card. Shows the
 * most-recent two events with relative timestamps; clicking the
 * "Show more" trigger opens a popover with the full page (up to
 * `TIMELINE_HISTORY_LIMIT`).
 *
 * Hidden entirely when `events` is empty (caller-enforced) so older
 * sheets without recorded history fall back to the "First ingested" chip
 * alone.
 */
function RecentActivityTimeline(props: RecentActivityTimelineProps) {
  const { sheetId, events } = props;
  const inline = events.slice(0, TIMELINE_INLINE_COUNT);
  const hasMore = events.length > TIMELINE_INLINE_COUNT;

  return (
    <div
      data-testid={`sheet-card-timeline-${sheetId}`}
      style={{
        borderTop: "1px solid var(--border-default)",
        paddingTop: 6,
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      {inline.map((evt) => (
        <TimelineRow key={evt.id} event={evt} />
      ))}
      {hasMore ? (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="sc-meta"
              data-testid={`sheet-card-timeline-more-${sheetId}`}
              style={{
                alignSelf: "flex-start",
                background: "transparent",
                border: "none",
                padding: "2px 0",
                color: "var(--cyan-text, var(--text-secondary))",
                fontSize: 11,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <History size={11} />
              <span>Show {events.length - inline.length} more</span>
            </button>
          </PopoverTrigger>
          <PopoverContent
            side="bottom"
            align="start"
            className="w-80"
            data-testid={`sheet-card-timeline-popover-${sheetId}`}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div
                className="sc-label"
                style={{ fontSize: 11, color: "var(--text-secondary)" }}
              >
                RECENT ACTIVITY
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {events.map((evt) => (
                  <ExpandedTimelineRow key={evt.id} event={evt} />
                ))}
              </div>
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}

function TimelineRow({ event }: { event: AtomHistoryEvent }) {
  const absolute = formatAbsolute(event.occurredAt);
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            data-testid={`timeline-row-${event.id}`}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              fontSize: 11,
              lineHeight: "16px",
              cursor: "default",
            }}
          >
            <span
              style={{
                color: "var(--text-secondary)",
                fontFamily: "ui-monospace, monospace",
                whiteSpace: "nowrap",
              }}
            >
              {prettyEventType(event.eventType)}
            </span>
            <span
              style={{
                color: "var(--text-muted)",
                whiteSpace: "nowrap",
              }}
            >
              {relativeTime(event.occurredAt)}
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="left" align="start">
          <div style={{ fontSize: 11, lineHeight: "16px", maxWidth: 280 }}>
            <div>
              <strong>{event.eventType}</strong>
            </div>
            <div style={{ marginTop: 2 }}>{absolute}</div>
            <div style={{ marginTop: 2 }}>
              by {event.actor.kind}:{event.actor.id}
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ExpandedTimelineRow({ event }: { event: AtomHistoryEvent }) {
  return (
    <div
      data-testid={`timeline-expanded-row-${event.id}`}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 1,
        fontSize: 11,
        lineHeight: "16px",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span
          style={{
            color: "var(--text-primary)",
            fontFamily: "ui-monospace, monospace",
          }}
        >
          {event.eventType}
        </span>
        <span
          style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}
          title={formatAbsolute(event.occurredAt)}
        >
          {relativeTime(event.occurredAt)}
        </span>
      </div>
      <div style={{ color: "var(--text-secondary)", fontSize: 10 }}>
        by {event.actor.kind}:{event.actor.id}
      </div>
    </div>
  );
}

function prettyEventType(type: string): string {
  // `sheet.created` → `created`. The slug is implicit on the card.
  const dot = type.indexOf(".");
  return dot >= 0 ? type.slice(dot + 1) : type;
}

function formatAbsolute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleString()} (${d.toISOString()})`;
}
