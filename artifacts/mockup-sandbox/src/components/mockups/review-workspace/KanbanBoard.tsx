import React, { useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Clock,
  Filter,
  GripVertical,
  Info,
  Layers,
  LayoutDashboard,
  MessageSquare,
  MoreHorizontal,
  Play,
  Plus,
  Send,
  User,
  Settings,
  FolderOpen
} from "lucide-react";

const SIDEBAR_ITEMS = [
  { icon: LayoutDashboard, label: "Overview" },
  { icon: Layers, label: "Site Context" },
  { icon: FolderOpen, label: "Review Workspace", active: true },
  { icon: Settings, label: "Settings" }
];

const SUBMISSIONS = [
  { id: 3, name: "Grand County", status: "CORRECTIONS REQUESTED", submittedAgo: "18 hr ago", respondedAgo: "4 hr ago", active: true },
  { id: 2, name: "Grand County", status: "CORRECTIONS REQUESTED", submittedAgo: "1 wk ago", respondedAgo: "5 d ago", active: false },
  { id: 1, name: "Grand County", status: "CORRECTIONS REQUESTED", submittedAgo: "3 wk ago", respondedAgo: "2 wk ago", active: false },
];

export function KanbanBoard() {
  return (
    <div className="flex h-[900px] w-[1280px] bg-[#0b1220] text-slate-300 font-sans overflow-hidden">
      {/* LEFT SIDEBAR (MOCK) */}
      <div className="w-16 border-r border-[#1e2a3a] bg-[#0b1220] flex flex-col items-center py-4 gap-6 shrink-0">
        <div className="w-8 h-8 bg-[#5fd0e0] rounded-md mb-4 flex items-center justify-center text-[#0b1220] font-bold">
          S
        </div>
        {SIDEBAR_ITEMS.map((item, idx) => (
          <div key={idx} className={`p-2 rounded-md ${item.active ? 'bg-[#1e2a3a] text-[#5fd0e0]' : 'text-slate-500 hover:text-slate-300'}`}>
            <item.icon size={20} />
          </div>
        ))}
      </div>

      {/* MAIN CONTENT */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* HEADER */}
        <header className="border-b border-[#1e2a3a] bg-[#0f1729] p-4 shrink-0">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              {SUBMISSIONS.map(sub => (
                <button
                  key={sub.id}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium border flex items-center gap-2 transition-colors ${
                    sub.active 
                      ? 'bg-[#1e2a3a] border-[#5fd0e0]/30 text-white' 
                      : 'border-transparent text-slate-400 hover:bg-[#1e2a3a]/50'
                  }`}
                >
                  <span className="opacity-50">#{sub.id}</span>
                  {sub.status === "CORRECTIONS REQUESTED" && <span className="w-2 h-2 rounded-full bg-amber-500" />}
                  {sub.name}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <button className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-300 border border-[#1e2a3a] rounded-md hover:bg-[#1e2a3a]">
                <Filter size={14} /> Filter
              </button>
              <div className="flex gap-1 p-1 bg-[#0b1220] rounded-md border border-[#1e2a3a]">
                <div className="w-3 h-3 rounded-full bg-[#ef4444] m-1" title="Blocker" />
                <div className="w-3 h-3 rounded-full bg-[#f59e0b] m-1" title="Concern" />
                <div className="w-3 h-3 rounded-full bg-[#60a5fa] m-1" title="Advisory" />
              </div>
              <button className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-white bg-[#1e2a3a] border border-[#1e2a3a] rounded-md hover:bg-[#2a3b52]">
                <Play size={14} className="text-[#5fd0e0]" /> Run Plan Review
              </button>
              <button className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-[#0b1220] bg-[#5fd0e0] rounded-md hover:bg-[#4bc0d0]">
                <Plus size={14} /> New Task
              </button>
            </div>
          </div>

          <div className="flex items-start justify-between bg-[#0b1220] border border-[#1e2a3a] rounded-lg p-4">
            <div>
              <div className="flex items-center gap-3 mb-1">
                <h2 className="text-lg font-semibold text-white">Submission #3</h2>
                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/10 text-amber-500 border border-amber-500/20">
                  CORRECTIONS REQUESTED
                </span>
                <span className="text-xs text-slate-500 flex items-center gap-1">
                  <Clock size={12} /> submitted 18 hr ago
                </span>
                <span className="text-xs text-slate-500 flex items-center gap-1">
                  <MessageSquare size={12} /> responded 4 hr ago
                </span>
              </div>
              <div className="mt-3 flex gap-3 text-sm text-slate-300 bg-[#1e2a3a]/50 p-3 rounded-md border border-[#1e2a3a]">
                <User size={16} className="text-slate-400 mt-0.5" />
                <div>
                  <span className="font-medium text-white">Jim Petersen</span> (Reviewer)
                  <p className="mt-1 text-slate-400">"3 setback issues plus fire-access lane needs widening."</p>
                </div>
              </div>
            </div>
            <button className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 shadow-[0_0_15px_rgba(37,99,235,0.3)] border border-blue-500">
              <Send size={16} /> Submit Revision
            </button>
          </div>
        </header>

        {/* KANBAN BOARD */}
        <div className="flex-1 overflow-x-auto p-6 bg-[#0b1220]">
          <div className="flex gap-6 h-full min-w-max">
            
            {/* COLUMN 1: Submitted */}
            <div className="w-80 flex flex-col gap-3">
              <div className="flex items-center justify-between text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-slate-500" />
                  Submitted <span className="bg-[#1e2a3a] px-1.5 rounded text-slate-300">3</span>
                </div>
              </div>
              
              <div className="bg-[#0f1729] border-2 border-[#5fd0e0]/30 rounded-lg p-4 relative shadow-[0_0_20px_rgba(95,208,224,0.05)]">
                <div className="absolute top-0 left-0 w-full h-1 bg-[#5fd0e0] rounded-t-lg" />
                <div className="flex justify-between items-start mb-2">
                  <span className="text-xs font-bold text-[#5fd0e0]">ACTIVE (#3)</span>
                  <span className="text-[10px] text-slate-500">18 hr ago</span>
                </div>
                <h3 className="font-medium text-white mb-3">Grand County R-2</h3>
                <div className="flex gap-2">
                  <span className="px-2 py-1 bg-red-500/10 text-red-400 border border-red-500/20 rounded text-xs">2 Blockers</span>
                  <span className="px-2 py-1 bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded text-xs">2 Concerns</span>
                </div>
              </div>

              <div className="bg-[#0f1729] border border-[#1e2a3a] rounded-lg p-3 opacity-60">
                <div className="flex justify-between items-start mb-1">
                  <span className="text-xs font-bold text-slate-400">CLOSED (#2)</span>
                  <span className="text-[10px] text-slate-500">1 wk ago</span>
                </div>
                <h3 className="text-sm font-medium text-slate-300 mb-2">Grand County R-2</h3>
                <span className="px-2 py-0.5 bg-slate-800 text-slate-400 rounded text-[10px]">1 Issue Resolved</span>
              </div>

              <div className="bg-[#0f1729] border border-[#1e2a3a] rounded-lg p-3 opacity-40">
                <div className="flex justify-between items-start mb-1">
                  <span className="text-xs font-bold text-slate-400">CLOSED (#1)</span>
                  <span className="text-[10px] text-slate-500">3 wk ago</span>
                </div>
                <h3 className="text-sm font-medium text-slate-300">Grand County R-2</h3>
              </div>
            </div>

            {/* COLUMN 2: Findings Open */}
            <div className="w-80 flex flex-col gap-3">
              <div className="flex items-center justify-between text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-amber-500" />
                  Findings Open <span className="bg-[#1e2a3a] px-1.5 rounded text-slate-300">4</span>
                </div>
              </div>

              {/* F-12 Blocker */}
              <div className="bg-[#0f1729] border border-[#1e2a3a] rounded-lg relative overflow-hidden group hover:border-slate-600 transition-colors">
                <div className="absolute top-0 left-0 w-full h-1 bg-[#ef4444]" />
                <div className="p-3 border-b border-[#1e2a3a] bg-[#0b1220]/50 flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <GripVertical size={14} className="text-slate-600 cursor-grab" />
                    <span className="text-xs font-mono text-[#ef4444]">F-12</span>
                    <span className="text-xs text-slate-400">Setback</span>
                  </div>
                  <MoreHorizontal size={14} className="text-slate-500 cursor-pointer" />
                </div>
                <div className="p-3">
                  <p className="text-sm text-slate-200 mb-3">Front setback 14 ft, required 20 ft (Grand County R-2 §3.4)</p>
                  <div className="flex items-center gap-1 text-[10px] text-[#5fd0e0] bg-[#5fd0e0]/10 px-2 py-1 rounded inline-flex mb-3">
                    <Layers size={10} /> Wall W-A-101
                  </div>
                  <div className="flex gap-2">
                    <button className="flex-1 text-xs py-1.5 bg-[#1e2a3a] text-white rounded hover:bg-[#2a3b52] transition-colors">Address</button>
                    <button className="flex-1 text-xs py-1.5 border border-[#1e2a3a] text-slate-400 rounded hover:bg-[#1e2a3a] transition-colors">Override</button>
                  </div>
                </div>
              </div>

              {/* F-13 Blocker */}
              <div className="bg-[#0f1729] border border-[#1e2a3a] rounded-lg relative overflow-hidden group hover:border-slate-600 transition-colors">
                <div className="absolute top-0 left-0 w-full h-1 bg-[#ef4444]" />
                <div className="p-3 border-b border-[#1e2a3a] bg-[#0b1220]/50 flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <GripVertical size={14} className="text-slate-600 cursor-grab" />
                    <span className="text-xs font-mono text-[#ef4444]">F-13</span>
                    <span className="text-xs text-slate-400">Fire Access</span>
                  </div>
                </div>
                <div className="p-3">
                  <p className="text-sm text-slate-200 mb-3">Fire access lane 18 ft, required 20 ft (IFC 503.2.1)</p>
                  <div className="flex items-center gap-1 text-[10px] text-[#5fd0e0] bg-[#5fd0e0]/10 px-2 py-1 rounded inline-flex mb-3">
                    <Layers size={10} /> Sheet A-1.1
                  </div>
                  <div className="flex gap-2">
                    <button className="flex-1 text-xs py-1.5 bg-[#1e2a3a] text-white rounded hover:bg-[#2a3b52]">Address</button>
                    <button className="flex-1 text-xs py-1.5 border border-[#1e2a3a] text-slate-400 rounded hover:bg-[#1e2a3a]">Override</button>
                  </div>
                </div>
              </div>

              {/* F-14 Concern */}
              <div className="bg-[#0f1729] border border-[#1e2a3a] rounded-lg relative overflow-hidden group hover:border-slate-600 transition-colors">
                <div className="absolute top-0 left-0 w-full h-1 bg-[#f59e0b]" />
                <div className="p-3 border-b border-[#1e2a3a] bg-[#0b1220]/50 flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <GripVertical size={14} className="text-slate-600 cursor-grab" />
                    <span className="text-xs font-mono text-[#f59e0b]">F-14</span>
                    <span className="text-xs text-slate-400">Setback</span>
                  </div>
                </div>
                <div className="p-3">
                  <p className="text-sm text-slate-200 mb-3">Side setback 9 ft, required 10 ft</p>
                  <div className="flex items-center gap-1 text-[10px] text-[#5fd0e0] bg-[#5fd0e0]/10 px-2 py-1 rounded inline-flex mb-3">
                    <Layers size={10} /> Wall W-B-203
                  </div>
                  <div className="flex gap-2">
                    <button className="flex-1 text-xs py-1.5 bg-[#1e2a3a] text-white rounded hover:bg-[#2a3b52]">Address</button>
                    <button className="flex-1 text-xs py-1.5 border border-[#1e2a3a] text-slate-400 rounded hover:bg-[#1e2a3a]">Override</button>
                  </div>
                </div>
              </div>

              {/* F-15 Concern */}
              <div className="bg-[#0f1729] border border-[#1e2a3a] rounded-lg relative overflow-hidden group hover:border-slate-600 transition-colors">
                <div className="absolute top-0 left-0 w-full h-1 bg-[#f59e0b]" />
                <div className="p-3 border-b border-[#1e2a3a] bg-[#0b1220]/50 flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <GripVertical size={14} className="text-slate-600 cursor-grab" />
                    <span className="text-xs font-mono text-[#f59e0b]">F-15</span>
                    <span className="text-xs text-slate-400">Coverage</span>
                  </div>
                </div>
                <div className="p-3">
                  <p className="text-sm text-slate-200 mb-3">Lot coverage 42%, recommended ≤40%</p>
                  <div className="flex items-center gap-1 text-[10px] text-[#5fd0e0] bg-[#5fd0e0]/10 px-2 py-1 rounded inline-flex mb-3">
                    <Layers size={10} /> Sheet A1
                  </div>
                  <div className="flex gap-2">
                    <button className="flex-1 text-xs py-1.5 bg-[#1e2a3a] text-white rounded hover:bg-[#2a3b52]">Address</button>
                    <button className="flex-1 text-xs py-1.5 border border-[#1e2a3a] text-slate-400 rounded hover:bg-[#1e2a3a]">Override</button>
                  </div>
                </div>
              </div>

            </div>

            {/* COLUMN 3: In Progress (Tasks) */}
            <div className="w-80 flex flex-col gap-3">
              <div className="flex items-center justify-between text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-[#5fd0e0]" />
                  In Progress <span className="bg-[#1e2a3a] px-1.5 rounded text-slate-300">1</span>
                </div>
                <div className="w-full h-[2px] bg-[#5fd0e0] absolute top-12 left-0 hidden" /> {/* Drop indicator concept */}
              </div>

              {/* RT-201 */}
              <div className="bg-[#0f1729] border border-[#1e2a3a] rounded-lg p-3 group hover:border-slate-600 transition-colors">
                <div className="flex justify-between items-start mb-2">
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] text-slate-500 font-mono">RT-201 · <span className="text-[#ef4444]">F-12</span></span>
                    <span className="text-xs font-medium text-[#5fd0e0]">IN PROGRESS</span>
                  </div>
                  <GripVertical size={14} className="text-slate-600 cursor-grab" />
                </div>
                <p className="text-sm text-white mb-4">Shift building footprint north 6 ft to meet front setback</p>
                <div className="w-full bg-[#1e2a3a] h-1.5 rounded-full mb-4 overflow-hidden">
                  <div className="bg-[#5fd0e0] h-full w-[40%]" />
                </div>
                <div className="flex justify-between items-center pt-2 border-t border-[#1e2a3a]">
                  <div className="flex items-center gap-1 text-[10px] text-slate-400">
                    <Clock size={12} className="text-amber-500" /> due Friday
                  </div>
                  <div className="w-6 h-6 rounded-full bg-purple-900 flex items-center justify-center text-[10px] font-bold text-white border border-[#1e2a3a]" title="Maria">
                    M
                  </div>
                </div>
              </div>

              <div className="border border-dashed border-[#1e2a3a] rounded-lg h-24 flex items-center justify-center text-slate-600 text-sm">
                Drop to start work
              </div>
            </div>

            {/* COLUMN 4: Done */}
            <div className="w-80 flex flex-col gap-3">
              <div className="flex items-center justify-between text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-[#22c55e]" />
                  Done <span className="bg-[#1e2a3a] px-1.5 rounded text-slate-300">1</span>
                </div>
              </div>

              {/* RT-205 */}
              <div className="bg-[#0f1729] border border-[#1e2a3a] rounded-lg p-3 opacity-80">
                <div className="flex justify-between items-start mb-2">
                  <span className="text-[10px] text-slate-500 font-mono">RT-205 · <span className="text-[#60a5fa]">F-16</span></span>
                  <CheckCircle2 size={16} className="text-[#22c55e]" />
                </div>
                <p className="text-sm text-slate-300 line-through mb-4">Revise lobby detail for ADA threshold note</p>
                <div className="flex justify-between items-center pt-2 border-t border-[#1e2a3a]">
                  <div className="text-[10px] text-slate-500">
                    Completed yesterday
                  </div>
                  <div className="w-6 h-6 rounded-full bg-teal-900 flex items-center justify-center text-[10px] font-bold text-white border border-[#1e2a3a]" title="Sam">
                    S
                  </div>
                </div>
              </div>
            </div>

            {/* COLUMN 5: Resubmitted / Resolved */}
            <div className="w-80 flex flex-col gap-3 pr-6">
              <div className="flex items-center justify-between text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-slate-500" />
                  Resolved <span className="bg-[#1e2a3a] px-1.5 rounded text-slate-300">1</span>
                </div>
              </div>

              {/* Old closed finding */}
              <div className="bg-[#0f1729] border border-[#1e2a3a] rounded-lg p-3 opacity-50">
                <div className="flex justify-between items-start mb-2">
                  <span className="text-[10px] text-slate-500 font-mono">F-08 · Height</span>
                  <span className="text-[10px] text-[#22c55e] border border-[#22c55e]/30 px-1 rounded">RESOLVED in #2</span>
                </div>
                <p className="text-sm text-slate-400">Height limit exceeded on east elevation.</p>
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
