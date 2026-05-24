import React, { useState } from 'react';
import { 
  Building2, Home, Inbox, Library, Settings, Search, 
  Plus, MoreHorizontal, ChevronRight, CheckCircle2, 
  Clock, FileText, Layers, Map, FileSearch, Send,
  MessageSquare, LayoutList, Layers3, Ruler, ListTodo,
  FileCheck, Image as ImageIcon, Box, Sparkles, X,
  AlignLeft, ArrowUpRight
} from 'lucide-react';
import './workbench.css';

// --- SEED DATA ---
const ENGAGEMENTS = [
  { id: 1, name: "Musgrave Residence", address: "1420 Alpine Way", jurisdiction: "Summit County, UT", status: "active", snapshots: 12, updated: "2h ago", kpis: { sheets: 45, rooms: 12, levels: 3, walls: 210 } },
  { id: 2, name: "Old Town Mixed-Use Block C", address: "400 Main St", jurisdiction: "Park City, UT", status: "in-pilot", snapshots: 4, updated: "1d ago", kpis: { sheets: 120, rooms: 45, levels: 5, walls: 850 } },
  { id: 3, name: "Lemhi County Cabin Retreat", address: "88 Pine Ridge", jurisdiction: "Lemhi County, ID", status: "active", snapshots: 8, updated: "3d ago", kpis: { sheets: 28, rooms: 8, levels: 2, walls: 140 } },
  { id: 4, name: "Downtown Arts Center", address: "105 E 1st South", jurisdiction: "Salt Lake City, UT", status: "archived", snapshots: 32, updated: "2w ago", kpis: { sheets: 340, rooms: 110, levels: 4, walls: 1200 } },
];

const TIMELINE = [
  { id: 1, version: "v12", date: "Today, 9:41 AM", author: "Sarah J.", changes: "Updated Level 2 floorplan, resolved setback findings." },
  { id: 2, version: "v11", date: "Yesterday", author: "System", changes: "Automated site context briefing generated." },
  { id: 3, version: "v10", date: "Oct 24", author: "Mike R.", changes: "Initial Revit model sync." },
];

const SHEETS = [
  { id: "A101", name: "Site Plan", status: "reviewed" },
  { id: "A102", name: "Level 1 Floor Plan", status: "findings" },
  { id: "A103", name: "Level 2 Floor Plan", status: "pending" },
  { id: "A201", name: "North Elevation", status: "reviewed" },
  { id: "A202", name: "South Elevation", status: "reviewed" },
  { id: "A301", name: "Building Sections", status: "pending" },
];

// --- COMPONENTS ---

