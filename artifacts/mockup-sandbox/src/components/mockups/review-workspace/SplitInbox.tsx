import React, { useState } from "react";
import {
  Search,
  Filter,
  MoreHorizontal,
  ChevronDown,
  CheckCircle2,
  Circle,
  AlertCircle,
  AlertTriangle,
  Info,
  ChevronRight,
  ExternalLink,
  MessageSquare,
  Clock,
  Plus,
  PlayCircle,
  CheckSquare,
  CornerDownRight,
  Send,
  Building,
  FileText,
  History,
  LayoutDashboard
} from "lucide-react";

export function SplitInbox() {
  const [selectedFindingId, setSelectedFindingId] = useState("F-12");

  return (
    <div
      className="flex h-screen w-full overflow-hidden text-sm font-sans"
      style={{
        backgroundColor: "#0b1220",
        color: "#e2e8f0",
        fontFamily: "'Inter', -apple-system, sans-serif"
      }}
    >
      {/* GLOBAL LEFT NAV (SIMULATED) */}
      <div
        className="w-14 flex flex-col items-center py-4 border-r flex-shrink-0"
        style={{ borderColor: "#1e2a3a", backgroundColor: "#0f1729" }}
      >
        <div className="w-8 h-8 rounded bg-blue-600 flex items-center justify-center mb-8 font-bold text-white">
          S
        </div>
        <div className="flex flex-col gap-6 text-slate-500">
          <LayoutDashboard className="w-5 h-5 cursor-pointer hover:text-slate-300" />
          <Building className="w-5 h-5 cursor-pointer hover:text-slate-300" />
          <div className="relative">
            <CheckSquare
              className="w-5 h-5 cursor-pointer text-cyan-400"
              style={{ color: "#5fd0e0" }}
            />
            <div className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-red-500 border border-[#0f1729]"></div>
          </div>
          <History className="w-5 h-5 cursor-pointer hover:text-slate-300" />
        </div>
      </div>

      {/* LEFT PANE: Finding List */}
      <div
        className="flex flex-col border-r flex-shrink-0"
        style={{ width: "340px", borderColor: "#1e2a3a", backgroundColor: "#0b1220" }}
      >
        <div className="p-4 border-b flex flex-col gap-3" style={{ borderColor: "#1e2a3a" }}>
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-white">Triage Inbox</h2>
            <div className="flex gap-2 text-slate-400">
              <Search className="w-4 h-4 cursor-pointer hover:text-white" />
              <Filter className="w-4 h-4 cursor-pointer hover:text-white" />
            </div>
          </div>
          <div className="flex gap-4 text-xs font-medium border-b" style={{ borderColor: "#1e2a3a" }}>
            <div
              className="pb-2 border-b-2 cursor-pointer"
              style={{ borderColor: "#5fd0e0", color: "#5fd0e0" }}
            >
              Open (4)
            </div>
            <div className="pb-2 text-slate-500 cursor-pointer hover:text-slate-300">All (5)</div>
            <div className="pb-2 text-slate-500 cursor-pointer hover:text-slate-300">Overridden</div>
          </div>
          <div className="flex justify-between items-center text-xs text-slate-400">
            <div className="flex items-center gap-1 cursor-pointer hover:text-slate-300">
              Sort: Severity <ChevronDown className="w-3 h-3" />
            </div>
            <div className="flex items-center gap-1 cursor-pointer hover:text-slate-300">
              Category: All <ChevronDown className="w-3 h-3" />
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Group: Submission 3 */}
          <div className="sticky top-0 z-10 px-3 py-1.5 text-xs font-medium flex items-center gap-2" style={{ backgroundColor: "#0f1729", borderBottom: "1px solid #1e2a3a", borderTop: "1px solid #1e2a3a" }}>
            <ChevronDown className="w-3 h-3 text-slate-400" />
            <span className="text-slate-300">Submission #3</span>
            <span className="text-slate-500 ml-auto">4 open</span>
          </div>

          {/* Finding: F-12 */}
          <div
            className={`p-3 border-b flex flex-col gap-1.5 cursor-pointer border-l-2`}
            style={{
              borderColor: selectedFindingId === "F-12" ? "#1e2a3a" : "#1e2a3a",
              borderLeftColor: selectedFindingId === "F-12" ? "#5fd0e0" : "transparent",
              backgroundColor: selectedFindingId === "F-12" ? "#0f1729" : "transparent",
            }}
            onClick={() => setSelectedFindingId("F-12")}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: "#ef4444" }}></div>
                <span className="text-xs font-medium text-slate-300">F-12 · Setback</span>
              </div>
              <span className="text-[10px] text-slate-500">Wall W-A-101</span>
            </div>
            <div className="text-sm font-medium text-white line-clamp-1">
              Front setback 14 ft, required 20 ft
            </div>
            <div className="flex items-center justify-between mt-1">
              <div className="flex items-center gap-1.5">
                <div className="flex items-center justify-center w-4 h-4 rounded-full bg-slate-800 text-[9px] font-bold text-slate-400">M</div>
                <span className="text-[10px] text-slate-400">0 of 2 tasks done</span>
              </div>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">OPEN</span>
            </div>
          </div>

          {/* Finding: F-13 */}
          <div
            className="p-3 border-b flex flex-col gap-1.5 cursor-pointer hover:bg-slate-900/50 border-l-2 border-l-transparent"
            style={{ borderColor: "#1e2a3a" }}
            onClick={() => setSelectedFindingId("F-13")}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: "#ef4444" }}></div>
                <span className="text-xs font-medium text-slate-300">F-13 · Fire access</span>
              </div>
              <span className="text-[10px] text-slate-500">Sheet A-1.1</span>
            </div>
            <div className="text-sm text-slate-300 line-clamp-1">
              Fire access lane 18 ft, required 20 ft
            </div>
            <div className="flex items-center justify-between mt-1">
              <div className="flex items-center gap-1.5">
                <div className="flex items-center justify-center w-4 h-4 rounded-full bg-slate-800 text-[9px] font-bold text-slate-400">M</div>
                <span className="text-[10px] text-slate-400">1 task open</span>
              </div>
            </div>
          </div>

          {/* Finding: F-14 */}
          <div
            className="p-3 border-b flex flex-col gap-1.5 cursor-pointer hover:bg-slate-900/50 border-l-2 border-l-transparent"
            style={{ borderColor: "#1e2a3a" }}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: "#f59e0b" }}></div>
                <span className="text-xs font-medium text-slate-300">F-14 · Setback</span>
              </div>
              <span className="text-[10px] text-slate-500">Wall W-B-203</span>
            </div>
            <div className="text-sm text-slate-300 line-clamp-1">
              Side setback 9 ft, required 10 ft
            </div>
            <div className="flex items-center justify-between mt-1">
              <div className="flex items-center gap-1.5">
                <div className="flex items-center justify-center w-4 h-4 rounded-full bg-slate-800 text-[9px] font-bold text-slate-400">S</div>
                <span className="text-[10px] text-slate-400">1 task open</span>
              </div>
            </div>
          </div>

          {/* Finding: F-15 */}
          <div
            className="p-3 border-b flex flex-col gap-1.5 cursor-pointer hover:bg-slate-900/50 border-l-2 border-l-transparent"
            style={{ borderColor: "#1e2a3a" }}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: "#f59e0b" }}></div>
                <span className="text-xs font-medium text-slate-300">F-15 · Coverage</span>
              </div>
              <span className="text-[10px] text-slate-500">Sheet A1</span>
            </div>
            <div className="text-sm text-slate-300 line-clamp-1">
              Lot coverage 42%, recommended ≤40%
            </div>
            <div className="flex items-center justify-between mt-1">
              <div className="flex items-center gap-1.5">
                <div className="flex items-center justify-center w-4 h-4 rounded-full bg-slate-800 text-[9px] font-bold text-slate-400">M</div>
                <span className="text-[10px] text-slate-400">1 task open</span>
              </div>
            </div>
          </div>

          {/* Group: Submission 2 */}
          <div className="sticky top-0 z-10 px-3 py-1.5 text-xs font-medium flex items-center gap-2" style={{ backgroundColor: "#0f1729", borderBottom: "1px solid #1e2a3a", borderTop: "1px solid #1e2a3a" }}>
            <ChevronRight className="w-3 h-3 text-slate-500" />
            <span className="text-slate-400">Submission #2</span>
            <span className="text-slate-600 ml-auto">resolved</span>
          </div>

          {/* Group: Submission 1 */}
          <div className="sticky top-0 z-10 px-3 py-1.5 text-xs font-medium flex items-center gap-2" style={{ backgroundColor: "#0f1729", borderBottom: "1px solid #1e2a3a", borderTop: "1px solid #1e2a3a" }}>
            <ChevronRight className="w-3 h-3 text-slate-500" />
            <span className="text-slate-400">Submission #1</span>
            <span className="text-slate-600 ml-auto">resolved</span>
          </div>
        </div>

        <div className="p-3 border-t text-[10px] text-slate-500 flex justify-center gap-3" style={{ borderColor: "#1e2a3a", backgroundColor: "#0f1729" }}>
          <span><kbd className="font-mono bg-slate-800 px-1 py-0.5 rounded mr-1">j</kbd><kbd className="font-mono bg-slate-800 px-1 py-0.5 rounded">k</kbd> navigate</span>
          <span><kbd className="font-mono bg-slate-800 px-1 py-0.5 rounded">e</kbd> address</span>
          <span><kbd className="font-mono bg-slate-800 px-1 py-0.5 rounded">⌘↵</kbd> done</span>
        </div>
      </div>

      {/* CENTER PANE: Selected Finding Detail */}
      <div className="flex-1 flex flex-col min-w-0 bg-[#0b1220]">
        <div className="p-4 border-b flex items-center justify-between flex-shrink-0" style={{ borderColor: "#1e2a3a" }}>
          <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
            <span className="cursor-pointer hover:text-slate-300">Submission #3</span>
            <ChevronRight className="w-3 h-3" />
            <span className="text-white">F-12 · Front setback</span>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wide" style={{ backgroundColor: "rgba(239, 68, 68, 0.1)", color: "#ef4444" }}>BLOCKER</span>
          </div>
          <div className="flex items-center gap-2">
            <button className="px-3 py-1.5 text-xs font-medium rounded border hover:bg-slate-800 transition-colors" style={{ borderColor: "#1e2a3a", color: "#e2e8f0" }}>
              Address with next revision
            </button>
            <button className="px-3 py-1.5 text-xs font-medium rounded border hover:bg-slate-800 transition-colors" style={{ borderColor: "#1e2a3a", color: "#e2e8f0" }}>
              Override
            </button>
            <button className="p-1.5 rounded border hover:bg-slate-800 transition-colors" style={{ borderColor: "#1e2a3a", color: "#e2e8f0" }}>
              <MoreHorizontal className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6">
          {/* Submission Context Strip */}
          <div className="p-3 rounded-lg border flex flex-col gap-2" style={{ backgroundColor: "#0f1729", borderColor: "#1e2a3a" }}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <MessageSquare className="w-3 h-3" />
                <span>Reviewer comment from Jim Petersen (Grand County)</span>
              </div>
              <a href="#" className="text-xs flex items-center gap-1 hover:underline" style={{ color: "#5fd0e0" }}>
                View full submission <ExternalLink className="w-3 h-3" />
              </a>
            </div>
            <p className="text-sm italic text-slate-300">"3 setback issues plus fire-access lane needs widening."</p>
          </div>

          {/* Finding Body */}
          <div className="flex flex-col gap-4">
            <h1 className="text-2xl font-semibold text-white">Front setback 14 ft, required 20 ft</h1>
            
            <div className="flex gap-6">
              <div className="flex-1 flex flex-col gap-4 text-sm text-slate-300 leading-relaxed">
                <p>
                  The front setback measured from the property line to the primary building envelope on the north elevation is 14'-2", which violates the minimum 20'-0" requirement for R-2 zoning in Grand County.
                </p>
                <div className="pl-4 py-2 border-l-2 text-slate-400 bg-slate-900/30 rounded-r" style={{ borderColor: "#f59e0b" }}>
                  <div className="font-medium text-xs mb-1 text-slate-300">Grand County R-2 §3.4 - Minimum Setbacks</div>
                  "Primary structures in R-2 zoning districts shall maintain a minimum front setback of 20 feet from the property line..."
                </div>
              </div>

              {/* BIM Element Preview */}
              <div className="w-64 rounded border p-2 flex flex-col gap-2 flex-shrink-0" style={{ backgroundColor: "#0f1729", borderColor: "#1e2a3a" }}>
                <div className="text-xs font-medium text-slate-400 flex items-center justify-between">
                  <span>Element Ref: Wall W-A-101</span>
                  <ExternalLink className="w-3 h-3 cursor-pointer hover:text-white" />
                </div>
                <div className="aspect-video bg-slate-800 rounded relative overflow-hidden flex items-center justify-center border border-slate-700">
                  {/* Faux BIM preview */}
                  <div className="absolute inset-0 opacity-20" style={{ backgroundImage: "linear-gradient(#334155 1px, transparent 1px), linear-gradient(90deg, #334155 1px, transparent 1px)", backgroundSize: "10px 10px" }}></div>
                  <div className="w-32 h-2 bg-blue-500/30 border border-blue-400 rotate-12 absolute"></div>
                  <div className="absolute top-2 left-2 text-[9px] font-mono text-cyan-400 bg-black/50 px-1 rounded">14'-2"</div>
                </div>
              </div>
            </div>
          </div>

          {/* Response Tasks */}
          <div className="mt-4 pt-6 border-t flex flex-col gap-4" style={{ borderColor: "#1e2a3a" }}>
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-white flex items-center gap-2">
                Response Tasks <span className="text-xs bg-slate-800 px-1.5 py-0.5 rounded text-slate-400">2</span>
              </h3>
              <button className="flex items-center gap-1 text-xs font-medium px-2 py-1 rounded hover:bg-slate-800" style={{ color: "#5fd0e0" }}>
                <Plus className="w-3 h-3" /> New task
              </button>
            </div>

            <div className="flex flex-col gap-2">
              {/* Task 1 */}
              <div className="rounded border p-3 flex flex-col gap-2 bg-slate-900/40" style={{ borderColor: "#1e2a3a" }}>
                <div className="flex items-start gap-3">
                  <PlayCircle className="w-4 h-4 text-cyan-400 mt-0.5 flex-shrink-0" />
                  <div className="flex-1 flex flex-col gap-1">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-sm text-slate-200">Shift building footprint north 6 ft to meet front setback</span>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border border-cyan-900/50 bg-cyan-950/30" style={{ color: "#5fd0e0" }}>IN PROGRESS</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-slate-500">
                      <span className="flex items-center gap-1"><span className="w-4 h-4 rounded-full bg-slate-700 flex items-center justify-center text-[9px] text-white">M</span> Maria (architect)</span>
                      <span>·</span>
                      <span className="flex items-center gap-1 text-red-400"><Clock className="w-3 h-3" /> Due Friday</span>
                    </div>
                  </div>
                </div>
                <div className="ml-7 mt-1 p-2 rounded text-xs text-slate-400 border border-slate-800 bg-slate-900">
                  <span className="text-slate-300 font-medium">Update:</span> Footprint shifted 4 ft, 2 more to go. Need to verify structural grid alignment before finalizing.
                </div>
              </div>

              {/* Task 2 */}
              <div className="rounded border p-3 flex flex-col gap-2 hover:bg-slate-800/30 transition-colors" style={{ borderColor: "#1e2a3a", backgroundColor: "#0f1729" }}>
                <div className="flex items-start gap-3">
                  <Circle className="w-4 h-4 text-slate-500 mt-0.5 flex-shrink-0 cursor-pointer hover:text-slate-300" />
                  <div className="flex-1 flex flex-col gap-1">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-sm text-slate-300">Update landscape grading plan to accommodate shifted footprint</span>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border border-slate-700 bg-slate-800 text-slate-400">OPEN</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-slate-500">
                      <span className="flex items-center gap-1"><span className="w-4 h-4 rounded-full bg-slate-700 flex items-center justify-center text-[9px] text-white">S</span> Sam (designer)</span>
                      <span>·</span>
                      <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> Due Friday</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Activity */}
          <div className="mt-8 pt-4 flex flex-col gap-3">
            <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Activity</h4>
            <div className="flex flex-col gap-0 relative">
              <div className="absolute left-2 top-2 bottom-2 w-px bg-slate-800"></div>
              
              <div className="flex items-center gap-3 py-1.5 relative z-10">
                <div className="w-4 h-4 rounded-full bg-slate-800 border-2 flex items-center justify-center flex-shrink-0" style={{ borderColor: "#0b1220" }}>
                  <div className="w-1.5 h-1.5 rounded-full bg-slate-500"></div>
                </div>
                <div className="text-xs text-slate-400">
                  <span className="font-medium text-slate-300">Maria</span> started RT-201
                  <span className="text-slate-600 ml-2">4 hr ago</span>
                </div>
              </div>

              <div className="flex items-center gap-3 py-1.5 relative z-10">
                <div className="w-4 h-4 rounded-full bg-slate-800 border-2 flex items-center justify-center flex-shrink-0" style={{ borderColor: "#0b1220" }}>
                  <div className="w-1.5 h-1.5 rounded-full bg-slate-500"></div>
                </div>
                <div className="text-xs text-slate-400">
                  <span className="font-medium text-slate-300">Maria</span> created RT-201 and RT-202
                  <span className="text-slate-600 ml-2">16 hr ago</span>
                </div>
              </div>

              <div className="flex items-center gap-3 py-1.5 relative z-10">
                <div className="w-4 h-4 rounded-full bg-slate-800 border-2 flex items-center justify-center flex-shrink-0" style={{ borderColor: "#0b1220" }}>
                  <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: "#5fd0e0" }}></div>
                </div>
                <div className="text-xs text-slate-400">
                  <span className="font-medium" style={{ color: "#5fd0e0" }}>AI Plan Review</span> created finding
                  <span className="text-slate-600 ml-2">18 hr ago</span>
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>

      {/* RIGHT PANE: Submission Context */}
      <div
        className="flex flex-col border-l flex-shrink-0"
        style={{ width: "280px", borderColor: "#1e2a3a", backgroundColor: "#0f1729" }}
      >
        <div className="p-4 border-b flex flex-col gap-4" style={{ borderColor: "#1e2a3a" }}>
          <div className="flex flex-col gap-1">
            <div className="text-xs font-semibold text-slate-500 tracking-wide uppercase">Active Submission</div>
            <h2 className="text-lg font-semibold text-white">#3 — Grand County</h2>
          </div>
          
          <div className="px-2 py-1 rounded text-xs font-bold w-fit border" style={{ backgroundColor: "rgba(245, 158, 11, 0.1)", color: "#f59e0b", borderColor: "rgba(245, 158, 11, 0.2)" }}>
            CORRECTIONS REQUESTED
          </div>

          <div className="flex flex-col gap-2 text-xs text-slate-400 mt-2">
            <div className="flex justify-between">
              <span>Submitted</span>
              <span className="text-slate-300">18 hr ago</span>
            </div>
            <div className="flex justify-between">
              <span>Responded</span>
              <span className="text-slate-300">4 hr ago</span>
            </div>
          </div>
        </div>

        <div className="p-4 flex flex-col gap-6 flex-1 overflow-y-auto">
          {/* Reviewer Comment */}
          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Reviewer Comment</h3>
            <div className="text-sm text-slate-300 italic p-3 rounded bg-slate-800/50 border border-slate-700/50">
              "3 setback issues plus fire-access lane needs widening. Please address these before next review cycle."
              <div className="mt-2 text-xs font-medium text-slate-400 flex items-center justify-end gap-1">
                — Jim Petersen
              </div>
            </div>
          </div>

          {/* Findings Summary */}
          <div className="flex flex-col gap-3">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Findings Summary</h3>
            
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2 text-slate-300">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: "#ef4444" }}></div>
                  Blockers
                </div>
                <span className="font-medium text-white">2 open</span>
              </div>
              <div className="w-full h-1.5 rounded-full bg-slate-800 overflow-hidden">
                <div className="h-full rounded-full" style={{ width: "50%", backgroundColor: "#ef4444" }}></div>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2 text-slate-300">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: "#f59e0b" }}></div>
                  Concerns
                </div>
                <span className="font-medium text-white">2 open</span>
              </div>
              <div className="w-full h-1.5 rounded-full bg-slate-800 overflow-hidden">
                <div className="h-full rounded-full" style={{ width: "50%", backgroundColor: "#f59e0b" }}></div>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2 text-slate-300">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: "#60a5fa" }}></div>
                  Advisory
                </div>
                <span className="font-medium text-slate-500">0 open</span>
              </div>
            </div>
          </div>

          {/* Quick Actions */}
          <div className="mt-4 flex flex-col gap-2">
            <button className="flex items-center gap-2 text-xs text-slate-300 hover:text-white p-2 rounded hover:bg-slate-800 transition-colors">
              <PlayCircle className="w-4 h-4" style={{ color: "#5fd0e0" }} /> Run plan review
            </button>
            <button className="flex items-center gap-2 text-xs text-slate-300 hover:text-white p-2 rounded hover:bg-slate-800 transition-colors">
              <FileText className="w-4 h-4 text-slate-400" /> Export findings report
            </button>
          </div>
        </div>

        {/* Primary CTA */}
        <div className="p-4 border-t mt-auto" style={{ borderColor: "#1e2a3a", backgroundColor: "#0b1220" }}>
          <button 
            className="w-full py-2.5 rounded font-medium text-sm flex items-center justify-center gap-2 text-[#0b1220] transition-opacity hover:opacity-90 shadow-[0_0_15px_rgba(95,208,224,0.15)]"
            style={{ backgroundColor: "#5fd0e0" }}
          >
            <Send className="w-4 h-4" /> Submit revision
          </button>
        </div>
      </div>
    </div>
  );
}
