import React, { useState } from "react";
import { 
  Rocket, AlertCircle, CheckCircle2, Circle, Check, ChevronRight, 
  MoreVertical, Clock, CheckSquare, Image as ImageIcon, Presentation,
  FileText, Search, LayoutDashboard, Sparkles, Send, Upload, Package,
  FolderTree, History, Info, ChevronDown
} from "lucide-react";

export function Launchpad() {
  return (
    <div className="flex h-[900px] w-[1280px] bg-[#0b1220] text-slate-300 font-sans overflow-hidden">
      {/* LEFT RAIL - Views */}
      <div className="w-16 lg:w-48 border-r border-[#1e2a3a] bg-[#0f1729] flex flex-col p-3">
        <div className="text-[10px] font-bold tracking-wider text-slate-500 mb-4 px-2 hidden lg:block">VIEWS</div>
        <NavItem icon={<Search size={16} />} label="Overview" />
        <NavItem icon={<LayoutDashboard size={16} />} label="Intake" />
        <NavItem icon={<FolderTree size={16} />} label="Site Context" />
        <NavItem icon={<CheckSquare size={16} />} label="Review" />
        <div className="my-2 border-t border-[#1e2a3a]"></div>
        <NavItem icon={<Rocket size={16} />} label="Mission Control" active />
        <div className="mt-auto">
          <NavItem icon={<Info size={16} />} label="Settings" />
        </div>
      </div>

      {/* MAIN CANVAS */}
      <div className="flex-1 flex flex-col min-w-0 bg-[#0b1220]">
        {/* TOP BANNER */}
        <div className="h-32 border-b border-[#1e2a3a] bg-[#0f1729] p-6 flex items-center justify-between">
          <div>
            <div className="text-cyan-400 font-mono text-xs mb-2">ENGAGEMENT / REDD_2025</div>
            <h1 className="text-2xl text-white font-semibold mb-2">READY TO SHIP: 1 of 4 deliverables · <span className="text-[#ef4444]">3 blocked</span></h1>
            <div className="flex items-center gap-2 text-sm">
              <AlertCircle size={14} className="text-[#ef4444]" />
              <span className="text-slate-400">Blocked by: <span className="text-white">4 open findings</span> · <span className="text-white">Letter #2 not yet sent</span> · <span className="text-white">Architect sign-off pending</span></span>
            </div>
          </div>
          <div className="flex items-center gap-6">
            <div className="relative w-20 h-20 flex items-center justify-center">
              <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="40" fill="none" stroke="#1e2a3a" strokeWidth="8" />
                <circle cx="50" cy="50" r="40" fill="none" stroke="#22c55e" strokeWidth="8" strokeDasharray="251.2" strokeDashoffset="75.36" />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-xl font-bold text-white">70%</span>
              </div>
            </div>
          </div>
        </div>

        {/* MISSION DECK (Cards) */}
        <div className="flex-1 p-6 overflow-y-auto">
          <div className="grid grid-cols-2 gap-6">
            
            {/* Card 1: Render Set */}
            <div className="bg-[#0f1729] border border-[#1e2a3a] rounded-lg p-5 flex flex-col">
              <div className="flex justify-between items-start mb-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-cyan-500/10 text-cyan-400 rounded-md">
                    <ImageIcon size={20} />
                  </div>
                  <div>
                    <h3 className="text-white font-medium">Marketing exterior set</h3>
                    <div className="text-xs text-slate-400 mt-1">3 of 6 renders ready · 1 in-progress (60%) · 1 queued</div>
                  </div>
                </div>
                <button className="text-slate-500 hover:text-white"><MoreVertical size={16} /></button>
              </div>
              
              <div className="flex gap-2 mb-4 overflow-hidden">
                <div className="w-20 h-14 rounded bg-gradient-to-br from-cyan-900/50 to-blue-900/20 border border-[#1e2a3a] relative overflow-hidden">
                  <div className="absolute bottom-0 w-full h-1/2 bg-slate-800/40" style={{ clipPath: 'polygon(20% 100%, 50% 30%, 80% 100%)' }}></div>
                  <div className="absolute top-1 right-1"><CheckCircle2 size={10} className="text-[#22c55e]" /></div>
                </div>
                <div className="w-20 h-14 rounded bg-gradient-to-br from-cyan-900/50 to-blue-900/20 border border-[#1e2a3a] relative overflow-hidden">
                   <div className="absolute bottom-0 w-full h-2/3 bg-slate-800/40" style={{ clipPath: 'polygon(0% 100%, 30% 20%, 60% 100%, 100% 50%, 100% 100%)' }}></div>
                   <div className="absolute top-1 right-1"><CheckCircle2 size={10} className="text-[#22c55e]" /></div>
                </div>
                <div className="w-20 h-14 rounded bg-gradient-to-br from-cyan-900/50 to-blue-900/20 border border-[#1e2a3a] relative overflow-hidden">
                   <div className="absolute bottom-0 w-full h-1/2 bg-slate-800/40" style={{ clipPath: 'polygon(10% 100%, 40% 40%, 90% 100%)' }}></div>
                   <div className="absolute top-1 right-1"><CheckCircle2 size={10} className="text-[#22c55e]" /></div>
                </div>
                <div className="w-20 h-14 rounded border border-cyan-500/50 bg-cyan-950/20 relative flex items-center justify-center">
                   <div className="text-[10px] text-cyan-400">60%</div>
                   <div className="absolute bottom-0 left-0 h-1 bg-cyan-500 w-[60%]"></div>
                </div>
              </div>
              
              <div className="mt-auto pt-4 border-t border-[#1e2a3a] flex items-center justify-between">
                <div className="text-xs text-slate-400">Launch when 4/4 hero renders complete</div>
                <button className="flex items-center gap-1 text-sm text-cyan-400 hover:text-cyan-300 font-medium">
                  Open render studio <ChevronRight size={14} />
                </button>
              </div>
            </div>

            {/* Card 2: Pitch Deck */}
            <div className="bg-[#0f1729] border border-[#1e2a3a] rounded-lg p-5 flex flex-col">
              <div className="flex justify-between items-start mb-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-amber-500/10 text-amber-400 rounded-md">
                    <Presentation size={20} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-white font-medium">Client Pitch Deck</h3>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#1e2a3a] text-slate-300 flex items-center gap-1 cursor-pointer hover:bg-slate-700">v3 <ChevronDown size={10} /></span>
                    </div>
                    <div className="text-xs text-amber-400/80 mt-1">14 slides · DRAFT · edited 2 hr ago by Maria</div>
                  </div>
                </div>
                <button className="text-slate-500 hover:text-white"><MoreVertical size={16} /></button>
              </div>
              
              <div className="flex gap-2 mb-4">
                <div className="w-16 h-20 rounded border border-[#1e2a3a] bg-slate-900 flex flex-col items-center justify-center p-1">
                  <div className="w-10 h-1 bg-slate-700 rounded mb-1"></div>
                  <div className="w-8 h-1 bg-slate-800 rounded"></div>
                </div>
                <div className="w-16 h-20 rounded border border-[#1e2a3a] bg-slate-900 flex flex-col p-1.5">
                  <div className="w-full h-8 bg-slate-800 rounded mb-1"></div>
                  <div className="w-full h-1 bg-slate-700 rounded mb-1"></div>
                  <div className="w-2/3 h-1 bg-slate-700 rounded"></div>
                </div>
                <div className="w-16 h-20 rounded border border-[#1e2a3a] bg-slate-900 flex flex-col p-1.5">
                  <div className="w-1/2 h-1 bg-slate-700 rounded mb-2"></div>
                  <div className="flex gap-1">
                    <div className="w-full h-10 bg-slate-800 rounded"></div>
                    <div className="w-full h-10 bg-slate-800 rounded"></div>
                  </div>
                </div>
              </div>
              
              <div className="mt-auto pt-4 border-t border-[#1e2a3a]">
                <div className="text-xs text-slate-400 mb-3">Ready to share with client — needs version-bump approval</div>
                <div className="flex gap-2">
                  <button className="px-3 py-1.5 bg-[#1e2a3a] hover:bg-slate-700 text-white text-xs rounded font-medium">Preview</button>
                  <button className="px-3 py-1.5 bg-[#1e2a3a] hover:bg-slate-700 text-white text-xs rounded font-medium">Generate PDF</button>
                  <button className="px-3 py-1.5 bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 text-xs rounded font-medium ml-auto flex items-center gap-1">
                    Bump to v4 & send <Send size={12} />
                  </button>
                </div>
              </div>
            </div>

            {/* Card 3: Jurisdiction Submission */}
            <div className="bg-[#0f1729] border border-[#1e2a3a] rounded-lg p-5 flex flex-col">
              <div className="flex justify-between items-start mb-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-slate-800 text-slate-300 rounded-md border border-slate-700">
                    <Package size={20} />
                  </div>
                  <div>
                    <h3 className="text-white font-medium">Jurisdiction Submission Package</h3>
                    <div className="text-xs text-slate-400 mt-1">Submission #4 — corrections response</div>
                  </div>
                </div>
                <button className="text-slate-500 hover:text-white"><MoreVertical size={16} /></button>
              </div>
              
              <div className="mb-4 space-y-2 text-sm">
                <div className="text-xs font-mono text-slate-500 mb-1">DEPENDENCIES</div>
                <div className="flex items-center gap-2 text-slate-300">
                  <CheckCircle2 size={14} className="text-[#22c55e]" /> Renders embedded
                </div>
                <div className="flex items-center gap-2 text-slate-300">
                  <Circle size={14} className="text-[#ef4444]" /> Letter #2 sent
                </div>
                <div className="flex items-center gap-2 text-slate-300">
                  <Circle size={14} className="text-[#ef4444]" /> Findings closed
                </div>
              </div>
              
              <div className="mt-auto pt-4 border-t border-[#1e2a3a] flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-16 h-1.5 bg-[#1e2a3a] rounded-full overflow-hidden">
                    <div className="w-[40%] h-full bg-[#ef4444]"></div>
                  </div>
                  <span className="text-xs font-mono text-slate-500">40%</span>
                </div>
                <button className="flex items-center gap-1 text-sm text-slate-300 hover:text-white font-medium">
                  Open workspace <ChevronRight size={14} />
                </button>
              </div>
            </div>

            {/* Card 4: Final Bundle */}
            <div className="bg-[#0f1729] border border-cyan-500/30 rounded-lg p-5 flex flex-col relative overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-b from-cyan-500/5 to-transparent pointer-events-none"></div>
              
              <div className="flex justify-between items-start mb-4 relative z-10">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-cyan-500 text-white rounded-md shadow-[0_0_15px_rgba(34,211,238,0.3)]">
                    <Rocket size={20} />
                  </div>
                  <div>
                    <h3 className="text-white font-medium text-lg">Final Project Bundle</h3>
                    <div className="text-xs text-cyan-400 mt-1">Readiness 70%</div>
                  </div>
                </div>
                <button className="text-slate-500 hover:text-white"><MoreVertical size={16} /></button>
              </div>
              
              <div className="mb-4 grid grid-cols-2 gap-x-4 gap-y-2 text-xs relative z-10">
                <div className="flex items-center gap-2 text-slate-300"><Check size={12} className="text-[#22c55e]" /> Metadata complete</div>
                <div className="flex items-center gap-2 text-slate-300"><Check size={12} className="text-[#22c55e]" /> Briefing finalized</div>
                <div className="flex items-center gap-2 text-[#ef4444]"><Circle size={12} className="fill-current" /> Findings closed (4 open)</div>
                <div className="flex items-center gap-2 text-[#ef4444]"><Circle size={12} className="fill-current" /> Letter sent</div>
                <div className="flex items-center gap-2 text-slate-300"><Check size={12} className="text-[#22c55e]" /> Renders selected</div>
                <div className="flex items-center gap-2 text-[#ef4444]"><Circle size={12} className="fill-current" /> Architect sign-off</div>
                <div className="flex items-center gap-2 text-slate-300 col-span-2"><Check size={12} className="text-[#22c55e]" /> Legacy plan uploaded</div>
              </div>
              
              <div className="mt-auto pt-4 relative z-10">
                <button 
                  className="w-full py-3 bg-slate-800 text-slate-500 font-bold rounded cursor-not-allowed border border-slate-700 flex items-center justify-center gap-2"
                  title="Blocked by: 4 open findings, Letter sent, Architect sign-off"
                >
                  <Upload size={16} /> EXPORT BUNDLE
                </button>
              </div>
            </div>

          </div>
        </div>
      </div>

      {/* RIGHT RAIL - Mission Control */}
      <div className="w-64 border-l border-[#1e2a3a] bg-[#0f1729] flex flex-col p-4">
        <h2 className="text-xs font-bold tracking-wider text-slate-500 mb-4">MISSION CONTROL</h2>
        
        {/* Blockers */}
        <div className="mb-6">
          <div className="text-xs font-medium text-[#ef4444] mb-2 flex items-center gap-1">
            <AlertCircle size={12} /> OPEN BLOCKERS (3)
          </div>
          <div className="space-y-2">
            <button className="w-full text-left p-2 rounded bg-[#ef4444]/10 border border-[#ef4444]/20 hover:bg-[#ef4444]/20 text-sm text-slate-300 group transition-colors">
              Address 4 open findings <ChevronRight size={14} className="inline opacity-0 group-hover:opacity-100 transition-opacity float-right mt-0.5" />
            </button>
            <button className="w-full text-left p-2 rounded bg-[#ef4444]/10 border border-[#ef4444]/20 hover:bg-[#ef4444]/20 text-sm text-slate-300 group transition-colors">
              Send Letter #2 <ChevronRight size={14} className="inline opacity-0 group-hover:opacity-100 transition-opacity float-right mt-0.5" />
            </button>
            <button className="w-full text-left p-2 rounded bg-[#ef4444]/10 border border-[#ef4444]/20 hover:bg-[#ef4444]/20 text-sm text-slate-300 group transition-colors">
              Get architect sign-off <ChevronRight size={14} className="inline opacity-0 group-hover:opacity-100 transition-opacity float-right mt-0.5" />
            </button>
          </div>
        </div>
        
        <div className="my-4 border-t border-[#1e2a3a]"></div>
        
        {/* Credits */}
        <div className="mb-6">
          <div className="text-xs text-slate-400 mb-2 flex justify-between">
            <span>Render Credits</span>
            <span className="font-mono">1,240 / 2,000</span>
          </div>
          <div className="w-full h-1.5 bg-[#1e2a3a] rounded-full overflow-hidden">
            <div className="w-[38%] h-full bg-cyan-500"></div>
          </div>
        </div>
        
        {/* Activity */}
        <div className="mb-6 flex-1">
          <div className="text-xs font-medium text-slate-500 mb-3 flex items-center gap-1">
            <History size={12} /> RECENT ACTIVITY
          </div>
          <div className="space-y-4">
            <div className="flex gap-2 relative">
              <div className="absolute left-[7px] top-4 bottom-[-16px] w-[1px] bg-[#1e2a3a]"></div>
              <div className="w-4 h-4 rounded-full bg-amber-500/20 border border-amber-500/50 flex-shrink-0 flex items-center justify-center z-10 mt-0.5">
                 <div className="w-1.5 h-1.5 rounded-full bg-amber-400"></div>
              </div>
              <div>
                <div className="text-xs text-slate-300">Maria edited deck v3</div>
                <div className="text-[10px] text-slate-500 mt-0.5">2 hr ago</div>
              </div>
            </div>
            <div className="flex gap-2 relative">
              <div className="absolute left-[7px] top-4 bottom-[-16px] w-[1px] bg-[#1e2a3a]"></div>
              <div className="w-4 h-4 rounded-full bg-[#22c55e]/20 border border-[#22c55e]/50 flex-shrink-0 flex items-center justify-center z-10 mt-0.5">
                 <div className="w-1.5 h-1.5 rounded-full bg-[#22c55e]"></div>
              </div>
              <div>
                <div className="text-xs text-slate-300">Render 'Hero exterior' completed</div>
                <div className="text-[10px] text-slate-500 mt-0.5">18 hr ago</div>
              </div>
            </div>
            <div className="flex gap-2">
              <div className="w-4 h-4 rounded-full bg-slate-800 border border-slate-600 flex-shrink-0 flex items-center justify-center z-10 mt-0.5">
                 <div className="w-1.5 h-1.5 rounded-full bg-slate-400"></div>
              </div>
              <div>
                <div className="text-xs text-slate-300">Legacy plan uploaded</div>
                <div className="text-[10px] text-slate-500 mt-0.5">1 d ago</div>
              </div>
            </div>
          </div>
        </div>

        {/* Schedule */}
        <div className="mt-auto">
          <button className="w-full py-2 bg-[#1e2a3a] hover:bg-slate-700 border border-slate-700 text-sm text-white rounded flex items-center justify-center gap-2 transition-colors">
            <Clock size={14} /> Schedule launch
          </button>
        </div>
      </div>

      {/* AI Assistant Pill */}
      <div className="fixed bottom-6 right-72 bg-[#1e2a3a] border border-cyan-500/30 shadow-lg shadow-cyan-900/20 rounded-full py-2 px-4 flex items-center gap-2 cursor-pointer hover:bg-slate-800 transition-colors z-50">
        <Sparkles size={16} className="text-cyan-400" />
        <span className="text-sm text-slate-200">Want me to draft the launch announcement for the Client Pitch Deck?</span>
      </div>
    </div>
  );
}

function NavItem({ icon, label, active = false }: { icon: React.ReactNode, label: string, active?: boolean }) {
  return (
    <button className={`flex items-center gap-3 p-2 rounded-lg w-full mb-1 transition-colors ${
      active 
        ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20" 
        : "text-slate-400 hover:bg-[#1e2a3a] hover:text-slate-200"
    }`}>
      {icon}
      <span className="text-sm font-medium hidden lg:block">{label}</span>
    </button>
  );
}
