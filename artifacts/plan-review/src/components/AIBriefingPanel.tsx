export function AIBriefingPanel() {
  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-[var(--border-default)]">
        <div className="flex items-center gap-2 mb-2">
          <div className="sc-label">AI REVIEWER</div>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M12 2 L21.5 7 L21.5 17 L12 22 L2.5 17 L2.5 7 Z"
              fill="#22d3ee"
            />
          </svg>
        </div>
        <div className="sc-body">
          Open a submission and run AI plan-review to surface findings here.
        </div>
      </div>

      <div
        className="flex-1 overflow-y-auto p-4 sc-scroll flex items-center justify-center text-center"
        data-testid="ai-briefing-panel-empty"
      >
        <div className="sc-body" style={{ color: "var(--text-secondary)" }}>
          No recent AI activity.
        </div>
      </div>
    </div>
  );
}
