import { useMemo, useState } from "react";
import { DashboardLayout } from "@workspace/portal-ui";
import {
  useListReviewerQueue,
  getListReviewerQueueQueryKey,
  type ReviewerKpiMetric,
  type ReviewerQueueResponse,
} from "@workspace/api-client-react";
import { useNavGroups } from "../components/NavGroups";
import { KpiTile } from "../components/KpiTile";
import { AIBriefingPanel } from "../components/AIBriefingPanel";
import {
  ReviewerQueueList,
  filterReviewerQueueItems,
} from "../components/ReviewerQueueList";

/**
 * Reviewer Inbox at `/`. Reads the cross-engagement queue from
 * `GET /api/reviewer/queue`. Row click deep-links to the AIR-2
 * submission-detail modal in EngagementDetail.
 */

function formatHours(value: number): string {
  if (value < 1) {
    const minutes = Math.max(1, Math.round(value * 60));
    return `${minutes}m`;
  }
  if (value < 10) return `${value.toFixed(1)}h`;
  return `${Math.round(value)}h`;
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

function kpiTileProps(
  metric: ReviewerKpiMetric | undefined,
  format: (v: number) => string,
): {
  value: string;
  trend?: "up" | "down";
  trendLabel?: string;
} {
  if (!metric || metric.value == null) return { value: "—" };
  const props: {
    value: string;
    trend?: "up" | "down";
    trendLabel?: string;
  } = { value: format(metric.value) };
  if (metric.trend && metric.trendLabel) {
    props.trend = metric.trend;
    props.trendLabel = metric.trendLabel;
  }
  return props;
}

export default function ReviewConsole() {
  const navGroups = useNavGroups();

  const { data, isLoading, isError, error } = useListReviewerQueue(undefined, {
    query: { queryKey: getListReviewerQueueQueryKey() },
  });
  const queue: ReviewerQueueResponse | undefined = data;

  const items = queue?.items ?? [];
  const counts = queue?.counts;
  const kpis = queue?.kpis;

  const [searchQuery, setSearchQuery] = useState("");
  const trimmedQuery = searchQuery.trim();
  const filteredItems = useMemo(
    () => filterReviewerQueueItems(items, trimmedQuery),
    [items, trimmedQuery],
  );

  const queueCount = items.length;

  // When the queue request hasn't returned successful counts yet
  // (still loading, or any non-2xx — including the audience-mismatch
  // 403), render "—" placeholders for the in review / awaiting AI /
  // rejected counters instead of silently rendering 0. The architect
  // who just submitted should be able to tell at a glance that the
  // tiles haven't loaded vs. that the queue is genuinely empty.
  const inReview = counts != null ? String(counts.inReview) : "—";
  const awaitingAi = counts != null ? String(counts.awaitingAi) : "—";
  const rejected = counts != null ? String(counts.rejected) : "—";
  // Render the dash while loading so the tile doesn't flash from "—"
  // to "0" to a real value on the second pass.
  const backlogValue =
    counts != null ? String(counts.backlog) : "—";

  return (
    <DashboardLayout
      title="Review Console"
      navGroups={navGroups}
      brandLabel="SMARTCITY OS"
      brandProductName="Plan Review"
      rightPanel={<AIBriefingPanel />}
      search={{
        placeholder: "Search submittals...",
        value: searchQuery,
        onChange: setSearchQuery,
      }}
    >
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-[22px] font-bold font-['Oxygen'] text-[var(--text-primary)]">
              Active submittals
            </h2>
            <div className="sc-body mt-1" data-testid="review-console-summary">
              {inReview} in review · {awaitingAi} awaiting AI · {rejected}{" "}
              rejected
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button className="sc-btn-ghost">Export</button>
            <button className="sc-btn-primary">+ New review</button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiTile
            label="AVG REVIEW TIME"
            {...kpiTileProps(kpis?.avgReviewTime, formatHours)}
          />
          <KpiTile
            label="AI ACCURACY"
            {...kpiTileProps(kpis?.aiAccuracy, formatPercent)}
          />
          <KpiTile
            label="COMPLIANCE RATE"
            {...kpiTileProps(kpis?.complianceRate, formatPercent)}
          />
          <KpiTile label="BACKLOG" value={backlogValue} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
          <div className="lg:col-span-2 sc-card">
            <div className="sc-card-header sc-row-sb">
              <span className="sc-label">REVIEW QUEUE</span>
              <span className="sc-meta">
                {trimmedQuery
                  ? `${filteredItems.length} of ${queueCount} items`
                  : `${queueCount} items`}
              </span>
            </div>
            <div className="flex flex-col" data-testid="review-queue">
              <ReviewerQueueList
                items={items}
                isLoading={isLoading}
                isError={isError}
                error={error}
                searchQuery={searchQuery}
              />
            </div>
          </div>

          <div className="space-y-4">
            <div className="sc-card">
              <div className="sc-card-header">
                <span className="sc-label">RECENT ACTIVITY</span>
              </div>
              <div className="flex flex-col">
                <div className="sc-card-row flex items-center gap-3">
                  <div className="sc-avatar-mark bg-[#6398AA] text-[#0f1318]">
                    AI
                  </div>
                  <div className="sc-body">
                    AI Reviewer flagged 3 findings on Lost Pines Townhomes
                    — Phase 2 · 4 min ago
                  </div>
                </div>
                <div className="sc-card-row flex items-center gap-3">
                  <div className="sc-avatar-mark bg-[#6398AA] text-[#0f1318]">
                    CD
                  </div>
                  <div className="sc-body">
                    Civic Design uploaded revised sheets for Old Iron
                    Bridge Plaza · 2 hrs ago
                  </div>
                </div>
                <div className="sc-card-row flex items-center gap-3">
                  <div className="sc-avatar-mark bg-[#6398AA] text-[#0f1318]">
                    AI
                  </div>
                  <div className="sc-body">
                    AI Reviewer cleared 5 findings on Riverside Clinic —
                    Phase 1 · 3 hrs ago
                  </div>
                </div>
              </div>
            </div>

            <div className="sc-card">
              <div className="sc-card-header">
                <span className="sc-label">DUE THIS WEEK</span>
              </div>
              <div className="flex flex-col p-4 gap-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="sc-dot sc-dot-red"></div>
                    <div className="sc-medium truncate max-w-[180px]">
                      Lost Pines Townhomes — Phase 2
                    </div>
                  </div>
                  <div className="sc-mono-sm text-[var(--danger)]">Today</div>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="sc-dot sc-dot-amber"></div>
                    <div className="sc-medium truncate max-w-[180px]">
                      Highland Estates Lot 7
                    </div>
                  </div>
                  <div className="sc-mono-sm text-[var(--warning)]">
                    Tomorrow
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="sc-dot sc-dot-green"></div>
                    <div className="sc-medium truncate max-w-[180px]">
                      Old Iron Bridge Plaza
                    </div>
                  </div>
                  <div className="sc-mono-sm text-[var(--text-secondary)]">
                    Thu
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
