import React, { useState } from 'react';
import { 
  Search, Command, Inbox, Book, Palette, Settings, 
  ChevronRight, Activity, Clock, Box, Layers, Frame,
  MessageSquare, LayoutGrid, FileText, Map, FileStack,
  CheckCircle2, AlertCircle, FileCheck, CheckSquare,
  MessageSquarePlus, Link, Paperclip, Wrench
} from 'lucide-react';
import './cockpit.css';

// --- Mock Data ---

const PROJECTS = [
  {
    id: 'p1',
    name: 'Musgrave Residence',
    address: '1442 Highland Ave',
    jurisdiction: 'Grand County, UT',
    status: 'active',
    updatedAt: '12m ago',
    snapshotCount: 14,
    kpis: { sheets: 42, rooms: 18, levels: 3, walls: 245 },
  },
  {
    id: 'p2',
    name: 'Old Town Mixed-Use Block C',
    address: '800-850 Main St',
    jurisdiction: 'Portland, OR',
    status: 'in-pilot',
    updatedAt: '2h ago',
    snapshotCount: 8,
    kpis: { sheets: 124, rooms: 142, levels: 8, walls: 1840 },
  },
  {
    id: 'p3',
    name: 'Lemhi County Cabin Retreat',
    address: 'Salmon River Rd',
    jurisdiction: 'Lemhi County, ID',
    status: 'active',
    updatedAt: '5h ago',
    snapshotCount: 22,
    kpis: { sheets: 28, rooms: 6, levels: 2, walls: 86 },
  },
  {
    id: 'p4',
    name: 'Apex Innovation Center',
    address: '100 Tech Parkway',
    jurisdiction: 'Austin, TX',
    status: 'archived',
    updatedAt: '2d ago',
    snapshotCount: 45,
    kpis: { sheets: 310, rooms: 450, levels: 12, walls: 4200 },
  },
  {
    id: 'p5',
    name: 'Riverside Retail Pavilion',
    address: '44 Water St',
    jurisdiction: 'Boise, ID',
    status: 'active',
    updatedAt: '3d ago',
    snapshotCount: 5,
    kpis: { sheets: 56, rooms: 32, levels: 1, walls: 312 },
  },
];

const SUB_VIEWS = [
  { id: 'snapshots', icon: Clock, label: 'Snapshots' },
  { id: 'sheets', icon: LayoutGrid, label: 'Sheets' },
  { id: 'bim', icon: Box, label: '3D BIM' },
  { id: 'site', icon: Map, label: 'Site & Parcel' },
  { id: 'context', icon: FileText, label: 'Site Context' },
  { id: 'submissions', icon: FileStack, label: 'Submissions' },
  { id: 'findings', icon: AlertCircle, label: 'Findings' },
  { id: 'tasks', icon: CheckSquare, label: 'Response Tasks' },
  { id: 'letters', icon: FileCheck, label: 'Deliverable Letters' },
  { id: 'callouts', icon: Frame, label: 'Detail Callouts' },
  { id: 'specs', icon: Paperclip, label: 'Product Specs' },
  { id: 'renders', icon: Layers, label: 'Renders' },
  { id: 'settings', icon: Settings, label: 'Settings' },
];