const StatusPill = ({ status }: { status: string }) => {
  const styles = {
    "active": "bg-[#F2EBE9] text-[#9B4F3A]", // Terracotta accent
    "in-pilot": "bg-[#E6EBE7] text-[#4A5D4E]", // Soft olive
    "archived": "bg-[#EAE6DF] text-[#78716C]"
  }[status] || "bg-[#EAE6DF] text-[#78716C]";

  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium tracking-wide uppercase ${styles}`}>
      {status.replace('-', ' ')}
    </span>
  );
};

const AiMarginNote = ({ onClose, title }: { onClose: () => void, title: string }) => {
  return (
    <div className="absolute right-[-340px] top-0 w-[320px] bg-white dt-shadow-popover rounded-xl border border-[var(--dt-border)] flex flex-col z-50 animate-in fade-in slide-in-from-left-4 duration-200">
      <div className="flex items-center justify-between p-3 border-b border-[var(--dt-border)] bg-[#F8F6F1]/50 rounded-t-xl">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-[var(--dt-accent)]" />
          <span className="text-sm font-medium text-[var(--dt-ink)]">{title}</span>
        </div>
        <button onClick={onClose} className="p-1 text-[var(--dt-ink-muted)] hover:bg-[var(--dt-border)] rounded-md transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>
      
      <div className="p-4 space-y-4 text-sm text-[var(--dt-ink)]">
        <div className="bg-[#F8F6F1] p-3 rounded-lg border border-[var(--dt-border)]">
          <p className="leading-relaxed">I noticed the setback requirements on the West property line might conflict with the latest A101 Site Plan. Would you like me to cross-reference the municipal code?</p>
        </div>
      </div>

      <div className="p-3 border-t border-[var(--dt-border)]">
        <div className="relative">
          <input 
            type="text" 
            placeholder="Ask Claude about this..." 
            className="w-full bg-[#F8F6F1] border border-[var(--dt-border)] rounded-lg pl-3 pr-10 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--dt-accent)] transition-shadow"
          />
          <button className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--dt-accent)] p-1 hover:bg-[var(--dt-accent-bg)] rounded-md transition-colors">
            <ArrowUpRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};

const Block = ({ title, icon: Icon, children, isExpanded = true, onToggle, onAiClick, aiActive }: any) => {
  return (
    <div className="relative mb-8 group">
      <div className="absolute -left-12 top-1 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col gap-2">
        <button 
          onClick={onAiClick}
          className={`p-2 rounded-full transition-all ${aiActive ? 'bg-[var(--dt-accent)] text-white shadow-md' : 'bg-white border border-[var(--dt-border)] text-[var(--dt-ink-muted)] hover:text-[var(--dt-accent)] hover:border-[var(--dt-accent)] shadow-sm'}`}
          title="Ask AI about this section"
        >
          <Sparkles className="w-4 h-4" />
        </button>
      </div>

      <div className={`bg-white rounded-2xl dt-shadow-card border border-[var(--dt-border)] overflow-hidden transition-all duration-300 ${!isExpanded && 'opacity-70 hover:opacity-100 cursor-pointer'}`}>
        <div 
          className="px-6 py-4 flex items-center justify-between cursor-pointer select-none"
          onClick={onToggle}
        >
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-[#F8F6F1] border border-[var(--dt-border)] flex items-center justify-center text-[var(--dt-ink-muted)]">
              <Icon className="w-4 h-4" />
            </div>
            <h3 className="dt-font-serif text-xl font-medium tracking-tight text-[var(--dt-ink)]">{title}</h3>
          </div>
          <button className="text-[var(--dt-ink-muted)] hover:text-[var(--dt-ink)]">
            {isExpanded ? <MoreHorizontal className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
          </button>
        </div>
        
        {isExpanded && (
          <div className="px-6 pb-6 pt-2 border-t border-[var(--dt-border)]/50">
            {children}
          </div>
        )}
      </div>

      {aiActive && <AiMarginNote onClose={onAiClick} title={`Chat: ${title}`} />}
    </div>
  );
};

export function Workbench() {
  const [selectedEng, setSelectedEng] = useState(ENGAGEMENTS[0]);
  const [expandedBlocks, setExpandedBlocks] = useState<Record<string, boolean>>({
    'snapshots': false,
    'sheets': true,
    'bim': false,
    'site': true,
    'context': false,
    'submissions': false,
  });
  const [activeAiBlock, setActiveAiBlock] = useState<string | null>(null);

  const toggleBlock = (key: string) => {
    setExpandedBlocks(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleAi = (key: string) => {
    setActiveAiBlock(prev => prev === key ? null : key);
  };

  return (
    <div className="dt-workbench-root">
      
      {/* GLOBAL NAV (Slim) */}
      <div className="w-16 flex flex-col items-center py-6 border-r border-[var(--dt-border)] bg-[#F8F6F1] z-20 shrink-0">
        <div className="w-8 h-8 bg-[var(--dt-ink)] rounded-lg mb-8 flex items-center justify-center text-[#F8F6F1] dt-font-serif font-bold text-lg">
          S
        </div>
        
        <div className="flex flex-col gap-4 w-full px-2">
          <button className="p-3 rounded-xl bg-white border border-[var(--dt-border)] shadow-sm text-[var(--dt-accent)] relative group">
            <Library className="w-5 h-5 mx-auto" strokeWidth={1.5} />
            <div className="absolute left-14 top-2 bg-[var(--dt-ink)] text-white text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-50">Projects</div>
          </button>
          <button className="p-3 rounded-xl text-[var(--dt-ink-muted)] hover:bg-[#EAE6DF] transition-colors relative group">
            <Inbox className="w-5 h-5 mx-auto" strokeWidth={1.5} />
          </button>
          <button className="p-3 rounded-xl text-[var(--dt-ink-muted)] hover:bg-[#EAE6DF] transition-colors relative group">
            <LayoutList className="w-5 h-5 mx-auto" strokeWidth={1.5} />
          </button>
          <button className="p-3 rounded-xl text-[var(--dt-ink-muted)] hover:bg-[#EAE6DF] transition-colors relative group">
            <Settings className="w-5 h-5 mx-auto" strokeWidth={1.5} />
          </button>
        </div>
        
        <div className="mt-auto">
          <button className="w-10 h-10 rounded-full border border-[var(--dt-border)] overflow-hidden">
            <img src={`https://api.dicebear.com/7.x/notionists/svg?seed=Felix&backgroundColor=F2EBE9`} alt="User" />
          </button>
        </div>
      </div>

      {/* PROJECT LIST (Collapsible sidebar feel) */}
      <div className="w-72 border-r border-[var(--dt-border)] bg-[#F8F6F1]/50 dt-scroll overflow-y-auto shrink-0 z-10 flex flex-col">
        <div className="p-4 sticky top-0 bg-[#F8F6F1]/90 backdrop-blur-sm z-10 border-b border-[var(--dt-border)]">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--dt-ink-muted)]" />
            <input 
              type="text" 
              placeholder="Search engagements..." 
              className="w-full bg-white border border-[var(--dt-border)] rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:border-[var(--dt-ink)] transition-colors"
            />
          </div>
        </div>

        <div className="p-3 flex-1">
          <div className="text-xs font-semibold text-[var(--dt-ink-muted)] tracking-wider uppercase mb-3 px-2">Active Engagements</div>
          <div className="space-y-1">
            {ENGAGEMENTS.map(eng => (
              <button 
                key={eng.id}
                onClick={() => setSelectedEng(eng)}
                className={`w-full text-left p-3 rounded-xl transition-all ${selectedEng.id === eng.id ? 'bg-white border border-[var(--dt-border)] shadow-sm' : 'hover:bg-[#EAE6DF] border border-transparent'}`}
              >
                <div className="flex items-center justify-between mb-1">
                  <div className="font-medium text-sm text-[var(--dt-ink)] truncate pr-2">{eng.name}</div>
                  {selectedEng.id === eng.id && <div className="w-1.5 h-1.5 rounded-full bg-[var(--dt-accent)] shrink-0" />}
                </div>
                <div className="text-xs text-[var(--dt-ink-muted)] truncate">{eng.jurisdiction}</div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* MAIN EDITOR AREA */}
      <div className="flex-1 dt-scroll overflow-y-auto relative">
        <div className="max-w-[800px] mx-auto pt-16 pb-32 px-12">
          
          {/* Document Header */}
          <div className="mb-12 relative group">
            <div className="absolute -left-12 top-4 opacity-0 group-hover:opacity-100 transition-opacity">
               <button onClick={() => toggleAi('header')} className={`p-2 rounded-full ${activeAiBlock === 'header' ? 'bg-[var(--dt-accent)] text-white shadow-md' : 'bg-white border border-[var(--dt-border)] text-[var(--dt-ink-muted)] hover:text-[var(--dt-accent)] hover:border-[var(--dt-accent)] shadow-sm'}`}>
                  <Sparkles className="w-4 h-4" />
               </button>
            </div>
            
            <div className="flex items-center gap-3 mb-4">
              <StatusPill status={selectedEng.status} />
              <span className="text-sm text-[var(--dt-ink-muted)] flex items-center gap-1"><Map className="w-3.5 h-3.5" /> {selectedEng.jurisdiction}</span>
            </div>
            
            <h1 className="dt-font-serif text-5xl font-medium tracking-tight text-[var(--dt-ink)] mb-4 leading-tight">
              {selectedEng.name}
            </h1>
            
            <div className="flex items-center gap-6 text-[var(--dt-ink-muted)] text-sm">
              <span className="flex items-center gap-1.5"><Home className="w-4 h-4" /> {selectedEng.address}</span>
              <span className="flex items-center gap-1.5"><Clock className="w-4 h-4" /> Last updated {selectedEng.updated}</span>
            </div>

            {/* KPI Strip */}
            <div className="flex gap-8 mt-8 py-6 border-y border-[var(--dt-border)]/50">
               <div>
                 <div className="text-2xl dt-font-serif text-[var(--dt-ink)]">{selectedEng.kpis.sheets}</div>
                 <div className="text-xs text-[var(--dt-ink-muted)] uppercase tracking-wider font-medium mt-1">Sheets</div>
               </div>
               <div>
                 <div className="text-2xl dt-font-serif text-[var(--dt-ink)]">{selectedEng.kpis.rooms}</div>
                 <div className="text-xs text-[var(--dt-ink-muted)] uppercase tracking-wider font-medium mt-1">Rooms</div>
               </div>
               <div>
                 <div className="text-2xl dt-font-serif text-[var(--dt-ink)]">{selectedEng.kpis.levels}</div>
                 <div className="text-xs text-[var(--dt-ink-muted)] uppercase tracking-wider font-medium mt-1">Levels</div>
               </div>
               <div>
                 <div className="text-2xl dt-font-serif text-[var(--dt-ink)]">{selectedEng.kpis.walls}</div>
                 <div className="text-xs text-[var(--dt-ink-muted)] uppercase tracking-wider font-medium mt-1">Walls</div>
               </div>
            </div>

            {activeAiBlock === 'header' && <AiMarginNote onClose={() => toggleAi('header')} title="Project Overview" />}
          </div>

          {/* Blocks */}
          <div className="space-y-6 relative">
            
            <Block 
              title="Snapshots Timeline" 
              icon={Clock} 
              isExpanded={expandedBlocks['snapshots']} 
              onToggle={() => toggleBlock('snapshots')}
              onAiClick={() => toggleAi('snapshots')}
              aiActive={activeAiBlock === 'snapshots'}
            >
              <div className="space-y-4">
                {TIMELINE.map((item, i) => (
                  <div key={item.id} className="flex gap-4 group">
                    <div className="flex flex-col items-center">
                      <div className="w-2.5 h-2.5 rounded-full bg-[var(--dt-accent)] ring-4 ring-white" />
                      {i !== TIMELINE.length - 1 && <div className="w-px h-full bg-[var(--dt-border)] mt-1" />}
                    </div>
                    <div className="pb-4">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-sm text-[var(--dt-ink)]">{item.version}</span>
                        <span className="text-xs text-[var(--dt-ink-muted)]">{item.date}</span>
                      </div>
                      <p className="text-sm text-[var(--dt-ink-muted)]">{item.changes}</p>
                    </div>
                  </div>
                ))}
              </div>
            </Block>

            <Block 
              title="Sheets & Views" 
              icon={Layers} 
              isExpanded={expandedBlocks['sheets']} 
              onToggle={() => toggleBlock('sheets')}
              onAiClick={() => toggleAi('sheets')}
              aiActive={activeAiBlock === 'sheets'}
            >
              <div className="grid grid-cols-3 gap-4">
                {SHEETS.map(sheet => (
                  <div key={sheet.id} className="group cursor-pointer">
                    <div className="aspect-[4/3] bg-[#F8F6F1] rounded-lg border border-[var(--dt-border)] mb-2 flex items-center justify-center relative overflow-hidden group-hover:border-[var(--dt-accent)] transition-colors">
                      <FileText className="w-8 h-8 text-[var(--dt-ink-muted)] opacity-20" />
                      {sheet.status === 'findings' && (
                        <div className="absolute top-2 right-2 w-2 h-2 rounded-full bg-[#D97706]" />
                      )}
                    </div>
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="text-xs font-medium text-[var(--dt-ink)]">{sheet.id}</div>
                        <div className="text-xs text-[var(--dt-ink-muted)] truncate max-w-[140px]">{sheet.name}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </Block>

            <Block 
              title="Site Context & Briefing" 
              icon={Map} 
              isExpanded={expandedBlocks['site']} 
              onToggle={() => toggleBlock('site')}
              onAiClick={() => toggleAi('site')}
              aiActive={activeAiBlock === 'site'}
            >
              <div className="flex gap-6">
                <div className="w-1/3 aspect-square bg-[#F8F6F1] rounded-lg border border-[var(--dt-border)] p-2">
                  <div className="w-full h-full border border-dashed border-[var(--dt-ink-muted)]/30 rounded flex items-center justify-center bg-white/50">
                    <span className="text-xs text-[var(--dt-ink-muted)]">Map View</span>
                  </div>
                </div>
                <div className="flex-1 space-y-3">
                  <div className="p-3 rounded-lg border border-[var(--dt-border)] bg-[#F8F6F1]/50 flex justify-between items-center">
                    <div>
                      <div className="text-sm font-medium text-[var(--dt-ink)]">Zone District</div>
                      <div className="text-xs text-[var(--dt-ink-muted)]">R-1 Single Family Residential</div>
                    </div>
                    <CheckCircle2 className="w-4 h-4 text-[#4A5D4E]" />
                  </div>
                  <div className="p-3 rounded-lg border border-[#D97706]/30 bg-[#FFFBEB] flex justify-between items-center">
                    <div>
                      <div className="text-sm font-medium text-[#B45309]">Setbacks (West)</div>
                      <div className="text-xs text-[#D97706]">Potential encroachment detected</div>
                    </div>
                    <button className="text-xs font-medium text-[#B45309] hover:underline">Review</button>
                  </div>
                </div>
              </div>
            </Block>

            <Block 
              title="Findings & Responses" 
              icon={ListTodo} 
              isExpanded={expandedBlocks['findings']} 
              onToggle={() => toggleBlock('findings')}
              onAiClick={() => toggleAi('findings')}
              aiActive={activeAiBlock === 'findings'}
            >
              <div className="text-sm text-[var(--dt-ink-muted)] p-8 text-center bg-[#F8F6F1] rounded-lg border border-dashed border-[var(--dt-border)]">
                No active findings for current submission.
              </div>
            </Block>

          </div>

          {/* Add Block Affordance */}
          <div className="mt-8 flex justify-center">
            <button className="flex items-center gap-2 text-sm text-[var(--dt-ink-muted)] hover:text-[var(--dt-ink)] bg-white border border-[var(--dt-border)] dt-shadow-card px-4 py-2 rounded-full transition-all hover:-translate-y-0.5">
              <Plus className="w-4 h-4" /> Add Section
            </button>
          </div>

        </div>
      </div>

    </div>
  );
}
