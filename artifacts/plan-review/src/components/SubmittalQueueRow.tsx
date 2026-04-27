import { Link } from "wouter";
import { ChevronRight } from "lucide-react";
import { Submittal } from "../data/mock";
import { DisciplineBadge } from "./DisciplineBadge";

export function SubmittalQueueRow({ submittal }: { submittal: Submittal }) {
  // - Avatar (.sc-avatar-mark with firm initials, 20x20 rounded-square, color #6398AA)
  // - Project name (.sc-medium) + address (.sc-meta)
  // - Discipline badges (DisciplineBadge × N, max 3 visible, "+2" overflow)
  // - Status pill (sc-pill-* per status)
  // - Findings indicator: red dot + count if blocking > 0; cyan dot if AI is running; nothing if approved
  // - Progress bar (.sc-pb-track .sc-pb-fill, width = reviewProgress%, color = cyan if ai-review, amber if in-review, green if approved, red if rejected)
  // - Submitted time (.sc-mono-sm right-aligned)
  // - Right chevron (Lucide ChevronRight, 14px, --text-muted)

  const maxBadges = 2;
  const visibleBadges = submittal.disciplines.slice(0, maxBadges);
  const overflowCount = submittal.disciplines.length - maxBadges;

  let statusPillClass = "sc-pill-muted";
  if (submittal.status === "approved") statusPillClass = "sc-pill-green";
  else if (submittal.status === "rejected") statusPillClass = "sc-pill-red";
  else if (submittal.status === "in-review") statusPillClass = "sc-pill-amber";
  else if (submittal.status === "ai-review") statusPillClass = "sc-pill-cyan";
  else if (submittal.status === "draft") statusPillClass = "sc-pill-muted";
  
  let statusText = submittal.status.replace("-", " ");

  let indicator = null;
  if (submittal.status === "ai-review") {
    indicator = <div className="sc-dot sc-dot-cyan sc-dot-pulse" title="AI running"></div>;
  } else if (submittal.blockingCount > 0) {
    indicator = (
      <div className="flex items-center gap-1.5" title={`${submittal.blockingCount} blocking findings`}>
        <div className="sc-dot sc-dot-red"></div>
        <span className="text-[10px] font-medium text-[var(--danger)]">{submittal.blockingCount}</span>
      </div>
    );
  }

  let progressColor = "bg-[var(--text-muted)]";
  if (submittal.status === "ai-review") progressColor = "bg-[var(--cyan)]";
  else if (submittal.status === "in-review") progressColor = "bg-[var(--warning)]";
  else if (submittal.status === "approved") progressColor = "bg-[var(--success)]";
  else if (submittal.status === "rejected") progressColor = "bg-[var(--danger)]";

  const dateStr = new Date(submittal.submittedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  return (
    <Link href={`/submittals/${submittal.id}`} className="sc-card-row flex items-center gap-3 no-underline">
      <div className="sc-avatar-mark shrink-0" style={{ background: "#6398AA", color: "#0f1318" }}>
        {submittal.firmInitials}
      </div>

      <div className="flex flex-col min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <div className="sc-medium truncate">{submittal.projectName}</div>
          <span className={`sc-pill ${statusPillClass} capitalize shrink-0`}>{statusText}</span>
        </div>
        <div className="flex items-center gap-2 mt-1 min-w-0">
          <div className="flex items-center gap-1 shrink-0">
            {visibleBadges.map((d) => (
              <DisciplineBadge key={d} discipline={d} />
            ))}
            {overflowCount > 0 && (
              <span className="sc-meta">+{overflowCount}</span>
            )}
          </div>
          <span className="sc-meta truncate">· {dateStr}</span>
        </div>
      </div>

      <div className="w-6 flex items-center justify-center shrink-0">
        {indicator}
      </div>

      <div className="w-20 shrink-0">
        <div className="sc-pb-track">
          <div className={`sc-pb-fill ${progressColor}`} style={{ width: `${submittal.reviewProgress}%` }}></div>
        </div>
      </div>

      <ChevronRight size={14} className="text-[var(--text-muted)] shrink-0" />
    </Link>
  );
}
