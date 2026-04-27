import { useParams } from "wouter";
import { DashboardLayout } from "@workspace/portal-ui";
import { navGroups } from "../components/NavGroups";
import { SUBMITTALS, FINDINGS } from "../data/mock";
import { AIBriefingPanel } from "../components/AIBriefingPanel";
import { Folder, FileText } from "lucide-react";

export default function SubmittalDetail() {
  const params = useParams();
  const id = params.id as string;
  const submittal = SUBMITTALS.find(s => s.id === id);

  // If not found, just gracefully degrade title, but mock data ensures it'll exist if navigated from console.
  const title = submittal ? submittal.projectName : `Submittal ${id}`;

  return (
    <DashboardLayout
      title={title}
      navGroups={navGroups}
      brandLabel="SMARTCITY OS"
      brandProductName="Plan Review"
      search={{ placeholder: "Search submittals..." }}
    >
      <div className="flex h-[calc(100vh-64px)] -m-6"> {/* Negative margin to offset main padding in DashboardLayout and consume full space */}
        {/* Doc tree */}
        <div className="w-[272px] shrink-0 bg-[var(--bg-surface)] border-r border-[var(--border-default)] flex flex-col h-full">
          <div className="p-4 border-b border-[var(--border-default)]">
            <div className="sc-label">DOCUMENT TREE</div>
          </div>
          <div className="p-2 overflow-y-auto sc-scroll flex-1">
            <div className="flex items-center gap-2 px-2 py-1.5 cursor-pointer hover:bg-[var(--depth-hover-bg)] rounded">
              <Folder size={14} className="text-[var(--text-secondary)]" />
              <span className="sc-medium">Plans</span>
            </div>
            <div className="pl-6 flex flex-col">
              <div className="flex items-center gap-2 px-2 py-1 cursor-pointer bg-[var(--bg-active)] rounded">
                <FileText size={12} className="text-[var(--cyan)]" />
                <span className="sc-ui text-[var(--cyan-text)]">A2.04 - First Floor</span>
              </div>
              <div className="flex items-center gap-2 px-2 py-1 cursor-pointer hover:bg-[var(--depth-hover-bg)] rounded">
                <FileText size={12} className="text-[var(--text-muted)]" />
                <span className="sc-ui text-[var(--text-secondary)]">A2.05 - Second Floor</span>
              </div>
              <div className="flex items-center gap-2 px-2 py-1 cursor-pointer hover:bg-[var(--depth-hover-bg)] rounded">
                <FileText size={12} className="text-[var(--text-muted)]" />
                <span className="sc-ui text-[var(--text-secondary)]">S1.01 - Foundation</span>
              </div>
            </div>

            <div className="flex items-center gap-2 px-2 py-1.5 mt-2 cursor-pointer hover:bg-[var(--depth-hover-bg)] rounded">
              <Folder size={14} className="text-[var(--text-secondary)]" />
              <span className="sc-medium">Specs</span>
            </div>
            <div className="pl-6 flex flex-col">
              <div className="flex items-center gap-2 px-2 py-1 cursor-pointer hover:bg-[var(--depth-hover-bg)] rounded">
                <FileText size={12} className="text-[var(--text-muted)]" />
                <span className="sc-ui text-[var(--text-secondary)]">Div 08 - Openings</span>
              </div>
              <div className="flex items-center gap-2 px-2 py-1 cursor-pointer hover:bg-[var(--depth-hover-bg)] rounded">
                <FileText size={12} className="text-[var(--text-muted)]" />
                <span className="sc-ui text-[var(--text-secondary)]">Div 26 - Electrical</span>
              </div>
            </div>
            
            <div className="flex items-center gap-2 px-2 py-1.5 mt-2 cursor-pointer hover:bg-[var(--depth-hover-bg)] rounded">
              <Folder size={14} className="text-[var(--text-secondary)]" />
              <span className="sc-medium">Calcs</span>
            </div>
            <div className="pl-6 flex flex-col">
              <div className="flex items-center gap-2 px-2 py-1 cursor-pointer hover:bg-[var(--depth-hover-bg)] rounded">
                <FileText size={12} className="text-[var(--text-muted)]" />
                <span className="sc-ui text-[var(--text-secondary)]">Structural Load Calcs</span>
              </div>
            </div>

            <div className="flex items-center gap-2 px-2 py-1.5 mt-2 cursor-pointer hover:bg-[var(--depth-hover-bg)] rounded">
              <Folder size={14} className="text-[var(--text-secondary)]" />
              <span className="sc-medium">Reports</span>
            </div>
          </div>
        </div>

        {/* PDF viewer */}
        <div className="flex-1 bg-[var(--bg-base)] flex items-center justify-center p-8">
          <div className="sc-card max-w-lg w-full p-8 text-center flex flex-col items-center gap-4">
            <div className="sc-label">PDF VIEWER</div>
            <div className="sc-prose">Sheet A2.04 — First Floor Plan</div>
            <div className="sc-meta">(PDF rendering not implemented in shell)</div>
          </div>
        </div>

        {/* AI panel */}
        <aside className="w-[420px] shrink-0 border-l border-[var(--border-default)] bg-[var(--ai-panel-bg)] h-full overflow-y-auto sc-scroll">
          <AIBriefingPanel />
        </aside>
      </div>
    </DashboardLayout>
  );
}
