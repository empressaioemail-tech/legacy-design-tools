import { FINDINGS } from "../data/mock";
import { FindingCard } from "./FindingCard";

export function AIBriefingPanel() {
  const recentFindings = [...FINDINGS].sort((a, b) => new Date(b.identifiedAt).getTime() - new Date(a.identifiedAt).getTime()).slice(0, 5);

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-[var(--border-default)]">
        <div className="flex items-center gap-2 mb-2">
          <div className="sc-label">AI REVIEWER</div>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 2 L21.5 7 L21.5 17 L12 22 L2.5 17 L2.5 7 Z" fill="#22d3ee" />
          </svg>
          <div className="sc-dot sc-dot-cyan sc-dot-pulse ml-auto"></div>
        </div>
        <div className="sc-body">Reviewing 3 active submittals · 7 findings open</div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 sc-scroll flex flex-col gap-4">
        {recentFindings.map(f => (
          <FindingCard key={f.id} finding={f} />
        ))}
      </div>

      <div className="p-4 border-t border-[var(--border-default)] bg-[var(--depth-header-bg)] flex flex-col gap-2 shrink-0">
        <div className="sc-label mb-1">SUGGESTIONS</div>
        <div className="sc-card sc-card-clickable px-3 py-2">
          <div className="sc-body">Show all blocking findings on Lost Pines Townhomes</div>
        </div>
        <div className="sc-card sc-card-clickable px-3 py-2">
          <div className="sc-body">Compare egress findings across active submittals</div>
        </div>
        <div className="sc-card sc-card-clickable px-3 py-2">
          <div className="sc-body">Summarize today's AI Reviewer activity</div>
        </div>
      </div>
    </div>
  );
}
