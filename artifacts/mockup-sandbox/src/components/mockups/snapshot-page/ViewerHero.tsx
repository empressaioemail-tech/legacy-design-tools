import React, { useState } from "react";
import {
  ArrowLeft,
  Settings,
  Archive,
  Send,
  Edit2,
  Layers,
  Box,
  Map,
  FileText,
  MessageSquare,
  FileBadge,
  Wrench,
  MonitorPlay,
  Share,
  Sliders,
  ChevronUp,
  ChevronDown,
  Code,
  Clock,
  User,
  Info,
  ChevronRight,
  ListTodo,
  FileSearch,
  Activity,
  Maximize
} from "lucide-react";

const SNAPSHOTS = [
  { time: "18 hr ago", sheets: 15, rooms: 0, levels: 7, walls: 45, elements: 101, user: "Alex Chen", active: true },
  { time: "2 d ago", sheets: 14, rooms: 0, levels: 7, walls: 42, elements: 98, user: "Alex Chen", active: false },
  { time: "5 d ago", sheets: 12, rooms: 0, levels: 6, walls: 38, elements: 85, user: "Sam Rivera", active: false },
  { time: "1 wk ago", sheets: 10, rooms: 0, levels: 5, walls: 30, elements: 70, user: "Alex Chen", active: false },
  { time: "2 wk ago", sheets: 8, rooms: 0, levels: 4, walls: 22, elements: 54, user: "Jordan Lee", active: false },
];

const VIEWS = [
  { name: "Snapshots", icon: Clock, active: true },
  { name: "Sheets", icon: Layers },
  { name: "3D model", icon: Box },
  { name: "Site", icon: Map },
  { name: "Site context", icon: Maximize },
  { name: "Submissions", icon: Send },
  { name: "Findings", icon: Activity, badge: 4 },
  { name: "Response tasks", icon: ListTodo },
  { name: "Deliverable letters", icon: FileText },
  { name: "Detail callouts", icon: FileSearch },
  { name: "Product specs", icon: FileBadge },
  { name: "Design Tools", icon: Wrench },
  { name: "Presentations", icon: MonitorPlay },
  { name: "Publish prep", icon: Share },
  { name: "Settings", icon: Sliders },
];

