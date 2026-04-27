import { Finding } from "../data/mock";
import { DisciplineBadge } from "./DisciplineBadge";

export function FindingCard({ finding }: { finding: Finding }) {
  // - alert-block (color matches severity): .sc-medium title, .sc-body detail, .sc-ref code citation, small .sc-meta source-edition (e.g., "IBC 2021")
  let alertClass = "info";
  if (finding.severity === "blocking") alertClass = "critical";
  else if (finding.severity === "warning") alertClass = "warning";

  let severityPillClass = "sc-pill-blue";
  if (finding.severity === "blocking") severityPillClass = "sc-pill-red";
  else if (finding.severity === "warning") severityPillClass = "sc-pill-amber";

  const dateStr = new Date(finding.identifiedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  
  return (
    <div className={`sc-card p-0 ${finding.severity === "blocking" ? "sc-accent-red" : finding.severity === "warning" ? "sc-accent-amber" : "sc-accent-cyan"}`}>
      <div className="sc-card-header flex items-center justify-between">
        <DisciplineBadge discipline={finding.discipline} />
        <span className={`sc-pill ${severityPillClass}`}>{finding.severity}</span>
      </div>
      
      <div className={`alert-block ${alertClass} flex flex-col gap-2`}>
        <div className="sc-medium">{finding.title}</div>
        <div className="sc-body">{finding.detail}</div>
        <div className="flex items-center gap-2 mt-1">
          <span className="sc-ref">{finding.codeRef}</span>
          <span className="sc-meta lowercase">{finding.edition}</span>
        </div>
      </div>
      
      <div className="sc-card-footer flex items-center justify-between">
        <div className="sc-meta">{dateStr} · {finding.submittalId}</div>
        <button className="sc-btn-sm">Open</button>
      </div>
    </div>
  );
}
