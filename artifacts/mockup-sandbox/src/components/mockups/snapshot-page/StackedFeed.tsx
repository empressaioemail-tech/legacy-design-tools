import React, { useState } from "react";
import { 
  ArrowLeft, Archive, ExternalLink, MapPin, 
  ChevronRight, ChevronLeft, Building2, Box, FileText, Activity,
  Maximize, RotateCcw, SlidersHorizontal, Sun, Focus, Info, ChevronDown
} from "lucide-react";

export function StackedFeed() {
  const [expandedCard, setExpandedCard] = useState<string | null>("snap-1");

  const snapshots = [
    { id: "snap-1", time: "18 hr ago", sheets: 15, rooms: 0, levels: 7, walls: 45, elements: 101, user: "Alex R." },
    { id: "snap-2", time: "2 d ago", sheets: 14, rooms: 0, levels: 7, walls: 42, elements: 95, user: "Sam M." },
    { id: "snap-3", time: "5 d ago", sheets: 12, rooms: 0, levels: 6, walls: 38, elements: 82, user: "Jordan P." },
    { id: "snap-4", time: "1 wk ago", sheets: 10, rooms: 0, levels: 5, walls: 30, elements: 65, user: "Alex R." },
    { id: "snap-5", time: "2 wk ago", sheets: 8, rooms: 0, levels: 4, walls: 22, elements: 48, user: "Taylor K." },
  ];

  return (
    <div className="w-full h-full min-h-[900px] flex flex-col bg-[#0b1220] text-slate-300 font-sans overflow-y-auto overflow-x-hidden selection:bg-[#5fd0e0] selection:text-[#0b1220]">
      {/* Top Banner */}
      <div className="flex-none bg-[#111927] border-b border-[#1e2a3a] px-6 py-4 flex flex-col gap-4 sticky top-0 z-20 shadow-md">
        <div className="flex items-start justify-between">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-3">
              <button className="text-slate-400 hover:text-white transition-colors">
                <ArrowLeft size={16} />
              </button>
              <h1 className="text-xl font-medium text-white tracking-tight">Redd</h1>
              <span className="px-2 py-0.5 rounded text-[10px] font-bold tracking-wider bg-[#5fd0e0]/10 text-[#5fd0e0] border border-[#5fd0e0]/20">
                ACTIVE
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-400 pl-7">
              <MapPin size={12} className="opacity-70" />
              <span>143 E 100 N Moab UT 84532 · Moab, UT</span>
            </div>
          </div>

          <div className="flex items-center gap-8">
            {/* KPI Strip */}
            <div className="flex items-center gap-6">
              <div className="flex flex-col items-end">
                <span className="text-2xl font-light text-white leading-none">15</span>
                <span className="text-[9px] uppercase tracking-widest text-slate-500 font-semibold mt-1">Sheets</span>
              </div>
              <div className="w-px h-6 bg-[#1e2a3a]" />
              <div className="flex flex-col items-end">
                <span className="text-2xl font-light text-white leading-none">0</span>
                <span className="text-[9px] uppercase tracking-widest text-slate-500 font-semibold mt-1">Rooms</span>
              </div>
              <div className="w-px h-6 bg-[#1e2a3a]" />
              <div className="flex flex-col items-end">
                <span className="text-2xl font-light text-[#5fd0e0] leading-none">7</span>
                <span className="text-[9px] uppercase tracking-widest text-[#5fd0e0]/70 font-semibold mt-1">Levels</span>
              </div>
              <div className="w-px h-6 bg-[#1e2a3a]" />
              <div className="flex flex-col items-end">
                <span className="text-2xl font-light text-white leading-none">45</span>
                <span className="text-[9px] uppercase tracking-widest text-slate-500 font-semibold mt-1">Walls</span>
              </div>
              
              <div className="flex flex-col pl-4 text-[10px] text-slate-500 italic border-l border-[#1e2a3a]">
                <span>from snapshot</span>
                <span>18 hr ago</span>
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2 pl-4 border-l border-[#1e2a3a]">
              <button className="px-3 py-1.5 rounded bg-transparent border border-[#1e2a3a] text-xs font-medium text-slate-300 hover:bg-[#1e2a3a] transition-colors flex items-center gap-2">
                Edit details
              </button>
              <button className="px-3 py-1.5 rounded bg-transparent border border-[#1e2a3a] text-xs font-medium text-slate-300 hover:bg-[#1e2a3a] transition-colors flex items-center gap-2">
                <Archive size={14} className="opacity-70" />
                Archive
              </button>
              <button className="px-3 py-1.5 rounded bg-[#5fd0e0] text-[#0b1220] border border-[#5fd0e0] text-xs font-medium hover:bg-[#4bc0d0] transition-colors flex items-center gap-2 ml-2">
                Submit to jurisdiction
                <ExternalLink size={14} />
              </button>
            </div>
          </div>
        </div>

        {/* Tab Strip */}
        <div className="flex items-center gap-1 border-t border-[#1e2a3a] pt-4 mt-2 -mb-2 overflow-x-auto">
          {[
            { label: "Snapshots", active: true },
            { label: "Sheets", active: false },
            { label: "3D model", active: false },
            { label: "Site", active: false },
            { label: "Site context", active: false },
            { label: "Submissions", active: false },
            { label: "Findings(4)", active: false, badge: true },
            { label: "Response tasks", active: false },
            { label: "Deliverable letters", active: false },
            { label: "Detail callouts", active: false },
            { label: "Product specs", active: false },
            { label: "Design Tools", active: false },
          ].map((tab) => (
            <button
              key={tab.label}
              className={`px-4 py-2 text-xs font-medium rounded-t-md border-b-2 transition-colors whitespace-nowrap flex items-center gap-1.5 ${
                tab.active
                  ? "text-[#5fd0e0] border-[#5fd0e0] bg-[#5fd0e0]/5"
                  : "text-slate-400 border-transparent hover:text-slate-200 hover:bg-white/5"
              }`}
            >
              {tab.label}
              {tab.badge && (
                <span className="px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-500 text-[9px] leading-none border border-amber-500/30">
                  4
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-h-0">
        
        {/* BIM Viewer Centerpiece */}
        <div className="h-[520px] flex-none relative flex flex-col bg-[#05080f] border-b border-[#1e2a3a]">
          {/* Viewer Chrome */}
          <div className="absolute top-0 left-0 right-0 p-4 flex items-center justify-between z-10 pointer-events-none">
            <div className="flex items-center gap-3 pointer-events-auto">
              <div className="px-3 py-1.5 rounded bg-[#0b1220]/80 border border-[#1e2a3a] backdrop-blur-sm flex items-center gap-2">
                <Box size={14} className="text-[#5fd0e0]" />
                <span className="text-xs font-medium text-white">101 elements</span>
              </div>
              <div className="px-3 py-1.5 rounded bg-[#0b1220]/80 border border-[#1e2a3a] backdrop-blur-sm text-xs text-slate-400 flex items-center gap-1.5">
                <Activity size={14} className="opacity-70" />
                <span>Live view</span>
              </div>
            </div>

            <div className="flex items-center gap-2 pointer-events-auto">
              <div className="flex items-center bg-[#0b1220]/80 border border-[#1e2a3a] rounded backdrop-blur-sm overflow-hidden p-0.5">
                <button className="p-1.5 hover:bg-white/10 rounded text-slate-400 hover:text-white transition-colors" title="Reset view">
                  <RotateCcw size={14} />
                </button>
                <div className="w-px h-4 bg-[#1e2a3a] mx-0.5" />
                <button className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-[#5fd0e0] bg-[#5fd0e0]/10 rounded">ISO</button>
                <button className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-slate-400 hover:text-white hover:bg-white/5 rounded">TOP</button>
                <button className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-slate-400 hover:text-white hover:bg-white/5 rounded">FRONT</button>
              </div>
              
              <div className="flex items-center bg-[#0b1220]/80 border border-[#1e2a3a] rounded backdrop-blur-sm overflow-hidden p-0.5 ml-2">
                <button className="p-1.5 hover:bg-white/10 rounded text-slate-400 hover:text-white transition-colors" title="Settings">
                  <SlidersHorizontal size={14} />
                </button>
                <button className="p-1.5 hover:bg-white/10 rounded text-slate-400 hover:text-white transition-colors" title="Environment">
                  <Sun size={14} />
                </button>
                <div className="w-px h-4 bg-[#1e2a3a] mx-0.5" />
                <button className="p-1.5 hover:bg-white/10 rounded text-slate-400 hover:text-white transition-colors" title="Fullscreen">
                  <Maximize size={14} />
                </button>
              </div>
            </div>
          </div>

          {/* 3D Viewport Simulation */}
          <div className="absolute inset-0 flex items-center justify-center overflow-hidden">
            {/* Grid */}
            <div 
              className="absolute inset-0 opacity-10 pointer-events-none"
              style={{
                backgroundImage: `
                  linear-gradient(to right, #5fd0e0 1px, transparent 1px),
                  linear-gradient(to bottom, #5fd0e0 1px, transparent 1px)
                `,
                backgroundSize: '40px 40px',
                transform: 'perspective(500px) rotateX(60deg) scale(2) translateY(-100px)'
              }}
            />
            
            {/* Building Masses */}
            <div className="relative w-64 h-64 flex items-center justify-center transform hover:scale-105 transition-transform duration-700 ease-out cursor-move">
              <div className="absolute w-32 h-32 bg-[#1e2a3a] border border-[#2a3a4f] transform -translate-x-12 translate-y-8 shadow-[10px_10px_30px_rgba(0,0,0,0.5)] skew-y-12" />
              <div className="absolute w-24 h-48 bg-gradient-to-br from-[#2a3a4f] to-[#111927] border border-[#3a4a6f] transform translate-x-8 -translate-y-4 shadow-[15px_15px_40px_rgba(0,0,0,0.6)] skew-y-12 flex flex-col justify-end">
                {/* Simulated levels */}
                <div className="w-full h-px bg-[#5fd0e0]/20 mb-6" />
                <div className="w-full h-px bg-[#5fd0e0]/20 mb-6" />
                <div className="w-full h-px bg-[#5fd0e0]/20 mb-6" />
                <div className="w-full h-px bg-[#5fd0e0]/20 mb-6" />
                <div className="w-full h-px bg-[#5fd0e0]/20 mb-6" />
                <div className="w-full h-px bg-[#5fd0e0]/40 mb-6 shadow-[0_0_10px_rgba(95,208,224,0.3)]" />
              </div>
              <div className="absolute w-16 h-16 bg-[#162032] border border-[#1e2a3a] transform translate-x-24 translate-y-20 shadow-[5px_5px_20px_rgba(0,0,0,0.4)] skew-y-12" />
              
              {/* Highlight / Selection effect */}
              <div className="absolute w-24 h-48 border-2 border-[#5fd0e0] transform translate-x-8 -translate-y-4 shadow-[0_0_15px_rgba(95,208,224,0.3)] skew-y-12 z-10 pointer-events-none" />
            </div>
          </div>

          {/* Bottom Hint */}
          <div className="absolute bottom-4 left-0 right-0 flex justify-center pointer-events-none">
            <div className="px-4 py-1.5 rounded-full bg-[#0b1220]/60 border border-[#1e2a3a]/50 backdrop-blur-md text-[10px] text-slate-400 tracking-wide">
              Drag to pan · Scroll to zoom · Right-drag to rotate · <span className="text-[#5fd0e0] cursor-pointer pointer-events-auto hover:underline">Reset view</span> to recenter
            </div>
          </div>
        </div>

        {/* Snapshot History Feed */}
        <div className="flex-1 bg-[#0b1220] p-6 flex flex-col min-h-0">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-white uppercase tracking-wider flex items-center gap-2">
              <RotateCcw size={14} className="text-[#5fd0e0]" />
              Snapshot History
            </h2>
            <div className="flex items-center gap-2">
              <button className="p-1 rounded border border-[#1e2a3a] text-slate-400 hover:text-white hover:bg-[#1e2a3a] transition-colors">
                <ChevronLeft size={16} />
              </button>
              <button className="p-1 rounded border border-[#1e2a3a] text-slate-400 hover:text-white hover:bg-[#1e2a3a] transition-colors">
                <ChevronRight size={16} />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-x-auto flex gap-4 pb-4 snap-x">
            {snapshots.map((snap, index) => {
              const isExpanded = expandedCard === snap.id;
              
              return (
                <div 
                  key={snap.id}
                  className={`flex-shrink-0 snap-start bg-[#111927] border rounded-lg overflow-hidden flex flex-col transition-all duration-300 ${
                    isExpanded 
                      ? "w-[600px] border-[#5fd0e0]" 
                      : "w-[280px] border-[#1e2a3a] hover:border-slate-600"
                  }`}
                >
                  <div className={`flex flex-1 ${isExpanded ? "flex-row" : "flex-col"}`}>
                    
                    {/* Card Basic Info */}
                    <div className={`${isExpanded ? "w-[280px] border-r border-[#1e2a3a]" : "w-full"} p-4 flex flex-col`}>
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-white">{snap.time}</span>
                          {index === 0 && (
                            <span className="px-1.5 py-0.5 rounded bg-[#5fd0e0]/10 text-[#5fd0e0] text-[9px] font-bold tracking-wider">CURRENT</span>
                          )}
                        </div>
                        <div className="w-6 h-6 rounded-full bg-[#1e2a3a] flex items-center justify-center text-[10px] font-medium text-slate-300 border border-slate-700" title={`Created by ${snap.user}`}>
                          {snap.user.substring(0, 2).toUpperCase()}
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2 mb-4">
                        <div className="bg-[#0b1220] rounded p-2 border border-[#1e2a3a]">
                          <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Sheets</div>
                          <div className="text-lg font-light text-white">{snap.sheets}</div>
                        </div>
                        <div className="bg-[#0b1220] rounded p-2 border border-[#1e2a3a]">
                          <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Rooms</div>
                          <div className="text-lg font-light text-white">{snap.rooms}</div>
                        </div>
                        <div className="bg-[#0b1220] rounded p-2 border border-[#1e2a3a]">
                          <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Levels</div>
                          <div className="text-lg font-light text-[#5fd0e0]">{snap.levels}</div>
                        </div>
                        <div className="bg-[#0b1220] rounded p-2 border border-[#1e2a3a]">
                          <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Walls</div>
                          <div className="text-lg font-light text-white">{snap.walls}</div>
                        </div>
                      </div>

                      <div className="mt-auto pt-3 border-t border-[#1e2a3a] flex items-center justify-between">
                        <div className="flex items-center gap-1.5 text-xs text-slate-400">
                          <Box size={12} />
                          <span>{snap.elements} elements</span>
                        </div>
                        <button 
                          onClick={() => setExpandedCard(isExpanded ? null : snap.id)}
                          className="text-xs font-medium text-[#5fd0e0] hover:text-[#4bc0d0] transition-colors flex items-center gap-1"
                        >
                          {isExpanded ? "Collapse" : "View details"}
                          <ChevronRight size={12} className={`transform transition-transform ${isExpanded ? "rotate-90" : ""}`} />
                        </button>
                      </div>
                    </div>

                    {/* Expanded Detail Panel */}
                    {isExpanded && (
                      <div className="flex-1 p-4 flex flex-col bg-[#0d1422] overflow-y-auto">
                        <div className="flex items-center justify-between mb-4">
                          <h3 className="text-sm font-medium text-white flex items-center gap-2">
                            <FileText size={14} className="text-slate-400" />
                            Extracted Sheets
                          </h3>
                          <button className="text-[10px] uppercase tracking-wider font-semibold text-[#5fd0e0] hover:underline">
                            View all
                          </button>
                        </div>

                        <div className="grid grid-cols-3 gap-2 mb-6">
                          {[1, 2, 3, 4, 5, 6].map((i) => (
                            <div key={i} className="aspect-[3/4] bg-[#1a2436] border border-[#2a3a4f] rounded overflow-hidden relative group">
                              <div className="absolute inset-0 p-1">
                                <div className="w-full h-full border border-slate-600/30 flex flex-col items-center justify-center p-2 opacity-50 group-hover:opacity-100 transition-opacity">
                                  <div className="w-full h-2 bg-slate-700/50 mb-1 rounded-sm" />
                                  <div className="w-3/4 h-2 bg-slate-700/50 mb-auto rounded-sm" />
                                  <div className="w-full h-12 bg-slate-700/30 rounded-sm mb-1" />
                                  <div className="w-full flex justify-between mt-auto">
                                    <div className="w-4 h-4 bg-slate-700/50 rounded-sm" />
                                    <div className="w-8 h-4 bg-slate-700/50 rounded-sm" />
                                  </div>
                                </div>
                              </div>
                              <div className="absolute bottom-0 left-0 right-0 bg-[#0b1220]/90 backdrop-blur text-[9px] p-1 text-center font-medium border-t border-[#1e2a3a]">
                                A{100 + i}.0
                              </div>
                            </div>
                          ))}
                        </div>

                        <div className="mt-auto">
                          <button className="w-full py-2 rounded border border-[#1e2a3a] text-xs font-medium text-slate-300 hover:bg-[#1e2a3a] hover:text-white transition-colors flex items-center justify-center gap-2">
                            <Info size={14} />
                            Show Raw JSON
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

      </div>
    </div>
  );
}
