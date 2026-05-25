import { RefreshCw } from "lucide-react";
import type { JurisdictionSummary, WarmupStatus } from "@workspace/api-client-react";
import { coverageStatusLabel } from "../../lib/coverageUi";

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.round(ms / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

export interface ActiveBook {
  jurisdictionKey: string;
  codeBook: string;
  edition: string;
  label: string;
}

export function JurisdictionCard({
  section = "firm",
  j,
  isActive,
  activeBook,
  liveStatus,
  isWarming,
  warmupMsg,
  coverageStatus,
  onSelect,
  onWarmup,
  onSelectBook,
}: {
  section?: "active" | "firm" | "explore";
  j: JurisdictionSummary;
  isActive: boolean;
  activeBook: ActiveBook | null;
  liveStatus?: WarmupStatus;
  isWarming: boolean;
  warmupMsg: string;
  coverageStatus?: string;
  onSelect: () => void;
  onWarmup: (e: React.MouseEvent) => void;
  onSelectBook: (book: ActiveBook, e: React.MouseEvent) => void;
}) {
  return (
    <div
      data-testid={`jurisdiction-card-${section}-${j.key}`}
      className="sc-card p-4 flex flex-col gap-3 cursor-pointer"
      style={{
        borderColor: isActive ? "var(--cyan)" : "var(--border-default)",
        borderWidth: isActive ? 2 : 1,
        borderStyle: "solid",
        borderRadius: 6,
      }}
      onClick={onSelect}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="sc-medium">{j.displayName}</div>
        <div className="flex items-center gap-2">
          {coverageStatus && coverageStatus !== "ready" && (
            <span
              className="sc-meta"
              data-testid={`coverage-badge-${section}-${j.key}`}
              style={{
                fontSize: 9,
                padding: "2px 6px",
                borderRadius: 3,
                background: "rgba(180, 140, 40, 0.18)",
                color: "#b48c28",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
            >
              {coverageStatusLabel(coverageStatus)}
            </span>
          )}
          <div className="sc-meta opacity-60">{j.key}</div>
        </div>
      </div>
      <div className="flex items-baseline gap-4">
        <div>
          <div className="text-2xl">{j.atomCount}</div>
          <div className="sc-meta opacity-60">atoms</div>
        </div>
        <div>
          <div className="text-2xl">{j.embeddedCount}</div>
          <div className="sc-meta opacity-60">embedded</div>
        </div>
        <div className="ml-auto sc-meta opacity-60">
          Last fetched {relativeTime(j.lastFetchedAt)}
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {j.books.map((b) => {
          const isBookActive =
            activeBook?.jurisdictionKey === j.key &&
            activeBook?.codeBook === b.codeBook &&
            activeBook?.edition === b.edition;
          return (
            <button
              key={`${b.codeBook}|${b.edition}`}
              type="button"
                      data-testid={`book-pill-${section}-${j.key}-${b.codeBook}`}
              title={`${b.label} via ${b.sourceName} — click to browse`}
              onClick={(e) =>
                onSelectBook(
                  {
                    jurisdictionKey: j.key,
                    codeBook: b.codeBook,
                    edition: b.edition,
                    label: b.label,
                  },
                  e,
                )
              }
              style={{
                background: isBookActive
                  ? "var(--cyan)"
                  : "rgba(99, 152, 170, 0.15)",
                color: isBookActive ? "var(--text-inverse)" : "var(--cyan-text)",
                fontSize: 10,
                padding: "2px 6px",
                borderRadius: 3,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                border: "none",
                cursor: "pointer",
              }}
            >
              {b.label} · {b.atomCount}
            </button>
          );
        })}
      </div>
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="sc-btn-secondary inline-flex items-center gap-1"
          disabled={isWarming}
          onClick={onWarmup}
          style={{ fontSize: 11, padding: "4px 8px" }}
          data-testid={`warmup-btn-${section}-${j.key}`}
        >
          <RefreshCw size={12} className={isWarming ? "animate-spin" : ""} />
          {isWarming ? "Warming up…" : "Warm up now"}
        </button>
        {isWarming && liveStatus && liveStatus.total > 0 && (
          <div
            className="sc-meta opacity-80"
            data-testid={`warmup-progress-${section}-${j.key}`}
          >
            Warming up: {liveStatus.completed} / {liveStatus.total} sections
            processed
            {liveStatus.processing > 0 &&
              ` (${liveStatus.processing} in flight)`}
          </div>
        )}
        {!isWarming && warmupMsg && (
          <div
            className="sc-meta opacity-80 max-w-[60%] text-right"
            data-testid={`warmup-msg-${section}-${j.key}`}
          >
            {warmupMsg}
          </div>
        )}
      </div>
      {!isWarming &&
        liveStatus &&
        liveStatus.state === "failed" &&
        liveStatus.lastError && (
          <div
            className="alert-block warning"
            data-testid={`warmup-error-${section}-${j.key}`}
            style={{ fontSize: 11, padding: "6px 8px", borderRadius: 3 }}
          >
            Last error: {liveStatus.lastError}
          </div>
        )}
    </div>
  );
}
