import { useMemo, useState } from "react";
import { DashboardLayout } from "@workspace/portal-ui";
import { useNavGroups } from "../components/NavGroups";
import { FINDINGS } from "../data/mock";
import { DisciplineBadge } from "../components/DisciplineBadge";

type QuickFilter = "all" | "blocking" | "ai-only" | "open";

const QUICK_FILTERS: { id: QuickFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "blocking", label: "Blocking" },
  { id: "ai-only", label: "AI-only" },
  { id: "open", label: "Open" },
];

export default function FindingsLibrary() {
  const navGroups = useNavGroups();
  const [searchQuery, setSearchQuery] = useState("");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");
  const trimmedQuery = searchQuery.trim().toLowerCase();
  const filteredFindings = useMemo(() => {
    return FINDINGS.filter((f) => {
      if (quickFilter === "blocking" && f.severity !== "blocking") return false;
      if (quickFilter === "ai-only" && f.source !== "ai-reviewer") return false;
      if (quickFilter === "open" && f.status !== "open") return false;
      if (!trimmedQuery) return true;
      const haystack = [
        f.id,
        f.title,
        f.detail,
        f.codeRef,
        f.edition,
        f.discipline,
        f.severity,
        f.status,
        f.submittalId,
        f.source,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(trimmedQuery);
    });
  }, [trimmedQuery, quickFilter]);

  return (
    <DashboardLayout
      title="Saved Findings"
      navGroups={navGroups}
      brandLabel="SMARTCITY OS"
      brandProductName="Plan Review"
      search={{
        placeholder: "Search findings...",
        value: searchQuery,
        onChange: setSearchQuery,
      }}
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          {QUICK_FILTERS.map((qf) => {
            const isActive = quickFilter === qf.id;
            return (
              <button
                key={qf.id}
                type="button"
                onClick={() => setQuickFilter(qf.id)}
                aria-pressed={isActive}
                data-testid={`findings-quick-filter-${qf.id}`}
                className={
                  isActive
                    ? "sc-btn-sm bg-[var(--cyan-dim)] border-[var(--border-focus)]"
                    : "sc-btn-sm text-[var(--text-secondary)] border-[var(--border-default)]"
                }
              >
                {qf.label}
              </button>
            );
          })}
        </div>

        <div className="sc-card overflow-x-auto">
          <table className="w-full text-left border-collapse" data-testid="findings-table">
            <thead>
              <tr className="bg-[var(--depth-header-bg)] border-b border-[var(--border-default)]">
                <th className="sc-label px-4 py-2 font-medium">Severity</th>
                <th className="sc-label px-4 py-2 font-medium">Discipline</th>
                <th className="sc-label px-4 py-2 font-medium">Title</th>
                <th className="sc-label px-4 py-2 font-medium">Code</th>
                <th className="sc-label px-4 py-2 font-medium">Source</th>
                <th className="sc-label px-4 py-2 font-medium">Submittal</th>
                <th className="sc-label px-4 py-2 font-medium">Identified</th>
                <th className="sc-label px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {FINDINGS.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center sc-body">No findings match these filters.</td>
                </tr>
              ) : filteredFindings.length === 0 ? (
                <tr>
                  <td
                    colSpan={8}
                    className="px-4 py-8 text-center sc-body"
                    data-testid="findings-no-matches"
                  >
                    {(() => {
                      const activeFilter = QUICK_FILTERS.find((qf) => qf.id === quickFilter);
                      const filterLabel =
                        quickFilter !== "all" && activeFilter ? activeFilter.label : null;
                      const trimmed = searchQuery.trim();
                      if (filterLabel && trimmed) {
                        return `No ${filterLabel} findings match “${trimmed}”. Try a different filter or search.`;
                      }
                      if (filterLabel) {
                        return `No ${filterLabel} findings yet.`;
                      }
                      return `No findings match “${trimmed}”. Try a different title, code, discipline, or submittal.`;
                    })()}
                  </td>
                </tr>
              ) : (
                filteredFindings.map(f => {
                  let severityPillClass = "sc-pill-blue";
                  if (f.severity === "blocking") severityPillClass = "sc-pill-red";
                  else if (f.severity === "warning") severityPillClass = "sc-pill-amber";
                  
                  const dateStr = new Date(f.identifiedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
                  
                  let statusPillClass = "sc-pill-muted";
                  if (f.status === "open") statusPillClass = "sc-pill-amber";
                  else if (f.status === "resolved") statusPillClass = "sc-pill-green";

                  return (
                    <tr key={f.id} className="border-b border-[var(--border-default)] hover:bg-[var(--depth-hover-bg)] transition-colors group cursor-pointer h-8">
                      <td className="px-4 py-1.5"><span className={`sc-pill ${severityPillClass}`}>{f.severity}</span></td>
                      <td className="px-4 py-1.5"><DisciplineBadge discipline={f.discipline} /></td>
                      <td className="px-4 py-1.5 sc-medium max-w-[200px] truncate" title={f.title}>{f.title}</td>
                      <td className="px-4 py-1.5"><span className="sc-ref">{f.codeRef}</span></td>
                      <td className="px-4 py-1.5 sc-meta">{f.source === "ai-reviewer" ? "AI" : "Human"}</td>
                      <td className="px-4 py-1.5"><span className="sc-mono-sm text-[var(--text-secondary)]">{f.submittalId}</span></td>
                      <td className="px-4 py-1.5 sc-mono-sm text-[var(--text-secondary)]">{dateStr}</td>
                      <td className="px-4 py-1.5"><span className={`sc-pill ${statusPillClass}`}>{f.status}</span></td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </DashboardLayout>
  );
}
