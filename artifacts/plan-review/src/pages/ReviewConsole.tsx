import { useMemo, useState } from "react";
import { DashboardLayout } from "@workspace/portal-ui";
import { useNavGroups } from "../components/NavGroups";
import { KPIS, SUBMITTALS } from "../data/mock";
import { KpiTile } from "../components/KpiTile";
import { SubmittalQueueRow } from "../components/SubmittalQueueRow";
import { AIBriefingPanel } from "../components/AIBriefingPanel";

export default function ReviewConsole() {
  const navGroups = useNavGroups();
  const inReviewCount = SUBMITTALS.filter(s => s.status === "in-review").length;
  const aiWaitCount = SUBMITTALS.filter(s => s.status === "ai-review").length;
  const rejectedCount = SUBMITTALS.filter(s => s.status === "rejected").length;
  const queueCount = SUBMITTALS.length;

  const [searchQuery, setSearchQuery] = useState("");
  const trimmedQuery = searchQuery.trim().toLowerCase();
  const filteredSubmittals = useMemo(() => {
    if (!trimmedQuery) return SUBMITTALS;
    return SUBMITTALS.filter((s) => {
      const haystack = [
        s.id,
        s.projectName,
        s.address,
        s.firm,
        s.status,
        ...s.disciplines,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(trimmedQuery);
    });
  }, [trimmedQuery]);

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
        {/* Header Row */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-[22px] font-bold font-['Oxygen'] text-[var(--text-primary)]">Active submittals</h2>
            <div className="sc-body mt-1">
              {inReviewCount} in review · {aiWaitCount} awaiting AI · {rejectedCount} rejected
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button className="sc-btn-ghost">Export</button>
            <button className="sc-btn-primary">+ New review</button>
          </div>
        </div>

        {/* KPI Strip */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiTile label="AVG REVIEW TIME" value={KPIS.avgReviewTime.value} trend={KPIS.avgReviewTime.trend} trendLabel={KPIS.avgReviewTime.trendLabel} />
          <KpiTile label="AI ACCURACY" value={KPIS.aiAccuracy.value} trend={KPIS.aiAccuracy.trend} trendLabel={KPIS.aiAccuracy.trendLabel} />
          <KpiTile label="COMPLIANCE RATE" value={KPIS.complianceRate.value} trend={KPIS.complianceRate.trend} trendLabel={KPIS.complianceRate.trendLabel} />
          <KpiTile label="BACKLOG" value={KPIS.backlog.value} trend={KPIS.backlog.trend} trendLabel={KPIS.backlog.trendLabel} />
        </div>

        {/* Content Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
          <div className="lg:col-span-2 sc-card">
            <div className="sc-card-header sc-row-sb">
              <span className="sc-label">REVIEW QUEUE</span>
              <span className="sc-meta">
                {trimmedQuery
                  ? `${filteredSubmittals.length} of ${queueCount} items`
                  : `${queueCount} items`}
              </span>
            </div>
            <div className="flex flex-col" data-testid="review-queue">
              {SUBMITTALS.length === 0 ? (
                <div className="p-8 text-center sc-body">No new submittals. The AI Reviewer is monitoring Procore and Bluebeam intake.</div>
              ) : filteredSubmittals.length === 0 ? (
                <div
                  className="p-8 text-center sc-body"
                  data-testid="review-queue-no-matches"
                >
                  No submittals match “{searchQuery.trim()}”. Try a different
                  project, firm, address, or status.
                </div>
              ) : (
                filteredSubmittals.map(sub => (
                  <SubmittalQueueRow key={sub.id} submittal={sub} />
                ))
              )}
            </div>
          </div>

          <div className="space-y-4">
            <div className="sc-card">
              <div className="sc-card-header">
                <span className="sc-label">RECENT ACTIVITY</span>
              </div>
              <div className="flex flex-col">
                <div className="sc-card-row flex items-center gap-3">
                  <div className="sc-avatar-mark bg-[#6398AA] text-[#0f1318]">AI</div>
                  <div className="sc-body">AI Reviewer flagged 3 findings on Lost Pines Townhomes — Phase 2 · 4 min ago</div>
                </div>
                <div className="sc-card-row flex items-center gap-3">
                  <div className="sc-avatar-mark bg-[#6398AA] text-[#0f1318]">CD</div>
                  <div className="sc-body">Civic Design uploaded revised sheets for Old Iron Bridge Plaza · 2 hrs ago</div>
                </div>
                <div className="sc-card-row flex items-center gap-3">
                  <div className="sc-avatar-mark bg-[#6398AA] text-[#0f1318]">AI</div>
                  <div className="sc-body">AI Reviewer cleared 5 findings on Riverside Clinic — Phase 1 · 3 hrs ago</div>
                </div>
                <div className="sc-card-row flex items-center gap-3">
                  <div className="sc-avatar-mark bg-[#6398AA] text-[#0f1318]">SA</div>
                  <div className="sc-body">Studio Architecture replied to finding F-A2.04-001 · 5 hrs ago</div>
                </div>
                <div className="sc-card-row flex items-center gap-3">
                  <div className="sc-avatar-mark bg-[#6398AA] text-[#0f1318]">PR</div>
                  <div className="sc-body">Parks & Rec created new submittal Pecan Park Pavilion · 1 day ago</div>
                </div>
                <div className="sc-card-row flex items-center gap-3">
                  <div className="sc-avatar-mark bg-[#6398AA] text-[#0f1318]">AI</div>
                  <div className="sc-body">AI Reviewer flagged 8 findings on Main St. Adaptive Reuse · 1 day ago</div>
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
                    <div className="sc-medium truncate max-w-[180px]">Lost Pines Townhomes — Phase 2</div>
                  </div>
                  <div className="sc-mono-sm text-[var(--danger)]">Today</div>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="sc-dot sc-dot-amber"></div>
                    <div className="sc-medium truncate max-w-[180px]">Highland Estates Lot 7</div>
                  </div>
                  <div className="sc-mono-sm text-[var(--warning)]">Tomorrow</div>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="sc-dot sc-dot-green"></div>
                    <div className="sc-medium truncate max-w-[180px]">Old Iron Bridge Plaza</div>
                  </div>
                  <div className="sc-mono-sm text-[var(--text-secondary)]">Thu</div>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="sc-dot sc-dot-dim"></div>
                    <div className="sc-medium truncate max-w-[180px]">Riverside Clinic — Phase 1</div>
                  </div>
                  <div className="sc-mono-sm text-[var(--text-secondary)]">Fri</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
