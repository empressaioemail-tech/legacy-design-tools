import React, { useState } from "react";
import {
  Inbox,
  Bell,
  AlertTriangle,
  Sparkles,
  AtSign,
  CheckCircle2,
  Building2,
  Filter,
  Archive,
  Reply,
  ChevronRight,
  Hash,
  Pin,
  Settings,
  Plus,
  Search,
  MoreHorizontal,
  CornerDownRight,
  Check,
  X,
  ThumbsUp,
  Heart,
  FileText,
  MessageSquare,
  Eye,
  AlertCircle
} from "lucide-react";

export function ActivityStream() {
  const [activeChannel, setActiveChannel] = useState("redd");

  return (
    <div
      className="flex h-[900px] w-[1280px] overflow-hidden text-slate-200 font-sans"
      style={{ backgroundColor: "#0b1220" }}
    >
      {/* LEFT RAIL - App Shell (~64px) */}
      <div
        className="w-[64px] flex flex-col items-center py-4 border-r border-slate-800"
        style={{ backgroundColor: "#0f1729", borderColor: "#1e2a3a" }}
      >
        <div className="w-10 h-10 rounded-xl bg-cyan-500/20 text-cyan-400 flex items-center justify-center mb-8">
          <Building2 size={20} />
        </div>
        
        <div className="flex flex-col gap-4 w-full px-2">
          <button className="w-12 h-12 rounded-xl bg-cyan-500/10 text-cyan-400 flex items-center justify-center relative">
            <Inbox size={20} />
            <div className="absolute top-2 right-2 w-2 h-2 bg-cyan-400 rounded-full"></div>
          </button>
          <button className="w-12 h-12 rounded-xl text-slate-500 hover:text-slate-300 flex items-center justify-center">
            <FileText size={20} />
          </button>
          <button className="w-12 h-12 rounded-xl text-slate-500 hover:text-slate-300 flex items-center justify-center">
            <CheckCircle2 size={20} />
          </button>
        </div>

        <div className="mt-auto">
          <img
            src="https://api.dicebear.com/7.x/avataaars/svg?seed=Maria"
            alt="Maria"
            className="w-10 h-10 rounded-full bg-slate-800"
          />
        </div>
      </div>

      {/* CHANNELS PANE (~260px) */}
      <div
        className="w-[260px] flex flex-col border-r border-slate-800"
        style={{ borderColor: "#1e2a3a" }}
      >
        {/* Top Header */}
        <div className="p-4 border-b border-slate-800" style={{ borderColor: "#1e2a3a" }}>
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-xl font-semibold">Inbox</h1>
            <button className="text-slate-400 hover:text-white">
              <Plus size={18} />
            </button>
          </div>
          <div className="flex items-center gap-4 text-xs font-medium text-slate-400">
            <button className="text-cyan-400 relative">
              Unread (6)
              <div className="absolute -bottom-2 left-0 right-0 h-0.5 bg-cyan-400 rounded-t"></div>
            </button>
            <button className="hover:text-slate-200">All</button>
            <button className="hover:text-slate-200">Mentions</button>
          </div>
        </div>

        {/* Channel List */}
        <div className="flex-1 overflow-y-auto py-2">
          {/* Redd Mixed-Use */}
          <button 
            className={`w-full text-left px-3 py-2 flex items-start gap-3 relative ${activeChannel === 'redd' ? 'bg-slate-800/50' : 'hover:bg-slate-800/30'}`}
            onClick={() => setActiveChannel('redd')}
          >
            {activeChannel === 'redd' && <div className="absolute left-0 top-0 bottom-0 w-1 bg-cyan-400 rounded-r"></div>}
            <div className="w-8 h-8 rounded bg-slate-700 flex-shrink-0 flex items-center justify-center text-slate-300 mt-1">
              <Hash size={16} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between">
                <span className={`font-medium truncate ${activeChannel === 'redd' ? 'text-white' : 'text-slate-200'}`}>Redd Mixed-Use</span>
                <span className="text-xs bg-cyan-500/20 text-cyan-400 px-1.5 py-0.5 rounded font-medium">4</span>
              </div>
              <div className="text-xs text-slate-400 truncate mt-0.5">Corrections requested</div>
              <div className="text-[10px] text-slate-500 mt-0.5">14 min ago</div>
            </div>
          </button>

          {/* Lemhi River Lodge */}
          <button className="w-full text-left px-3 py-2 flex items-start gap-3 hover:bg-slate-800/30">
            <div className="w-8 h-8 rounded bg-slate-700 flex-shrink-0 flex items-center justify-center text-slate-300 mt-1">
              <Hash size={16} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between">
                <span className="font-medium text-slate-200 truncate">Lemhi River Lodge</span>
                <span className="text-xs bg-cyan-500/20 text-cyan-400 px-1.5 py-0.5 rounded font-medium">1</span>
              </div>
              <div className="text-xs text-slate-400 truncate mt-0.5">BIM refresh requested</div>
              <div className="text-[10px] text-slate-500 mt-0.5">6 hr ago</div>
            </div>
          </button>

          {/* Bastrop Pavilion */}
          <button className="w-full text-left px-3 py-2 flex items-start gap-3 hover:bg-slate-800/30">
            <div className="w-8 h-8 rounded bg-slate-700 flex-shrink-0 flex items-center justify-center text-slate-300 mt-1">
              <Hash size={16} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between">
                <span className="font-medium text-slate-200 truncate">Bastrop Pavilion</span>
                <span className="text-xs bg-cyan-500/20 text-cyan-400 px-1.5 py-0.5 rounded font-medium">1</span>
              </div>
              <div className="text-xs text-slate-400 truncate mt-0.5">Briefing regen complete</div>
              <div className="text-[10px] text-slate-500 mt-0.5">Yesterday</div>
            </div>
          </button>

          {/* Park City Civic */}
          <button className="w-full text-left px-3 py-2 flex items-start gap-3 hover:bg-slate-800/30">
            <div className="w-8 h-8 rounded bg-slate-800 flex-shrink-0 flex items-center justify-center text-slate-500 mt-1">
              <Hash size={16} />
            </div>
            <div className="flex-1 min-w-0 opacity-60">
              <div className="flex items-center justify-between">
                <span className="font-medium text-slate-400 truncate">Park City Civic</span>
              </div>
              <div className="text-xs text-slate-500 truncate mt-0.5">Briefing sources refresh</div>
              <div className="text-[10px] text-slate-500 mt-0.5">4 d ago</div>
            </div>
          </button>

          <div className="px-3 mt-6 mb-2">
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">System</h3>
          </div>
          <button className="w-full text-left px-3 py-2 flex items-center gap-3 hover:bg-slate-800/30">
            <div className="w-6 h-6 rounded bg-slate-800 flex-shrink-0 flex items-center justify-center text-slate-500">
              <Inbox size={14} />
            </div>
            <span className="text-sm font-medium text-slate-400 flex-1">Global Updates</span>
          </button>

          <div className="px-3 mt-4">
            <button className="flex items-center gap-2 text-xs text-slate-500 hover:text-slate-300">
              <ChevronRight size={14} />
              Archived (47)
            </button>
          </div>
        </div>
      </div>

      {/* MAIN FEED (~720px) */}
      <div className="flex-1 flex flex-col min-w-0" style={{ backgroundColor: "#0b1220" }}>
        {/* Channel Header */}
        <div className="px-6 pt-6 pb-0 border-b border-slate-800" style={{ borderColor: "#1e2a3a" }}>
          <div className="flex items-center gap-2 text-xs text-slate-400 mb-2">
            <span>Design Phase</span>
            <span>·</span>
            <span>Maria Castaneda</span>
            <span>·</span>
            <span>James & Sarah</span>
          </div>
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-bold text-white flex items-center gap-2">
              <Hash className="text-slate-500" size={24} />
              Redd Mixed-Use
            </h2>
            <div className="flex gap-2">
              <button className="p-2 text-slate-400 hover:text-white rounded hover:bg-slate-800">
                <Search size={18} />
              </button>
              <button className="p-2 text-slate-400 hover:text-white rounded hover:bg-slate-800">
                <MoreHorizontal size={18} />
              </button>
            </div>
          </div>
          
          <div className="flex gap-6 text-sm font-medium text-slate-400">
            <button className="text-white pb-3 border-b-2 border-cyan-400 flex items-center gap-2">
              Activity
              <span className="bg-cyan-500/20 text-cyan-400 px-1.5 py-0.5 rounded text-[10px]">4 new</span>
            </button>
            <button className="pb-3 hover:text-slate-200">Submissions</button>
            <button className="pb-3 hover:text-slate-200">Findings</button>
            <button className="pb-3 hover:text-slate-200">Letters</button>
            <button className="pb-3 hover:text-slate-200">Renders</button>
          </div>
        </div>

        {/* Feed Content */}
        <div className="flex-1 overflow-y-auto p-6">
          
          <div className="mb-8">
            <div className="flex items-center gap-4 mb-4">
              <h3 className="text-sm font-semibold text-white">Today</h3>
              <div className="flex-1 h-px bg-slate-800" style={{ borderColor: "#1e2a3a" }}></div>
            </div>

            <div className="space-y-4">
              {/* Card 1: Action Required (Red) */}
              <div className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-4 relative overflow-hidden">
                <div className="absolute left-0 top-0 bottom-0 w-1 bg-red-500"></div>
                <div className="flex gap-4">
                  <div className="relative">
                    <img src="https://api.dicebear.com/7.x/avataaars/svg?seed=Reviewer" className="w-10 h-10 rounded-full bg-slate-700" alt="Reviewer" />
                    <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-red-500 rounded-full border-2 border-[#0b1220] flex items-center justify-center">
                      <AlertCircle size={10} className="text-white" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <div className="flex items-baseline justify-between mb-1">
                      <div className="text-sm text-slate-300">
                        <span className="font-semibold text-white">Grand County reviewer</span> requested corrections on <span className="font-medium text-cyan-400">Submission #3</span>
                      </div>
                      <span className="text-xs text-slate-500">14 min ago</span>
                    </div>
                    
                    <div className="bg-slate-900/50 rounded-md p-3 mb-3 text-sm text-slate-300 border border-slate-800">
                      "4 findings to address; revision due Friday Jun 7"
                    </div>

                    <div className="flex items-center gap-2 mb-4">
                      <span className="text-xs px-2 py-1 rounded-md bg-red-500/10 text-red-400 font-medium border border-red-500/20">
                        4 findings
                      </span>
                      <span className="text-xs px-2 py-1 rounded-md bg-slate-800 text-slate-400 border border-slate-700">
                        Due Jun 7
                      </span>
                    </div>

                    <div className="flex gap-2 mb-4">
                      <button className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-medium rounded shadow-sm">
                        Open submission
                      </button>
                      <button className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-medium rounded border border-slate-700">
                        Reply
                      </button>
                      <button className="px-3 py-1.5 text-slate-400 hover:text-slate-200 text-sm font-medium rounded">
                        Snooze
                      </button>
                    </div>

                    <div className="flex items-start gap-3 mt-4 pt-4 border-t border-slate-800">
                      <img src="https://api.dicebear.com/7.x/avataaars/svg?seed=Maria" className="w-6 h-6 rounded-full bg-slate-700" alt="Maria" />
                      <div className="flex-1 bg-slate-900/50 rounded border border-slate-800 p-2 flex items-center justify-between">
                        <span className="text-sm text-slate-500">Reply to Grand County thread...</span>
                        <div className="flex items-center gap-2">
                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <input type="checkbox" className="rounded bg-slate-800 border-slate-700 text-cyan-500" />
                            <span className="text-[10px] text-slate-500 uppercase font-medium">Hold 24h</span>
                          </label>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Card 2: AI Alert (Violet) */}
              <div className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-4 relative overflow-hidden">
                <div className="absolute left-0 top-0 bottom-0 w-1 bg-violet-400"></div>
                <div className="flex gap-4">
                  <div className="w-10 h-10 rounded-full bg-violet-500/20 text-violet-400 flex items-center justify-center flex-shrink-0">
                    <Sparkles size={20} />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-baseline justify-between mb-2">
                      <div className="text-sm text-slate-300">
                        <span className="font-semibold text-white">Product spec withdrawn:</span> 'Old Window Sealant XYZ-200'
                      </div>
                      <span className="text-xs text-slate-500">1 hr ago</span>
                    </div>
                    
                    <p className="text-sm text-slate-400 mb-3">
                      Used in detail D-W-04. Suggest swap to GE Silpruf SCS2000.
                    </p>

                    <div className="flex items-center gap-3 mb-3 bg-violet-500/10 border border-violet-500/20 p-2 rounded-md">
                      <div className="flex-1 flex items-center gap-2">
                        <span className="text-xs font-semibold text-violet-300 uppercase tracking-wide">Suggested Fix</span>
                        <span className="text-sm text-slate-300">Swap to GE Silpruf SCS2000</span>
                      </div>
                      <div className="flex gap-2">
                        <button className="px-2 py-1 bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium rounded">Apply</button>
                        <button className="px-2 py-1 text-slate-400 hover:text-slate-200 text-xs font-medium rounded">Dismiss</button>
                      </div>
                    </div>

                    <div className="flex gap-2 mb-3">
                      <button className="text-xs font-medium text-cyan-400 hover:text-cyan-300 flex items-center gap-1">
                        Find replacement <ChevronRight size={12} />
                      </button>
                      <span className="text-slate-600">•</span>
                      <button className="text-xs font-medium text-cyan-400 hover:text-cyan-300 flex items-center gap-1">
                        Open detail D-W-04 <ChevronRight size={12} />
                      </button>
                    </div>

                    <div className="mt-3 pt-3 border-t border-slate-800">
                      <div className="flex items-center gap-2 text-sm">
                        <CornerDownRight size={14} className="text-slate-500" />
                        <img src="https://api.dicebear.com/7.x/avataaars/svg?seed=Sarah" className="w-5 h-5 rounded-full bg-slate-700" alt="Sarah" />
                        <span className="font-medium text-slate-300">Sarah</span>
                        <span className="text-slate-400">I'll handle the swap, +1</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Card 3: Status / Completed (Green) */}
              <div className="bg-slate-800/20 border border-slate-800 rounded-lg p-4 flex gap-4">
                <div className="w-10 h-10 rounded-full bg-green-500/20 text-green-400 flex items-center justify-center flex-shrink-0">
                  <CheckCircle2 size={20} />
                </div>
                <div className="flex-1">
                  <div className="flex items-baseline justify-between mb-2">
                    <div className="text-sm text-slate-300">
                      <span className="font-semibold text-white">Render complete:</span> 'Hero exterior · golden hour'
                    </div>
                    <span className="text-xs text-slate-500">2 hr ago</span>
                  </div>
                  
                  <div className="flex items-start gap-4 mt-2">
                    <div className="w-32 h-20 bg-slate-700 rounded-md overflow-hidden relative border border-slate-600">
                      {/* Mock thumbnail */}
                      <div className="absolute inset-0 bg-gradient-to-tr from-amber-900/40 to-blue-900/40"></div>
                      <div className="absolute bottom-1 right-1 bg-black/60 px-1 rounded text-[9px] text-white">4K</div>
                    </div>
                    <div className="flex flex-col gap-2">
                      <span className="text-xs text-slate-500">240 credits used</span>
                      <button className="text-sm font-medium text-cyan-400 hover:text-cyan-300 flex items-center gap-1 w-fit">
                        <Eye size={14} /> View render
                      </button>
                      <div className="flex gap-1 mt-1">
                        <button className="px-1.5 py-0.5 bg-slate-800 hover:bg-slate-700 rounded text-xs flex items-center gap-1 text-slate-400">
                          <ThumbsUp size={10} /> 1
                        </button>
                        <button className="px-1.5 py-0.5 bg-slate-800 hover:bg-slate-700 rounded text-xs flex items-center gap-1 text-slate-400">
                          <Heart size={10} />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Card 4: Mention (Cyan) */}
              <div className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-4 relative overflow-hidden">
                <div className="absolute left-0 top-0 bottom-0 w-1 bg-cyan-400"></div>
                <div className="flex gap-4">
                  <div className="relative">
                    <img src="https://api.dicebear.com/7.x/avataaars/svg?seed=James" className="w-10 h-10 rounded-full bg-slate-700" alt="James" />
                    <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-cyan-500 rounded-full border-2 border-[#0b1220] flex items-center justify-center">
                      <AtSign size={10} className="text-white" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <div className="flex items-baseline justify-between mb-2">
                      <div className="text-sm text-slate-300">
                        <span className="font-semibold text-white">James</span> mentioned you on <span className="font-medium text-cyan-400">Sheet A3.1</span>
                      </div>
                      <span className="text-xs text-slate-500">4 hr ago</span>
                    </div>

                    <div className="flex gap-3 bg-slate-900/50 p-3 rounded-md border border-slate-800 mb-3">
                      <div className="w-16 h-16 bg-slate-800 border border-red-500/30 rounded flex items-center justify-center relative flex-shrink-0">
                        <div className="absolute inset-2 border border-red-500/50 rounded-sm transform rotate-3"></div>
                      </div>
                      <div className="text-sm text-slate-300">
                        <span className="text-cyan-400 font-medium">@Maria</span> — Love these proportions! Make these bigger?
                      </div>
                    </div>

                    <div className="flex gap-3 items-center">
                      <button className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-medium rounded border border-slate-700">
                        Open markup
                      </button>
                      <div className="flex-1 bg-slate-900/80 rounded border border-slate-800 px-3 py-1.5 flex items-center">
                        <span className="text-sm text-slate-500">Reply to James...</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="mb-4">
            <div className="flex items-center gap-4 mb-4 opacity-60">
              <h3 className="text-sm font-semibold text-slate-400">Yesterday</h3>
              <div className="flex-1 h-px bg-slate-800" style={{ borderColor: "#1e2a3a" }}></div>
            </div>

            <div className="space-y-2">
              {/* Yesterday collapsed items */}
              <div className="flex items-center gap-3 py-2 px-3 hover:bg-slate-800/30 rounded-md cursor-pointer opacity-60">
                <CheckCircle2 size={16} className="text-slate-500" />
                <span className="text-sm text-slate-400 flex-1">Submission #2 approved by Grand County reviewer</span>
                <span className="text-xs text-slate-500">2 d ago</span>
              </div>
              <div className="flex items-center gap-3 py-2 px-3 hover:bg-slate-800/30 rounded-md cursor-pointer opacity-60">
                <Sparkles size={16} className="text-slate-500" />
                <span className="text-sm text-slate-400 flex-1">Plan review run completed — 5 findings detected</span>
                <span className="text-xs text-slate-500">2 d ago</span>
              </div>
              <div className="flex items-center gap-3 py-2 px-3 hover:bg-slate-800/30 rounded-md cursor-pointer opacity-60">
                <AtSign size={16} className="text-slate-500" />
                <span className="text-sm text-slate-400 flex-1"><span className="text-slate-300">@Maria</span> — Sarah commented on Letter #2 draft</span>
                <span className="text-xs text-slate-500">3 d ago</span>
              </div>
            </div>
          </div>
          
        </div>
      </div>

      {/* RIGHT RAIL (~260px) */}
      <div
        className="w-[260px] flex flex-col border-l border-slate-800 bg-[#0f1729]"
        style={{ borderColor: "#1e2a3a" }}
      >
        <div className="p-5 flex-1 overflow-y-auto">
          {/* About Card */}
          <div className="mb-6">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">About Channel</h3>
            <div className="bg-slate-800/30 border border-slate-800 rounded-lg p-4">
              <div className="flex items-center justify-between mb-4">
                <span className="text-sm font-medium text-white truncate pr-2">Redd Mixed-Use</span>
                <span className="text-[10px] bg-slate-800 text-slate-300 px-2 py-0.5 rounded border border-slate-700">Design</span>
              </div>
              
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-500">Architect</span>
                  <img src="https://api.dicebear.com/7.x/avataaars/svg?seed=Maria" className="w-5 h-5 rounded-full bg-slate-700" alt="Maria" />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-500">Client</span>
                  <div className="flex -space-x-1">
                    <img src="https://api.dicebear.com/7.x/avataaars/svg?seed=James" className="w-5 h-5 rounded-full border border-[#0f1729] bg-slate-700" alt="James" />
                    <img src="https://api.dicebear.com/7.x/avataaars/svg?seed=Sarah" className="w-5 h-5 rounded-full border border-[#0f1729] bg-slate-700" alt="Sarah" />
                  </div>
                </div>
                <div className="flex items-center justify-between pt-2 border-t border-slate-800/50">
                  <span className="text-xs text-slate-500">Activity this week</span>
                  <span className="text-xs font-medium text-slate-300">6 items</span>
                </div>
              </div>
              
              <button className="w-full mt-4 py-1.5 text-xs font-medium text-cyan-400 hover:bg-cyan-950/30 rounded flex items-center justify-center gap-1 transition-colors">
                Jump to engagement <ChevronRight size={12} />
              </button>
            </div>
          </div>

          {/* Pinned Threads */}
          <div className="mb-6">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3 flex items-center justify-between">
              <span>Pinned Threads (2)</span>
              <Pin size={12} />
            </h3>
            <div className="space-y-2">
              <div className="p-3 bg-slate-800/30 border border-slate-800 rounded text-xs hover:bg-slate-800/50 cursor-pointer">
                <div className="text-slate-300 font-medium mb-1 truncate"># Redd / Sub #2</div>
                <div className="text-slate-500 line-clamp-2">Discussion on parking setback variance with Grand County</div>
              </div>
              <div className="p-3 bg-slate-800/30 border border-slate-800 rounded text-xs hover:bg-slate-800/50 cursor-pointer">
                <div className="text-slate-300 font-medium mb-1 truncate"># Bastrop / Briefing</div>
                <div className="text-slate-500 line-clamp-2">EJScreen impacts on Section C</div>
              </div>
            </div>
          </div>

          {/* Settings */}
          <div>
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3 flex items-center justify-between">
              <span>Notifications</span>
              <Settings size={12} />
            </h3>
            <div className="space-y-3 bg-slate-800/20 p-3 rounded border border-slate-800/50">
              <label className="flex items-center gap-2 cursor-pointer">
                <div className="w-3 h-3 rounded-full border border-slate-600 flex items-center justify-center"></div>
                <span className="text-xs text-slate-400">All activity</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <div className="w-3 h-3 rounded-full border-2 border-cyan-500 bg-[#0f1729] flex items-center justify-center">
                  <div className="w-1.5 h-1.5 bg-cyan-500 rounded-full"></div>
                </div>
                <span className="text-xs text-white">Mentions & Actions</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <div className="w-3 h-3 rounded-full border border-slate-600 flex items-center justify-center"></div>
                <span className="text-xs text-slate-400">Off</span>
              </label>
            </div>
          </div>
        </div>

        {/* Bottom Stats */}
        <div className="p-4 border-t border-slate-800 bg-[#0b1220]/50" style={{ borderColor: "#1e2a3a" }}>
          <div className="text-[10px] text-slate-500 leading-relaxed">
            <div className="font-medium text-slate-300 mb-1">Across all channels today:</div>
            <span className="text-cyan-400 font-medium">6 unread</span> · <span className="text-red-400 font-medium">3 need action</span>
            <div className="mt-1 opacity-70">Last digest: 7:00 AM</div>
          </div>
        </div>
      </div>
    </div>
  );
}