export function ViewerHero() {
  const [selectedTime, setSelectedTime] = useState("18 hr ago");
  const [drawerOpen, setDrawerOpen] = useState(true);

  const selectedSnapshot = SNAPSHOTS.find((s) => s.time === selectedTime) || SNAPSHOTS[0];

  return (
    <div className="flex h-screen w-full bg-[#0b1220] text-slate-300 font-sans overflow-hidden selection:bg-[#5fd0e0]/30 selection:text-[#5fd0e0]">
      {/* MAIN CANVAS */}
      <div className="flex-1 relative flex flex-col">
        {/* 3D Viewer Background */}
        <div className="absolute inset-0 bg-[#050914] overflow-hidden">
          {/* Grid */}
          <div 
            className="absolute inset-0 opacity-20"
            style={{
              backgroundImage: 'linear-gradient(#1e2a3a 1px, transparent 1px), linear-gradient(90deg, #1e2a3a 1px, transparent 1px)',
              backgroundSize: '40px 40px',
              transform: 'perspective(500px) rotateX(60deg) translateY(-100px) scale(2.5)',
              transformOrigin: 'top center'
            }}
          />
          {/* Mock 3D Masses */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px]">
            <svg viewBox="0 0 400 300" className="w-full h-full drop-shadow-2xl opacity-80" style={{ filter: 'drop-shadow(0 20px 30px rgba(0,0,0,0.8))' }}>
              {/* Ground Plane */}
              <polygon points="50,200 200,260 350,200 200,140" fill="#151e2e" stroke="#263852" strokeWidth="1" />
              {/* Building 1 */}
              <polygon points="200,220 280,188 280,80 200,112" fill="#203046" stroke="#2d4362" strokeWidth="1.5" />
              <polygon points="120,188 200,220 200,112 120,80" fill="#1a273a" stroke="#2d4362" strokeWidth="1.5" />
              <polygon points="120,80 200,112 280,80 200,48" fill="#2a3e5c" stroke="#375276" strokeWidth="1.5" />
              
              {/* Building 2 (smaller) */}
              <polygon points="150,150 190,134 190,90 150,106" fill="#182333" stroke="#263852" strokeWidth="1" />
              <polygon points="110,134 150,150 150,106 110,90" fill="#131c2a" stroke="#263852" strokeWidth="1" />
              <polygon points="110,90 150,106 190,90 150,74" fill="#1e2d42" stroke="#2d4362" strokeWidth="1" />
            </svg>
          </div>
          {/* Viewport Hint */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 mt-64 text-[#435e80] text-xs font-mono uppercase tracking-widest pointer-events-none">
            Drag to pan · Scroll to zoom · Right-drag to rotate · Reset view to recenter
          </div>
        </div>

        {/* OVERLAYS */}

        {/* Top-Left: Project Chip */}
        <div className="absolute top-4 left-4 z-10">
          <div className="bg-[#0b1220]/70 backdrop-blur-md border border-[#1e2a3a] rounded-lg shadow-2xl p-4 flex flex-col gap-3 min-w-[360px]">
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-medium text-white tracking-tight">Redd</h1>
              <span className="px-2 py-0.5 rounded-full bg-[#112a33] text-[#5fd0e0] border border-[#5fd0e0]/30 text-[10px] font-bold uppercase tracking-wider">
                Active
              </span>
            </div>
            <div className="text-sm text-slate-400 font-medium">
              143 E 100 N Moab UT 84532 <span className="text-[#3b526d]">·</span> Moab, UT
            </div>
            <div className="flex items-center gap-4 text-xs font-mono text-slate-300 mt-1 bg-[#050914]/50 p-2 rounded border border-[#1e2a3a]/50">
              <div className="flex items-center gap-1.5"><span className="text-[#5fd0e0] font-bold">{selectedSnapshot.sheets}</span> <span className="text-slate-500 uppercase tracking-wider">Sheets</span></div>
              <span className="text-[#1e2a3a]">|</span>
              <div className="flex items-center gap-1.5"><span className="text-[#5fd0e0] font-bold">{selectedSnapshot.rooms}</span> <span className="text-slate-500 uppercase tracking-wider">Rooms</span></div>
              <span className="text-[#1e2a3a]">|</span>
              <div className="flex items-center gap-1.5"><span className="text-[#5fd0e0] font-bold">{selectedSnapshot.levels}</span> <span className="text-slate-500 uppercase tracking-wider">Levels</span></div>
              <span className="text-[#1e2a3a]">|</span>
              <div className="flex items-center gap-1.5"><span className="text-[#5fd0e0] font-bold">{selectedSnapshot.walls}</span> <span className="text-slate-500 uppercase tracking-wider">Walls</span></div>
            </div>
          </div>
        </div>

        {/* Top-Right: Actions Toolbar */}
        <div className="absolute top-4 right-4 z-10 flex items-center gap-2">
          <button className="flex items-center gap-2 px-3 py-2 bg-[#0b1220]/70 backdrop-blur-md border border-[#1e2a3a] hover:bg-[#151e2e] text-slate-300 hover:text-white rounded-md text-xs font-medium transition-colors shadow-lg">
            <ArrowLeft className="w-3.5 h-3.5" />
            Projects
          </button>
          <div className="h-6 w-[1px] bg-[#1e2a3a] mx-1"></div>
          <div className="flex items-center bg-[#0b1220]/70 backdrop-blur-md border border-[#1e2a3a] rounded-md shadow-lg overflow-hidden">
            <button className="flex items-center justify-center p-2 text-slate-400 hover:text-white hover:bg-[#151e2e] transition-colors tooltip-trigger relative group">
              <Edit2 className="w-4 h-4" />
              <span className="absolute -bottom-8 left-1/2 -translate-x-1/2 bg-[#0b1220] border border-[#1e2a3a] text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">Edit details</span>
            </button>
            <div className="w-[1px] h-4 bg-[#1e2a3a]"></div>
            <button className="flex items-center justify-center p-2 text-slate-400 hover:text-white hover:bg-[#151e2e] transition-colors tooltip-trigger relative group">
              <Archive className="w-4 h-4" />
              <span className="absolute -bottom-8 left-1/2 -translate-x-1/2 bg-[#0b1220] border border-[#1e2a3a] text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">Archive</span>
            </button>
          </div>
          <button className="flex items-center gap-2 px-3 py-2 bg-[#112a33]/80 backdrop-blur-md border border-[#5fd0e0]/40 text-[#5fd0e0] hover:bg-[#5fd0e0] hover:text-[#0b1220] rounded-md text-xs font-bold uppercase tracking-wide transition-all shadow-lg shadow-[#5fd0e0]/10">
            Submit to jurisdiction
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Bottom Timeline Strip & Drawer */}
        <div className="absolute bottom-0 left-0 right-0 z-20 flex flex-col">
          {/* Inline Detail Drawer */}
          <div className={`mx-4 mb-4 transition-all duration-300 ease-in-out origin-bottom ${drawerOpen ? 'opacity-100 translate-y-0 scale-y-100 h-auto' : 'opacity-0 translate-y-4 scale-y-0 h-0 overflow-hidden'} bg-[#0b1220]/80 backdrop-blur-xl border border-[#1e2a3a] rounded-t-xl rounded-b-sm shadow-2xl`}>
            <div className="flex items-start justify-between p-5">
              <div className="flex flex-col gap-4 max-w-2xl">
                <div className="flex items-center gap-3">
                  <div className="flex items-center justify-center w-8 h-8 rounded-full bg-[#112a33] text-[#5fd0e0]">
                    <Clock className="w-4 h-4" />
                  </div>
                  <div>
                    <h2 className="text-lg font-medium text-white">Snapshot from {selectedSnapshot.time}</h2>
                    <p className="text-sm text-slate-400 mt-0.5">Captured automatically during sync</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mt-2">
                  <div>
                    <div className="text-xs uppercase tracking-wider text-slate-500 font-medium mb-1">Captured By</div>
                    <div className="flex items-center gap-2 text-sm text-slate-300">
                      <div className="w-5 h-5 rounded-full bg-slate-700 flex items-center justify-center text-[10px] font-bold text-white uppercase">
                        {selectedSnapshot.user.charAt(0)}
                      </div>
                      {selectedSnapshot.user}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wider text-slate-500 font-medium mb-1">Total Elements</div>
                    <div className="text-sm text-slate-300">{selectedSnapshot.elements} elements parsed</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wider text-slate-500 font-medium mb-1">Status</div>
                    <div className="text-sm text-emerald-400 flex items-center gap-1.5">
                      <div className="w-1.5 h-1.5 rounded-full bg-emerald-400"></div>
                      Processed cleanly
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex flex-col items-end gap-3">
                <button className="p-1.5 text-slate-400 hover:text-white rounded-md hover:bg-[#151e2e] transition-colors" onClick={() => setDrawerOpen(false)}>
                  <ChevronDown className="w-5 h-5" />
                </button>
                <button className="flex items-center gap-2 px-3 py-1.5 bg-[#151e2e] border border-[#2d4362] hover:bg-[#203046] rounded text-xs font-medium text-slate-300 transition-colors">
                  <Code className="w-3.5 h-3.5" />
                  View Raw JSON
                </button>
              </div>
            </div>
            {/* Minimal Raw JSON preview snippet */}
            <div className="border-t border-[#1e2a3a] bg-[#050914]/50 p-4 font-mono text-[11px] text-slate-500 max-h-24 overflow-y-auto">
              {`{
  "snapshotId": "snap_${Math.random().toString(36).substring(2, 8)}",
  "timestamp": "${new Date().toISOString()}",
  "engagementId": "eng_redd_143",
  "kpis": {
    "sheets": ${selectedSnapshot.sheets},
    "rooms": ${selectedSnapshot.rooms},
    "levels": ${selectedSnapshot.levels},
    "walls": ${selectedSnapshot.walls}
  },
  "status": "PROCESSED"
}`}
            </div>
          </div>

          {/* Timeline Strip */}
          <div className="h-20 bg-[#0b1220]/90 backdrop-blur-xl border-t border-[#1e2a3a] flex items-center px-4 gap-2 overflow-x-auto shadow-[0_-10px_30px_-10px_rgba(0,0,0,0.5)]">
            <div className="flex items-center mr-4 text-[#435e80]">
              <Clock className="w-5 h-5" />
            </div>
            {SNAPSHOTS.map((snap, i) => {
              const isSelected = snap.time === selectedTime;
              return (
                <button
                  key={i}
                  onClick={() => {
                    setSelectedTime(snap.time);
                    setDrawerOpen(true);
                  }}
                  className={`
                    relative flex-shrink-0 flex flex-col justify-center h-14 min-w-[140px] px-4 rounded-md border text-left transition-all
                    ${isSelected 
                      ? 'bg-[#112a33] border-[#5fd0e0] shadow-[0_0_15px_-3px_rgba(95,208,224,0.3)] z-10' 
                      : 'bg-[#0f1724] border-[#1e2a3a] hover:bg-[#151e2e] hover:border-[#2d4362]'
                    }
                  `}
                >
                  <div className={`text-xs font-semibold ${isSelected ? 'text-[#5fd0e0]' : 'text-slate-300'}`}>
                    {snap.time}
                  </div>
                  <div className={`text-[10px] mt-1 font-mono tracking-tight flex gap-1.5 ${isSelected ? 'text-[#5fd0e0]/80' : 'text-slate-500'}`}>
                    <span>{snap.sheets}sh</span>
                    <span>·</span>
                    <span>{snap.rooms}rm</span>
                    <span>·</span>
                    <span>{snap.levels}lv</span>
                    <span>·</span>
                    <span>{snap.walls}w</span>
                  </div>
                  
                  {isSelected && (
                    <div className="absolute -top-[1px] left-1/2 -translate-x-1/2 w-8 h-[2px] bg-[#5fd0e0] rounded-full shadow-[0_0_8px_rgba(95,208,224,0.8)]" />
                  )}
                </button>
              );
            })}
            
            <div className="flex-1" />
            
            {!drawerOpen && (
              <button 
                onClick={() => setDrawerOpen(true)}
                className="flex items-center gap-2 px-3 py-2 bg-[#151e2e] border border-[#2d4362] hover:bg-[#203046] hover:text-white rounded-md text-xs font-medium text-slate-300 transition-colors mr-2"
              >
                <Info className="w-3.5 h-3.5" />
                Snapshot Details
                <ChevronUp className="w-3 h-3 ml-1 text-slate-500" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* RIGHT RAIL: Views Navigation */}
      <div className="w-64 border-l border-[#1e2a3a] bg-[#0b1220] flex flex-col z-30 shadow-2xl relative">
        <div className="p-4 border-b border-[#1e2a3a]">
          <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Views</div>
        </div>
        <div className="flex-1 overflow-y-auto py-2 flex flex-col gap-0.5 px-2 custom-scrollbar">
          {VIEWS.map((view, i) => {
            const Icon = view.icon;
            const isActive = view.active;
            return (
              <button
                key={i}
                className={`
                  flex items-center justify-between w-full px-3 py-2 rounded-md text-sm transition-colors group
                  ${isActive 
                    ? 'bg-[#112a33] text-[#5fd0e0] font-medium' 
                    : 'text-slate-400 hover:text-slate-200 hover:bg-[#151e2e]'
                  }
                `}
              >
                <div className="flex items-center gap-3">
                  <Icon className={`w-4 h-4 ${isActive ? 'text-[#5fd0e0]' : 'text-[#435e80] group-hover:text-slate-400'}`} />
                  {view.name}
                </div>
                {view.badge && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-[#112a33] text-[#5fd0e0] border border-[#5fd0e0]/30">
                    {view.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        
        {/* Style the scrollbar for webkit to match the dark theme in the custom CSS, but here inline some minimal styling if possible. */}
        <style>{`
          .custom-scrollbar::-webkit-scrollbar {
            width: 4px;
          }
          .custom-scrollbar::-webkit-scrollbar-track {
            background: transparent;
          }
          .custom-scrollbar::-webkit-scrollbar-thumb {
            background: #1e2a3a;
            border-radius: 4px;
          }
          .custom-scrollbar::-webkit-scrollbar-thumb:hover {
            background: #2d4362;
          }
        `}</style>
      </div>
    </div>
  );
}