export function Cockpit() {
  const [activeProjectId, setActiveProjectId] = useState(PROJECTS[0].id);
  const [activeView, setActiveView] = useState('snapshots');
  const [isChatOpen, setIsChatOpen] = useState(false);

  const activeProject = PROJECTS.find(p => p.id === activeProjectId) || PROJECTS[0];

  return (
    <div className="cockpit-theme flex h-screen w-full overflow-hidden text-sm">
      
      {/* GLOBAL LEFT RAIL */}
      <div className="w-[60px] flex-shrink-0 flex flex-col items-center py-4 border-r border-[#2A2A30] bg-[#121214] z-20">
        <div className="w-8 h-8 bg-violet-600 rounded mb-8 flex items-center justify-center font-bold text-white shadow-[0_0_15px_rgba(138,43,226,0.5)]">
          S
        </div>
        
        <nav className="flex flex-col gap-4 w-full items-center">
          <NavItem icon={Box} active={true} />
          <NavItem icon={Inbox} active={false} badge={3} />
          <NavItem icon={Book} active={false} />
          <NavItem icon={Palette} active={false} />
        </nav>
        
        <div className="mt-auto flex flex-col gap-4 w-full items-center">
          <NavItem icon={Settings} active={false} />
          <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-cyan-500 to-violet-500 border-2 border-[#1A1A1D]"></div>
        </div>
      </div>

      {/* MIDDLE RAIL - PROJECT LIST */}
      <div className="w-[320px] flex-shrink-0 flex flex-col border-r border-[#2A2A30] bg-[#0A0A0B] z-10">
        
        {/* Command Bar Header */}
        <div className="h-14 flex items-center px-4 border-b border-[#2A2A30]">
          <div className="flex-1 flex items-center gap-2 px-3 py-1.5 bg-[#1A1A1D] border border-[#3A3A42] rounded-md text-[#A0A0A8]">
            <Search size={14} />
            <input 
              type="text" 
              placeholder="Search engagements..." 
              className="bg-transparent border-none outline-none text-xs flex-1 text-[#EDEDEF] placeholder-[#686870]"
            />
            <div className="flex gap-1">
              <span className="kbd-shortcut">⌘</span>
              <span className="kbd-shortcut">K</span>
            </div>
          </div>
        </div>

        {/* Project List */}
        <div className="flex-1 overflow-y-auto scrollbar-hide py-2 px-2 flex flex-col gap-1">
          <div className="px-2 py-2 text-[10px] font-mono uppercase tracking-wider text-[#686870]">
            Active Engagements
          </div>
          
          {PROJECTS.map(p => (
            <div 
              key={p.id}
              onClick={() => setActiveProjectId(p.id)}
              className={`glow-ring p-3 rounded-md cursor-pointer flex flex-col gap-2 ${activeProjectId === p.id ? 'active' : ''}`}
            >
              <div className="flex justify-between items-start">
                <span className="font-medium text-[#EDEDEF] truncate pr-2">{p.name}</span>
                <StatusDot status={p.status} />
              </div>
              <div className="flex items-center text-xs text-[#A0A0A8]">
                <Map size={12} className="mr-1.5 opacity-50" />
                <span className="truncate">{p.jurisdiction}</span>
              </div>
              <div className="flex items-center justify-between mt-1 text-[11px] font-mono text-[#686870]">
                <span>{p.snapshotCount} snaps</span>
                <span>{p.updatedAt}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* MAIN CONTENT AREA */}
      <div className="flex-1 flex flex-col bg-[#0A0A0B] min-w-0 relative">
        
        {/* Header */}
        <header className="h-14 flex items-center justify-between px-6 border-b border-[#2A2A30] flex-shrink-0 bg-[#0A0A0B]/80 backdrop-blur-md z-10">
          <div className="flex items-center gap-3">
            <h1 className="font-semibold text-lg flex items-center gap-2">
              {activeProject.name}
              <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-[#1A1A1D] border border-[#2A2A30] text-[#A0A0A8]">
                {activeProject.id.toUpperCase()}
              </span>
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <button 
              onClick={() => setIsChatOpen(!isChatOpen)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-[#1A1A1D] hover:bg-[#232328] border border-[#3A3A42] transition-colors"
            >
              <MessageSquarePlus size={14} className="text-[#00F0FF]" />
              <span className="text-xs font-medium">Ask Claude</span>
              <span className="kbd-shortcut ml-1">⌘</span>
              <span className="kbd-shortcut">J</span>
            </button>
            <button className="px-3 py-1.5 rounded-md bg-violet-600 hover:bg-violet-500 text-white font-medium text-xs transition-colors">
              New Snapshot
            </button>
          </div>
        </header>

        <div className="flex flex-1 overflow-hidden">
          
          {/* Main Content Body */}
          <div className="flex-1 flex flex-col overflow-y-auto scrollbar-hide relative">
            
            {/* Context Header / KPIs */}
            <div className="p-6 border-b border-[#2A2A30]">
              <div className="grid grid-cols-4 gap-4">
                <KpiCard label="Sheets" value={activeProject.kpis.sheets} />
                <KpiCard label="Rooms" value={activeProject.kpis.rooms} />
                <KpiCard label="Levels" value={activeProject.kpis.levels} />
                <KpiCard label="Walls" value={activeProject.kpis.walls} />
              </div>
            </div>

            {/* View Content (Mockup representation of Snapshots timeline) */}
            <div className="p-6 flex-1">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-base font-medium flex items-center gap-2">
                  <Clock size={16} className="text-[#00F0FF]" />
                  Snapshot Timeline
                </h2>
                <div className="flex gap-2">
                  <span className="kbd-shortcut">F</span>
                  <span className="text-xs text-[#686870]">Filter</span>
                </div>
              </div>

              <div className="relative pl-4 border-l border-[#2A2A30] flex flex-col gap-8 ml-2">
                <TimelineEvent 
                  date="Today, 09:42 AM" 
                  title="Architectural Addendum v2" 
                  user="Sarah Chen"
                  isLatest
                />
                <TimelineEvent 
                  date="Yesterday, 14:15 PM" 
                  title="Structural Revisions" 
                  user="Mike Ross"
                />
                <TimelineEvent 
                  date="Oct 12, 10:00 AM" 
                  title="Initial Permit Set" 
                  user="Sarah Chen"
                />
              </div>
            </div>
            
          </div>

          {/* CONTEXTUAL RIGHT RAIL (Sub-views) */}
          <div className="w-[240px] flex-shrink-0 border-l border-[#2A2A30] bg-[#121214] flex flex-col z-10">
            <div className="p-4 border-b border-[#2A2A30]">
              <div className="text-[10px] font-mono uppercase tracking-wider text-[#686870] mb-3">
                Views
              </div>
              <div className="flex flex-col gap-0.5">
                {SUB_VIEWS.map((view, i) => (
                  <button
                    key={view.id}
                    onClick={() => setActiveView(view.id)}
                    className={`flex items-center gap-3 px-3 py-2 rounded-md text-xs transition-colors ${
                      activeView === view.id 
                        ? 'bg-[#1A1A1D] text-[#00F0FF] border border-[#2A2A30]' 
                        : 'text-[#A0A0A8] hover:bg-[#1A1A1D] border border-transparent'
                    }`}
                  >
                    <view.icon size={14} className={activeView === view.id ? 'opacity-100' : 'opacity-50'} />
                    <span>{view.label}</span>
                    {i < 9 && <span className="ml-auto text-[9px] font-mono opacity-30">{i+1}</span>}
                  </button>
                ))}
              </div>
            </div>
            
            <div className="p-4 flex-1">
              <div className="text-[10px] font-mono uppercase tracking-wider text-[#686870] mb-3">
                Quick Actions
              </div>
              <div className="flex flex-col gap-2 text-xs">
                <button className="flex items-center gap-2 text-[#A0A0A8] hover:text-[#EDEDEF] py-1">
                  <Link size={14} /> Copy link to project
                </button>
                <button className="flex items-center gap-2 text-[#A0A0A8] hover:text-[#EDEDEF] py-1">
                  <Wrench size={14} /> Open in Revit
                </button>
              </div>
            </div>
          </div>
          
        </div>

        {/* AI CHAT OVERLAY (Conditional) */}
        {isChatOpen && (
          <div className="absolute bottom-6 right-[264px] w-[400px] h-[500px] bg-[#121214] border border-[#3A3A42] rounded-xl shadow-[0_10px_40px_rgba(0,0,0,0.5)] flex flex-col overflow-hidden z-30">
            <div className="h-12 border-b border-[#2A2A30] flex items-center px-4 justify-between bg-[#1A1A1D]">
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 rounded bg-[#00F0FF]/20 flex items-center justify-center">
                  <MessageSquare size={12} className="text-[#00F0FF]" />
                </div>
                <span className="text-xs font-medium">Claude</span>
              </div>
              <button onClick={() => setIsChatOpen(false)} className="text-[#686870] hover:text-[#EDEDEF]">
                <kbd className="kbd-shortcut border-none bg-transparent">ESC</kbd>
              </button>
            </div>
            <div className="flex-1 p-4 overflow-y-auto flex flex-col gap-4 text-xs text-[#A0A0A8]">
              <div className="bg-[#1A1A1D] p-3 rounded-lg border border-[#2A2A30] self-start max-w-[85%]">
                How can I help you analyze the <span className="text-[#00F0FF]">{activeProject.name}</span> engagement?
              </div>
              <div className="bg-violet-600/20 text-[#EDEDEF] border border-violet-500/30 p-3 rounded-lg self-end max-w-[85%]">
                Summarize the structural changes in the latest snapshot.
              </div>
              <div className="bg-[#1A1A1D] p-3 rounded-lg border border-[#2A2A30] self-start max-w-[85%] text-[#EDEDEF]">
                Based on <span className="text-[#00F0FF] cursor-pointer">Snapshot v2</span>, 14 new load-bearing walls were added to Level 3, and foundation specifications on Sheet S1.0 were updated to require 4000 PSI concrete.
              </div>
            </div>
            <div className="p-3 border-t border-[#2A2A30] bg-[#1A1A1D]">
              <div className="bg-[#0A0A0B] border border-[#3A3A42] rounded-lg p-2 flex items-center">
                <input 
                  type="text" 
                  placeholder="Ask anything..." 
                  className="bg-transparent border-none outline-none text-xs flex-1 text-[#EDEDEF]"
                  autoFocus
                />
                <button className="p-1 rounded bg-[#2A2A30] text-[#A0A0A8] hover:text-[#EDEDEF]">
                  <Search size={14} />
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

// --- Components ---

function NavItem({ icon: Icon, active, badge }: { icon: any, active: boolean, badge?: number }) {
  return (
    <button className={`relative p-2 rounded-md transition-colors ${active ? 'bg-[#1A1A1D] text-[#EDEDEF]' : 'text-[#686870] hover:text-[#EDEDEF] hover:bg-[#1A1A1D]'}`}>
      <Icon size={20} strokeWidth={active ? 2.5 : 2} />
      {badge && (
        <span className="absolute top-1 right-1 w-4 h-4 bg-violet-500 rounded-full flex items-center justify-center text-[9px] font-bold text-white border border-[#121214]">
          {badge}
        </span>
      )}
      {active && (
        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 bg-[#00F0FF] rounded-r-md"></div>
      )}
    </button>
  );
}

function StatusDot({ status }: { status: string }) {
  let color = 'var(--status-archived)';
  if (status === 'active') color = 'var(--status-active)';
  if (status === 'in-pilot') color = 'var(--status-pilot)';
  
  return (
    <div 
      className="w-2 h-2 rounded-full" 
      style={{ 
        backgroundColor: color, 
        boxShadow: status !== 'archived' ? `0 0 6px ${color}80` : 'none' 
      }} 
    />
  );
}

function KpiCard({ label, value }: { label: string, value: number | string }) {
  return (
    <div className="bg-[#121214] border border-[#2A2A30] rounded-lg p-4 flex flex-col justify-between">
      <span className="text-[10px] font-mono uppercase text-[#686870]">{label}</span>
      <span className="text-2xl font-mono mt-1 text-[#EDEDEF]">{value}</span>
    </div>
  );
}

function TimelineEvent({ date, title, user, isLatest = false }: { date: string, title: string, user: string, isLatest?: boolean }) {
  return (
    <div className="relative">
      <div className={`absolute -left-[21px] top-1 w-2.5 h-2.5 rounded-full border-2 border-[#0A0A0B] ${isLatest ? 'bg-[#00F0FF] shadow-[0_0_8px_rgba(0,240,255,0.6)]' : 'bg-[#3A3A42]'}`}></div>
      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-mono text-[#686870]">{date}</span>
        <div className="bg-[#121214] border border-[#2A2A30] rounded-lg p-4 mt-1 hover:border-[#3A3A42] transition-colors cursor-pointer group">
          <div className="flex justify-between items-start">
            <h4 className="font-medium text-[#EDEDEF] group-hover:text-[#00F0FF] transition-colors">{title}</h4>
            <button className="opacity-0 group-hover:opacity-100 px-2 py-1 rounded bg-[#1A1A1D] text-xs">View</button>
          </div>
          <div className="flex items-center gap-2 mt-3 text-xs text-[#A0A0A8]">
            <div className="w-5 h-5 rounded bg-violet-600/30 border border-violet-500/50 flex items-center justify-center text-[10px] text-violet-300">
              {user.charAt(0)}
            </div>
            <span>{user}</span>
            <span className="mx-2 text-[#3A3A42]">•</span>
            <span className="font-mono text-[10px] bg-[#1A1A1D] px-1.5 py-0.5 rounded">Revit Plugin</span>
          </div>
        </div>
      </div>
    </div>
  );
}
