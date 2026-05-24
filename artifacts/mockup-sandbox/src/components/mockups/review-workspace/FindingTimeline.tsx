import React, { useState } from 'react';
import {
  ActivitySquare,
  AlertTriangle,
  Building,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDashed,
  Clock,
  CornerDownRight,
  Filter,
  Flame,
  LayoutDashboard,
  Layers,
  MessageSquare,
  MoreHorizontal,
  Play,
  Plus,
  Ruler,
  Search,
  Settings,
  ShieldAlert,
  SlidersHorizontal,
  User,
  Zap,
  Info
} from 'lucide-react';

export function FindingTimeline() {
  const [expandedId, setExpandedId] = useState<string>('F-12');

  const toggleExpand = (id: string) => {
    setExpandedId(prev => (prev === id ? '' : id));
  };

  return (
    <div className="flex h-[900px] w-[1280px] bg-[#0b1220] text-slate-300 font-sans overflow-hidden">
      {/* LEFT RAIL: Filters */}
      <div className="w-[240px] flex-shrink-0 border-r border-[#1e2a3a] bg-[#0f1729] flex flex-col">
        <div className="h-12 border-b border-[#1e2a3a] flex items-center px-4">
          <Filter className="w-4 h-4 text-slate-400 mr-2" />
          <span className="text-xs font-semibold text-slate-200 uppercase tracking-wider">Filters</span>
        </div>
        
        <div className="flex-1 overflow-y-auto p-4 space-y-6 custom-scrollbar">
          {/* Status Filter */}
          <div>
            <h3 className="text-xs font-medium text-slate-400 mb-3 uppercase">Status</h3>
            <div className="space-y-2">
              <label className="flex items-center space-x-2 text-sm cursor-pointer group">
                <div className="w-4 h-4 border border-[#5fd0e0] rounded bg-[#5fd0e0]/20 flex items-center justify-center">
                  <CheckCircle2 className="w-3 h-3 text-[#5fd0e0]" />
                </div>
                <span className="text-slate-200 group-hover:text-white transition-colors">Open</span>
                <span className="ml-auto text-xs text-slate-500">4</span>
              </label>
              <label className="flex items-center space-x-2 text-sm cursor-pointer group">
                <div className="w-4 h-4 border border-[#1e2a3a] rounded flex items-center justify-center"></div>
                <span className="text-slate-400 group-hover:text-slate-200 transition-colors">Resolved</span>
                <span className="ml-auto text-xs text-slate-500">7</span>
              </label>
              <label className="flex items-center space-x-2 text-sm cursor-pointer group">
                <div className="w-4 h-4 border border-[#1e2a3a] rounded flex items-center justify-center"></div>
                <span className="text-slate-400 group-hover:text-slate-200 transition-colors">Overridden</span>
                <span className="ml-auto text-xs text-slate-500">1</span>
              </label>
            </div>
          </div>

          {/* Severity Filter */}
          <div>
            <h3 className="text-xs font-medium text-slate-400 mb-3 uppercase">Severity</h3>
            <div className="space-y-2">
              <label className="flex items-center space-x-2 text-sm cursor-pointer group">
                <div className="w-4 h-4 border border-[#5fd0e0] rounded bg-[#5fd0e0]/20 flex items-center justify-center">
                  <CheckCircle2 className="w-3 h-3 text-[#5fd0e0]" />
                </div>
                <div className="w-2 h-2 rounded-full bg-[#ef4444]"></div>
                <span className="text-slate-200 group-hover:text-white transition-colors">Blocker</span>
                <span className="ml-auto text-xs text-slate-500">2</span>
              </label>
              <label className="flex items-center space-x-2 text-sm cursor-pointer group">
                <div className="w-4 h-4 border border-[#5fd0e0] rounded bg-[#5fd0e0]/20 flex items-center justify-center">
                  <CheckCircle2 className="w-3 h-3 text-[#5fd0e0]" />
                </div>
                <div className="w-2 h-2 rounded-full bg-[#f59e0b]"></div>
                <span className="text-slate-200 group-hover:text-white transition-colors">Concern</span>
                <span className="ml-auto text-xs text-slate-500">2</span>
              </label>
              <label className="flex items-center space-x-2 text-sm cursor-pointer group">
                <div className="w-4 h-4 border border-[#1e2a3a] rounded flex items-center justify-center"></div>
                <div className="w-2 h-2 rounded-full bg-[#60a5fa]"></div>
                <span className="text-slate-400 group-hover:text-slate-200 transition-colors">Advisory</span>
                <span className="ml-auto text-xs text-slate-500">1</span>
              </label>
            </div>
          </div>

          {/* Category Filter */}
          <div>
            <h3 className="text-xs font-medium text-slate-400 mb-3 uppercase">Category</h3>
            <div className="space-y-2">
              <label className="flex items-center space-x-2 text-sm cursor-pointer group">
                <div className="w-4 h-4 border border-[#5fd0e0] rounded bg-[#5fd0e0]/20 flex items-center justify-center">
                  <CheckCircle2 className="w-3 h-3 text-[#5fd0e0]" />
                </div>
                <span className="text-slate-200">Setback</span>
                <span className="ml-auto text-xs text-slate-500">2</span>
              </label>
              <label className="flex items-center space-x-2 text-sm cursor-pointer group">
                <div className="w-4 h-4 border border-[#5fd0e0] rounded bg-[#5fd0e0]/20 flex items-center justify-center">
                  <CheckCircle2 className="w-3 h-3 text-[#5fd0e0]" />
                </div>
                <span className="text-slate-200">Fire Access</span>
                <span className="ml-auto text-xs text-slate-500">1</span>
              </label>
              <label className="flex items-center space-x-2 text-sm cursor-pointer group">
                <div className="w-4 h-4 border border-[#5fd0e0] rounded bg-[#5fd0e0]/20 flex items-center justify-center">
                  <CheckCircle2 className="w-3 h-3 text-[#5fd0e0]" />
                </div>
                <span className="text-slate-200">Coverage</span>
                <span className="ml-auto text-xs text-slate-500">1</span>
              </label>
              <label className="flex items-center space-x-2 text-sm cursor-pointer group">
                <div className="w-4 h-4 border border-[#1e2a3a] rounded flex items-center justify-center"></div>
                <span className="text-slate-400">Accessibility</span>
                <span className="ml-auto text-xs text-slate-500">1</span>
              </label>
            </div>
          </div>
        </div>
      </div>

      {/* MAIN CANVAS */}
      <div className="flex-1 flex flex-col min-w-0 bg-[#0b1220]">
        {/* Top Header */}
        <div className="h-12 border-b border-[#1e2a3a] bg-[#0b1220]/80 backdrop-blur flex items-center justify-between px-6 flex-shrink-0">
          <div className="flex items-center gap-4">
            <h1 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
              <ActivitySquare className="w-4 h-4 text-[#5fd0e0]" />
              Review Timeline
            </h1>
            <div className="h-4 w-px bg-[#1e2a3a]"></div>
            <div className="flex items-center gap-3 text-xs">
              <span className="text-slate-400">12 findings total</span>
              <span className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-[#f59e0b]"></div><span className="text-amber-400 font-medium">4 open</span></span>
              <span className="text-slate-400">7 resolved</span>
              <span className="text-slate-400">1 overridden</span>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <button className="flex items-center gap-2 px-3 py-1.5 rounded bg-[#1e2a3a] hover:bg-[#28384e] text-xs font-medium text-slate-200 transition-colors">
              <Zap className="w-3.5 h-3.5 text-[#5fd0e0]" />
              Run Plan Review
            </button>
            <div className="h-4 w-px bg-[#1e2a3a]"></div>
            <div className="flex items-center gap-3 text-xs">
              <span className="text-slate-400">Latest submission: #3 · <span className="text-amber-400/80">awaiting revision</span></span>
              <button className="px-3 py-1.5 rounded bg-[#5fd0e0] hover:bg-[#4bc0d0] text-[#0b1220] font-semibold transition-colors">
                Submit revision
              </button>
            </div>
          </div>
        </div>

        {/* Timeline Feed */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          
          {/* Date separator */}
          <div className="flex items-center gap-4">
            <div className="h-px bg-[#1e2a3a] flex-1"></div>
            <span className="text-xs font-medium text-slate-500 uppercase tracking-widest">Submission #3 (18 hr ago)</span>
            <div className="h-px bg-[#1e2a3a] flex-1"></div>
          </div>

          {/* Finding F-12 (Expanded) */}
          <div className={`border rounded-lg bg-[#0f1729] shadow-sm transition-all duration-200 ${expandedId === 'F-12' ? 'border-[#5fd0e0]/40 ring-1 ring-[#5fd0e0]/10' : 'border-[#1e2a3a] hover:border-[#334155]'}`}>
            {/* Finding Header */}
            <div 
              className="p-4 flex items-start gap-4 cursor-pointer"
              onClick={() => toggleExpand('F-12')}
            >
              <div className="mt-1">{expandedId === 'F-12' ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-1.5">
                  <span className="text-xs font-mono text-slate-400">F-12</span>
                  <span className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-bold bg-[#ef4444]/10 text-[#ef4444] border border-[#ef4444]/20">
                    <ShieldAlert className="w-3 h-3" /> BLOCKER
                  </span>
                  <span className="text-sm font-semibold text-slate-200 flex items-center gap-1.5">
                    <Ruler className="w-3.5 h-3.5 text-slate-400" /> Setback
                  </span>
                  <div className="px-2 py-0.5 rounded-full border border-amber-500/30 text-amber-400 text-[10px] font-medium bg-amber-500/5">
                    OPEN
                  </div>
                  <span className="text-xs text-slate-500 ml-auto">from Sub. #3 · 18h ago</span>
                </div>
                <div className="flex items-center gap-2">
                  <p className="text-sm text-slate-300 truncate">Front setback 14 ft, required 20 ft.</p>
                  <button className="px-2 py-1 rounded bg-[#1e2a3a] hover:bg-[#28384e] text-xs text-cyan-400 font-mono transition-colors ml-auto border border-cyan-900/30">
                    W-A-101
                  </button>
                </div>
              </div>
            </div>

            {/* Expanded Body */}
            {expandedId === 'F-12' && (
              <div className="border-t border-[#1e2a3a] bg-[#0b1220]/50">
                <div className="p-5">
                  <p className="text-sm text-slate-300 mb-4 leading-relaxed">
                    The front setback measured to the primary street frontage is 14 feet. The zoning code for R-2 districts mandates a minimum 20-foot front setback. The entire north elevation of the primary volume needs adjustment to comply.
                  </p>
                  <div className="border-l-2 border-[#1e2a3a] pl-4 py-1 mb-6 bg-[#0f1729]/50 rounded-r">
                    <p className="text-xs text-slate-400 font-mono leading-relaxed">
                      "Grand County R-2 §3.4: Minimum front yard setback for primary structures shall be 20 feet from the property line abutting the primary street."
                    </p>
                  </div>

                  {/* Task Thread */}
                  <div className="space-y-3 pl-2">
                    <div className="flex items-center gap-3">
                      <div className="w-px h-full bg-[#1e2a3a] absolute left-[41px]"></div>
                      <CornerDownRight className="w-4 h-4 text-slate-500" />
                      <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Response Tasks</span>
                    </div>
                    
                    {/* Task 1 */}
                    <div className="ml-6 border border-[#1e2a3a] rounded-md bg-[#0f1729] p-3 flex items-center gap-4 relative z-10 group hover:border-[#5fd0e0]/30 transition-colors">
                      <div className="w-6 h-6 rounded bg-purple-500/20 text-purple-400 flex items-center justify-center text-xs font-bold shrink-0">
                        M
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-mono text-slate-500">RT-201</span>
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">IN PROGRESS</span>
                          <span className="text-xs text-slate-400 flex items-center gap-1 ml-auto">
                            <Clock className="w-3 h-3" /> Due Friday
                          </span>
                        </div>
                        <p className="text-sm text-slate-200 truncate">Shift building footprint north 6 ft to meet front setback</p>
                      </div>
                      <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button className="p-1.5 rounded bg-green-500/10 hover:bg-green-500/20 text-green-400 transition-colors" title="Mark Done">
                          <CheckCircle2 className="w-4 h-4" />
                        </button>
                        <button className="p-1.5 text-slate-400 hover:text-white transition-colors">
                          <MoreHorizontal className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    
                    {/* Add Task Button */}
                    <div className="ml-6 pt-2 relative z-10">
                      <button className="text-xs font-medium text-[#5fd0e0] flex items-center gap-1.5 hover:text-white transition-colors py-1 px-2 rounded hover:bg-[#5fd0e0]/10">
                        <Plus className="w-3.5 h-3.5" /> Add response task
                      </button>
                    </div>
                  </div>
                </div>

                {/* Finding Footer */}
                <div className="p-4 border-t border-[#1e2a3a] bg-[#0f1729] flex items-center justify-between rounded-b-lg">
                  <div className="flex items-center gap-2 text-[10px] font-mono text-slate-500">
                    <span className="text-slate-400">Created</span> 18h ago
                    <ChevronRight className="w-3 h-3 mx-1 opacity-50" />
                    <span className="text-slate-400">Task Assigned</span> 17h ago
                    <ChevronRight className="w-3 h-3 mx-1 opacity-50" />
                    <span className="text-amber-400/70">In Progress</span>
                  </div>
                  <button className="text-xs font-medium text-slate-300 hover:text-white px-3 py-1.5 rounded border border-[#1e2a3a] hover:bg-[#1e2a3a] transition-colors">
                    Address with next revision
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Finding F-13 (Collapsed) */}
          <div className={`border rounded-lg bg-[#0f1729] shadow-sm transition-all duration-200 ${expandedId === 'F-13' ? 'border-[#5fd0e0]/40 ring-1 ring-[#5fd0e0]/10' : 'border-[#1e2a3a] hover:border-[#334155]'}`}>
            <div 
              className="p-4 flex items-start gap-4 cursor-pointer"
              onClick={() => toggleExpand('F-13')}
            >
              <div className="mt-1">{expandedId === 'F-13' ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-1.5">
                  <span className="text-xs font-mono text-slate-400">F-13</span>
                  <span className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-bold bg-[#ef4444]/10 text-[#ef4444] border border-[#ef4444]/20">
                    <ShieldAlert className="w-3 h-3" /> BLOCKER
                  </span>
                  <span className="text-sm font-semibold text-slate-200 flex items-center gap-1.5">
                    <Flame className="w-3.5 h-3.5 text-slate-400" /> Fire access
                  </span>
                  <div className="px-2 py-0.5 rounded-full border border-amber-500/30 text-amber-400 text-[10px] font-medium bg-amber-500/5">
                    OPEN
                  </div>
                  <span className="text-xs text-slate-500 ml-auto">from Sub. #3 · 18h ago</span>
                </div>
                <div className="flex items-center gap-2">
                  <p className="text-sm text-slate-300 truncate">Fire access lane 18 ft, required 20 ft (IFC 503.2.1)</p>
                  <button className="px-2 py-1 rounded bg-[#1e2a3a] hover:bg-[#28384e] text-xs text-cyan-400 font-mono transition-colors ml-auto border border-cyan-900/30">
                    A-1.1
                  </button>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <CornerDownRight className="w-3.5 h-3.5 text-slate-500" />
                  <div className="w-5 h-5 rounded bg-purple-500/20 text-purple-400 flex items-center justify-center text-[10px] font-bold">M</div>
                  <span className="text-xs text-slate-400 truncate">RT-202 <span className="text-slate-600">·</span> Widen fire-access lane to 20 ft, re-route landscape edge</span>
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700 ml-2">OPEN</span>
                </div>
              </div>
            </div>
            {/* Expanded content omitted for brevity, but normally populated conditionally like F-12 */}
          </div>

          {/* Finding F-14 (Collapsed) */}
          <div className={`border rounded-lg bg-[#0f1729] shadow-sm transition-all duration-200 ${expandedId === 'F-14' ? 'border-[#5fd0e0]/40 ring-1 ring-[#5fd0e0]/10' : 'border-[#1e2a3a] hover:border-[#334155]'}`}>
            <div 
              className="p-4 flex items-start gap-4 cursor-pointer"
              onClick={() => toggleExpand('F-14')}
            >
              <div className="mt-1">{expandedId === 'F-14' ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-1.5">
                  <span className="text-xs font-mono text-slate-400">F-14</span>
                  <span className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-bold bg-[#f59e0b]/10 text-[#f59e0b] border border-[#f59e0b]/20">
                    <AlertTriangle className="w-3 h-3" /> CONCERN
                  </span>
                  <span className="text-sm font-semibold text-slate-200 flex items-center gap-1.5">
                    <Ruler className="w-3.5 h-3.5 text-slate-400" /> Setback
                  </span>
                  <div className="px-2 py-0.5 rounded-full border border-amber-500/30 text-amber-400 text-[10px] font-medium bg-amber-500/5">
                    OPEN
                  </div>
                  <span className="text-xs text-slate-500 ml-auto">from Sub. #3 · 18h ago</span>
                </div>
                <div className="flex items-center gap-2">
                  <p className="text-sm text-slate-300 truncate">Side setback 9 ft, required 10 ft</p>
                  <button className="px-2 py-1 rounded bg-[#1e2a3a] hover:bg-[#28384e] text-xs text-cyan-400 font-mono transition-colors ml-auto border border-cyan-900/30">
                    W-B-203
                  </button>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <CornerDownRight className="w-3.5 h-3.5 text-slate-500" />
                  <div className="w-5 h-5 rounded bg-blue-500/20 text-blue-400 flex items-center justify-center text-[10px] font-bold">S</div>
                  <span className="text-xs text-slate-400 truncate">RT-203 <span className="text-slate-600">·</span> Trim east wing 1 ft to meet side setback</span>
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700 ml-2">OPEN</span>
                </div>
              </div>
            </div>
          </div>

          {/* Finding F-15 (Collapsed) */}
          <div className={`border rounded-lg bg-[#0f1729] shadow-sm transition-all duration-200 ${expandedId === 'F-15' ? 'border-[#5fd0e0]/40 ring-1 ring-[#5fd0e0]/10' : 'border-[#1e2a3a] hover:border-[#334155]'}`}>
            <div 
              className="p-4 flex items-start gap-4 cursor-pointer"
              onClick={() => toggleExpand('F-15')}
            >
              <div className="mt-1">{expandedId === 'F-15' ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-1.5">
                  <span className="text-xs font-mono text-slate-400">F-15</span>
                  <span className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-bold bg-[#f59e0b]/10 text-[#f59e0b] border border-[#f59e0b]/20">
                    <AlertTriangle className="w-3 h-3" /> CONCERN
                  </span>
                  <span className="text-sm font-semibold text-slate-200 flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5 text-slate-400" /> Coverage
                  </span>
                  <div className="px-2 py-0.5 rounded-full border border-amber-500/30 text-amber-400 text-[10px] font-medium bg-amber-500/5">
                    OPEN
                  </div>
                  <span className="text-xs text-slate-500 ml-auto">from Sub. #3 · 18h ago</span>
                </div>
                <div className="flex items-center gap-2">
                  <p className="text-sm text-slate-300 truncate">Lot coverage 42%, recommended ≤40%</p>
                  <button className="px-2 py-1 rounded bg-[#1e2a3a] hover:bg-[#28384e] text-xs text-cyan-400 font-mono transition-colors ml-auto border border-cyan-900/30">
                    A1
                  </button>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <CornerDownRight className="w-3.5 h-3.5 text-slate-500" />
                  <div className="w-5 h-5 rounded bg-purple-500/20 text-purple-400 flex items-center justify-center text-[10px] font-bold">M</div>
                  <span className="text-xs text-slate-400 truncate">RT-204 <span className="text-slate-600">·</span> Reduce footprint 2% (move stair tower inside envelope)</span>
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700 ml-2">OPEN</span>
                </div>
              </div>
            </div>
          </div>

          {/* Finding F-16 (Collapsed - Overridden) */}
          <div className="border border-[#1e2a3a] opacity-60 hover:opacity-100 rounded-lg bg-[#0f1729]/50 shadow-sm transition-all duration-200">
            <div 
              className="p-4 flex items-start gap-4 cursor-pointer"
              onClick={() => toggleExpand('F-16')}
            >
              <div className="mt-1"><ChevronRight className="w-4 h-4 text-slate-500" /></div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-1.5">
                  <span className="text-xs font-mono text-slate-500">F-16</span>
                  <span className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-bold bg-[#60a5fa]/10 text-[#60a5fa] border border-[#60a5fa]/20">
                    <Info className="w-3 h-3" /> ADVISORY
                  </span>
                  <span className="text-sm font-semibold text-slate-400 flex items-center gap-1.5 line-through decoration-slate-600">
                    <User className="w-3.5 h-3.5 text-slate-500" /> Accessibility
                  </span>
                  <div className="px-2 py-0.5 rounded-full border border-slate-600 text-slate-400 text-[10px] font-medium bg-slate-800/50">
                    OVERRIDDEN
                  </div>
                  <span className="text-xs text-slate-600 ml-auto">from Sub. #3 · 18h ago</span>
                </div>
                <div className="flex items-center gap-2">
                  <p className="text-sm text-slate-400 truncate">Recommend tactile strip at lobby threshold (ADA 705.1)</p>
                  <button className="px-2 py-1 rounded bg-[#1e2a3a]/50 text-xs text-cyan-400/50 font-mono ml-auto border border-cyan-900/10">
                    A2.5
                  </button>
                </div>
                <div className="mt-3 flex items-center gap-2 opacity-70">
                  <CornerDownRight className="w-3.5 h-3.5 text-slate-600" />
                  <div className="w-5 h-5 rounded bg-blue-500/10 text-blue-400/50 flex items-center justify-center text-[10px] font-bold">S</div>
                  <span className="text-xs text-slate-500 truncate line-through">RT-205 <span className="text-slate-600">·</span> Revise lobby detail for ADA threshold note</span>
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-green-500/10 text-green-500 border border-green-500/20 ml-2">DONE</span>
                </div>
              </div>
            </div>
          </div>
          
          <div className="h-8" />
        </div>
      </div>

      {/* RIGHT RAIL: Views Navigation */}
      <div className="w-[64px] border-l border-[#1e2a3a] bg-[#0f1729] flex flex-col items-center py-4 flex-shrink-0">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#5fd0e0] to-blue-500 flex items-center justify-center mb-8 shadow-lg shadow-[#5fd0e0]/20">
          <Building className="w-5 h-5 text-[#0b1220]" />
        </div>
        
        <nav className="flex flex-col gap-4 w-full px-2">
          <button className="w-full aspect-square rounded-lg flex flex-col items-center justify-center gap-1 text-slate-400 hover:text-slate-200 hover:bg-[#1e2a3a] transition-all group">
            <LayoutDashboard className="w-5 h-5" />
          </button>
          
          {/* Active View: Review Workspace */}
          <div className="relative w-full">
            <div className="absolute -left-2 top-1/2 -translate-y-1/2 w-1 h-8 bg-[#5fd0e0] rounded-r-full"></div>
            <button className="w-full aspect-square rounded-lg flex flex-col items-center justify-center gap-1 text-[#5fd0e0] bg-[#5fd0e0]/10 transition-all">
              <ActivitySquare className="w-5 h-5" />
            </button>
          </div>
          
          <button className="w-full aspect-square rounded-lg flex flex-col items-center justify-center gap-1 text-slate-400 hover:text-slate-200 hover:bg-[#1e2a3a] transition-all">
            <CircleDashed className="w-5 h-5" />
          </button>
          
          <button className="w-full aspect-square rounded-lg flex flex-col items-center justify-center gap-1 text-slate-400 hover:text-slate-200 hover:bg-[#1e2a3a] transition-all">
            <Settings className="w-5 h-5" />
          </button>
        </nav>
      </div>

    </div>
  );
}
