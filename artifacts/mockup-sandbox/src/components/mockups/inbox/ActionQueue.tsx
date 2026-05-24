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
  Clock,
  Send,
  MoreVertical,
  CheckSquare,
  Search,
  Settings,
  ChevronDown
} from "lucide-react";

export function ActionQueue() {
  const [fyiExpanded, setFyiExpanded] = useState(false);

  return (
    <div className="flex h-screen w-full bg-[#0b1220] text-slate-300 font-sans overflow-hidden">
      {/* LEFT RAIL */}
      <div className="w-16 flex-shrink-0 bg-[#0f1729] border-r border-[#1e2a3a] flex flex-col items-center py-4 z-10">
        <div className="h-10 w-10 bg-gradient-to-br from-cyan-500 to-blue-600 rounded-lg flex items-center justify-center mb-8 shadow-[0_0_15px_rgba(95,208,224,0.3)]">
          <Building2 className="w-6 h-6 text-white" />
        </div>

        <nav className="flex flex-col gap-4 w-full px-2">
          <button className="p-3 rounded-xl hover:bg-slate-800/50 text-slate-400 transition-colors flex items-center justify-center group relative">
            <Search className="w-5 h-5 group-hover:text-slate-200" />
          </button>
          
          <button className="p-3 rounded-xl bg-cyan-500/10 text-cyan-400 transition-colors flex items-center justify-center relative shadow-[inset_2px_0_0_0_#5fd0e0]">
            <Inbox className="w-5 h-5" />
            <span className="absolute top-2 right-2 w-2 h-2 bg-red-500 rounded-full"></span>
            <span className="absolute -top-1 -right-1 bg-cyan-500 text-[#0b1220] text-[10px] font-bold px-1.5 py-0.5 rounded-full">6</span>
          </button>
          
          <button className="p-3 rounded-xl hover:bg-slate-800/50 text-slate-400 transition-colors flex items-center justify-center group">
            <Bell className="w-5 h-5 group-hover:text-slate-200" />
          </button>
        </nav>

        <div className="mt-auto flex flex-col gap-4 w-full px-2 items-center">
          <button className="p-3 rounded-xl hover:bg-slate-800/50 text-slate-400 transition-colors flex items-center justify-center group">
            <Settings className="w-5 h-5 group-hover:text-slate-200" />
          </button>
          <div className="w-8 h-8 rounded-full bg-slate-700 overflow-hidden border border-slate-600 cursor-pointer">
            <img src="https://i.pravatar.cc/150?u=maria" alt="Maria Castaneda" className="w-full h-full object-cover" />
          </div>
        </div>
      </div>

      {/* MAIN CANVAS */}
      <div className="flex-1 flex flex-col min-w-0 overflow-y-auto overflow-x-hidden relative">
        <div className="max-w-4xl mx-auto w-full px-8 py-10 pb-32">
          {/* Top Hero Strip */}
          <div className="mb-10">
            <h1 className="text-3xl font-medium text-white tracking-tight mb-2">Good morning, Maria <span className="text-slate-500">· 3 things need you today</span></h1>
            
            <div className="flex items-center justify-between mt-6">
              <div className="flex h-2 w-64 bg-slate-800 rounded-full overflow-hidden">
                <div className="bg-red-500 w-[25%]" title="3 Action"></div>
                <div className="bg-violet-400 w-[25%]" title="3 AI"></div>
                <div className="bg-cyan-400 w-[15%]" title="2 Mentions"></div>
                <div className="bg-green-500 w-[25%]" title="3 FYI"></div>
              </div>
              
              <div className="flex bg-[#0f1729] rounded-lg p-1 border border-[#1e2a3a]">
                <button className="px-3 py-1 text-sm bg-slate-800 text-white rounded shadow-sm">Today</button>
                <button className="px-3 py-1 text-sm text-slate-400 hover:text-slate-200">This week</button>
                <button className="px-3 py-1 text-sm text-slate-400 hover:text-slate-200">All</button>
              </div>
            </div>
          </div>

          <div className="space-y-12">
            {/* Bucket 1: Needs your action */}
            <section>
              <div className="flex items-center gap-2 mb-4">
                <div className="w-2 h-2 rounded-full bg-red-500 shadow-[0_0_8px_#ef4444]"></div>
                <h2 className="text-lg font-medium text-white">Needs your action</h2>
                <span className="text-slate-500 text-sm ml-1">(3)</span>
              </div>
              
              <div className="space-y-3">
                {/* Item 1 */}
                <div className="group flex gap-4 bg-[#0f1729] border border-[#1e2a3a] rounded-xl p-4 hover:border-slate-700 transition-colors relative overflow-hidden">
                  <div className="absolute left-0 top-0 bottom-0 w-1 bg-cyan-500 opacity-50"></div>
                  <div className="pt-1">
                    <button className="w-5 h-5 rounded border border-slate-600 flex items-center justify-center hover:border-slate-400 hover:bg-slate-800 transition-colors text-transparent hover:text-slate-400">
                      <CheckSquare className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between items-start mb-1">
                      <div className="flex items-center gap-2 text-sm text-slate-400 mb-1">
                        <AlertTriangle className="w-4 h-4 text-red-400" />
                        <span className="text-red-400 font-medium">Grand County reviewer requested corrections on Submission #3</span>
                        <span className="text-slate-600">·</span>
                        <span className="text-slate-400">14 min ago</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="px-2 py-0.5 rounded text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20 flex items-center gap-1">
                          <Clock className="w-3 h-3" /> Due Fri Jun 7 · 6 d
                        </span>
                      </div>
                    </div>
                    <p className="text-slate-200 text-[15px] mb-3">"4 findings to address; revision due Friday Jun 7"</p>
                    <div className="flex items-center justify-between mt-4">
                      <div className="flex items-center gap-2">
                        <span className="px-2 py-1 rounded-md text-xs font-medium bg-slate-800 text-slate-300 border border-slate-700">Redd Mixed-Use</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button className="text-xs font-medium text-slate-400 hover:text-slate-200 px-3 py-1.5 transition-colors">Dismiss</button>
                        <button className="text-xs font-medium text-slate-400 hover:text-slate-200 px-3 py-1.5 transition-colors">Assign</button>
                        <button className="text-xs font-medium text-slate-400 hover:text-slate-200 px-3 py-1.5 transition-colors">Snooze</button>
                        <button className="text-sm font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20 px-4 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors ml-2">
                          Open submission <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Item 5 */}
                <div className="group flex gap-4 bg-[#0f1729] border border-[#1e2a3a] rounded-xl p-4 hover:border-slate-700 transition-colors relative overflow-hidden">
                  <div className="absolute left-0 top-0 bottom-0 w-1 bg-cyan-500 opacity-50"></div>
                  <div className="pt-1">
                    <button className="w-5 h-5 rounded border border-slate-600 flex items-center justify-center hover:border-slate-400 hover:bg-slate-800 transition-colors text-transparent hover:text-slate-400">
                      <CheckSquare className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between items-start mb-1">
                      <div className="flex items-center gap-2 text-sm text-slate-400 mb-1">
                        <AlertTriangle className="w-4 h-4 text-amber-500" />
                        <span className="text-amber-500 font-medium">Reviewer requested BIM model refresh</span>
                        <span className="text-slate-600">·</span>
                        <span className="text-slate-400">6 hr ago</span>
                      </div>
                    </div>
                    <p className="text-slate-200 text-[15px] mb-3">"Jim P. (Lemhi County) requests an updated GLB export — last seen v2 from 3 wk ago."</p>
                    <div className="flex items-center justify-between mt-4">
                      <div className="flex items-center gap-2">
                        <span className="px-2 py-1 rounded-md text-xs font-medium bg-slate-800 text-slate-300 border border-slate-700">Lemhi River Lodge</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button className="text-xs font-medium text-slate-400 hover:text-slate-200 px-3 py-1.5 transition-colors">Dismiss</button>
                        <button className="text-xs font-medium text-slate-400 hover:text-slate-200 px-3 py-1.5 transition-colors">Assign</button>
                        <button className="text-xs font-medium text-slate-400 hover:text-slate-200 px-3 py-1.5 transition-colors">Snooze</button>
                        <button className="text-sm font-medium bg-amber-500/10 text-amber-500 hover:bg-amber-500/20 border border-amber-500/20 px-4 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors ml-2">
                          Re-export model <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Item 10 - Muted but actionable */}
                <div className="group flex gap-4 bg-[#0b1220] border border-[#1e2a3a] rounded-xl p-4 hover:border-slate-800 transition-colors opacity-70">
                  <div className="pt-1">
                    <button className="w-5 h-5 rounded border border-slate-600 flex items-center justify-center hover:border-slate-400 hover:bg-slate-800 transition-colors text-transparent hover:text-slate-400">
                      <CheckSquare className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between items-start mb-1">
                      <div className="flex items-center gap-2 text-sm text-slate-500 mb-1">
                        <AlertTriangle className="w-4 h-4 text-slate-500" />
                        <span className="text-slate-400 font-medium">Reviewer requested briefing sources refresh</span>
                        <span className="text-slate-600">·</span>
                        <span className="text-slate-500">4 d ago</span>
                      </div>
                    </div>
                    <p className="text-slate-400 text-[15px] mb-3">"Add the new 2026 floodplain data."</p>
                    <div className="flex items-center justify-between mt-4">
                      <div className="flex items-center gap-2">
                        <span className="px-2 py-1 rounded-md text-xs font-medium bg-slate-800/50 text-slate-400 border border-slate-700/50">Park City Civic</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button className="text-sm font-medium bg-slate-800 text-slate-300 hover:bg-slate-700 border border-slate-700 px-4 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors">
                          Refresh sources <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* Bucket 2: AI is flagging */}
            <section>
              <div className="flex items-center gap-2 mb-4">
                <div className="w-2 h-2 rounded-full bg-violet-400 shadow-[0_0_8px_#a78bfa]"></div>
                <h2 className="text-lg font-medium text-white">AI is flagging</h2>
                <span className="text-slate-500 text-sm ml-1">(3)</span>
              </div>
              
              <div className="grid grid-cols-2 gap-3">
                {/* Item 2 */}
                <div className="bg-[#0f1729] border border-violet-500/30 rounded-xl p-4 hover:border-violet-500/50 transition-colors relative overflow-hidden group">
                  <div className="absolute left-0 top-0 bottom-0 w-1 bg-violet-500"></div>
                  <div className="flex justify-between items-start mb-2">
                    <div className="flex items-center gap-1.5">
                      <Sparkles className="w-4 h-4 text-violet-400" />
                      <span className="text-xs font-medium text-violet-400">AI Alert</span>
                    </div>
                    <span className="text-xs text-slate-500">1 hr ago</span>
                  </div>
                  <h3 className="text-slate-200 font-medium mb-1">Product spec withdrawn: 'Old Window Sealant XYZ-200'</h3>
                  <p className="text-slate-400 text-sm mb-4">Used in detail D-W-04. Suggest swap to GE Silpruf SCS2000.</p>
                  
                  <div className="flex items-center justify-between mt-auto">
                    <span className="text-xs text-slate-500">Redd Mixed-Use</span>
                    <button className="text-sm font-medium text-violet-400 hover:text-violet-300 flex items-center gap-1 transition-colors">
                      Apply swap <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Item 8 */}
                <div className="bg-[#0f1729] border border-[#1e2a3a] rounded-xl p-4 hover:border-slate-700 transition-colors">
                  <div className="flex justify-between items-start mb-2">
                    <div className="flex items-center gap-1.5">
                      <Sparkles className="w-4 h-4 text-slate-500" />
                      <span className="text-xs font-medium text-slate-400">Plan Review Done</span>
                    </div>
                    <span className="text-xs text-slate-500">2 d ago</span>
                  </div>
                  <h3 className="text-slate-200 font-medium mb-1">Plan review run completed</h3>
                  <p className="text-slate-400 text-sm mb-4">5 findings detected: 1 blocker, 3 concerns, 1 advisory.</p>
                  
                  <div className="flex items-center justify-between mt-auto">
                    <span className="text-xs text-slate-500">Bastrop Pavilion</span>
                    <button className="text-sm font-medium text-slate-300 hover:text-white flex items-center gap-1 transition-colors">
                      Open findings <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            </section>

            {/* Bucket 3: Mentions */}
            <section>
              <div className="flex items-center gap-2 mb-4">
                <div className="w-2 h-2 rounded-full bg-cyan-400 shadow-[0_0_8px_#5fd0e0]"></div>
                <h2 className="text-lg font-medium text-white">@ Mentions</h2>
                <span className="text-slate-500 text-sm ml-1">(2)</span>
              </div>
              
              <div className="space-y-3">
                {/* Item 4 */}
                <div className="bg-[#0f1729] border border-cyan-500/30 rounded-xl p-4 relative overflow-hidden">
                  <div className="absolute left-0 top-0 bottom-0 w-1 bg-cyan-400 opacity-80"></div>
                  
                  <div className="flex items-start gap-4">
                    <div className="w-8 h-8 rounded-full bg-slate-700 flex-shrink-0 flex items-center justify-center text-sm font-medium text-white overflow-hidden border border-slate-600">
                      <img src="https://i.pravatar.cc/150?u=james" alt="James" className="w-full h-full object-cover" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-center mb-1">
                        <div className="text-sm">
                          <span className="font-medium text-slate-200">James</span> left a freehand markup on <span className="text-cyan-400 font-medium">Sheet A3.1</span>
                        </div>
                        <span className="text-xs text-slate-500">4 hr ago · Redd Mixed-Use</span>
                      </div>
                      
                      <div className="bg-[#0b1220] rounded-lg p-3 my-2 border border-[#1e2a3a] text-sm text-slate-300 flex items-start gap-3">
                        <div className="w-12 h-10 bg-slate-800 rounded border border-slate-700 flex-shrink-0 overflow-hidden relative">
                           <div className="absolute inset-0 border-2 border-red-500/50 m-1 rounded-sm"></div>
                        </div>
                        <div>
                          <span className="text-cyan-400 font-medium mr-1">@Maria</span>
                          "Love these proportions! Make these bigger?"
                        </div>
                      </div>
                      
                      <div className="flex items-center gap-2 mt-2">
                        <div className="relative flex-1">
                          <input type="text" placeholder="Reply to James..." className="w-full bg-[#0b1220] border border-[#1e2a3a] rounded-lg pl-3 pr-10 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500/50" />
                          <button className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-cyan-400">
                            <Send className="w-4 h-4" />
                          </button>
                        </div>
                        <button className="text-sm font-medium text-slate-400 hover:text-white px-3 py-1.5 rounded-lg border border-[#1e2a3a] hover:bg-slate-800 transition-colors">
                          Open
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Item 9 */}
                <div className="bg-[#0b1220] border border-[#1e2a3a] rounded-xl p-4 opacity-80 hover:opacity-100 transition-opacity">
                  <div className="flex items-start gap-4">
                    <div className="w-8 h-8 rounded-full bg-slate-700 flex-shrink-0 flex items-center justify-center text-sm font-medium text-white overflow-hidden border border-slate-600">
                      <img src="https://i.pravatar.cc/150?u=sarah" alt="Sarah" className="w-full h-full object-cover" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-center mb-1">
                        <div className="text-sm">
                          <span className="font-medium text-slate-300">Sarah</span> commented on <span className="text-slate-300 font-medium">Letter #2 draft</span>
                        </div>
                        <span className="text-xs text-slate-500">3 d ago · Redd Mixed-Use</span>
                      </div>
                      
                      <div className="bg-[#0f1729] rounded-lg p-3 my-2 border border-[#1e2a3a] text-sm text-slate-400 flex items-start gap-3">
                        <div className="w-1 bg-slate-700 self-stretch rounded-full"></div>
                        <div className="italic text-slate-500 mb-1">"...the current design intent is clearly unsatisfactory to the planning board given..."</div>
                      </div>
                      <div className="text-sm text-slate-300 pl-4 mb-3">
                        <span className="text-slate-400 font-medium mr-1">@Maria</span>
                        "Can we soften the tone of the intro paragraph?"
                      </div>
                      
                      <div className="flex items-center gap-2">
                        <div className="relative flex-1">
                          <input type="text" placeholder="Reply..." className="w-full bg-[#0f1729] border border-[#1e2a3a] rounded-lg pl-3 pr-10 py-1.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-slate-500" />
                          <button className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-600 hover:text-slate-400">
                            <Send className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* Bucket 4: FYI */}
            <section>
              <div 
                className="flex items-center justify-between cursor-pointer group mb-2"
                onClick={() => setFyiExpanded(!fyiExpanded)}
              >
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-green-500"></div>
                  <h2 className="text-lg font-medium text-slate-400 group-hover:text-slate-300 transition-colors">Just FYI</h2>
                  <span className="text-slate-500 text-sm ml-1">(3)</span>
                </div>
                <div className="flex items-center text-sm text-slate-500 group-hover:text-slate-400">
                  {fyiExpanded ? 'Collapse' : 'Show all'} <ChevronDown className={`w-4 h-4 ml-1 transition-transform ${fyiExpanded ? 'rotate-180' : ''}`} />
                </div>
              </div>

              {!fyiExpanded ? (
                <div className="flex gap-2 overflow-x-auto pb-2 hide-scrollbar">
                  <div className="bg-[#0f1729] border border-cyan-500/20 px-3 py-2 rounded-lg text-sm whitespace-nowrap flex items-center gap-2 text-slate-300 flex-shrink-0">
                    <div className="w-1.5 h-1.5 rounded-full bg-cyan-400"></div>
                    Render complete: 'Hero exterior...' <span className="text-slate-500 text-xs ml-2">2 hr ago</span>
                  </div>
                  <div className="bg-[#0f1729] border border-cyan-500/20 px-3 py-2 rounded-lg text-sm whitespace-nowrap flex items-center gap-2 text-slate-300 flex-shrink-0">
                    <div className="w-1.5 h-1.5 rounded-full bg-cyan-400"></div>
                    Briefing regeneration finished <span className="text-slate-500 text-xs ml-2">Yesterday</span>
                  </div>
                  <div className="bg-[#0b1220] border border-[#1e2a3a] px-3 py-2 rounded-lg text-sm whitespace-nowrap flex items-center gap-2 text-slate-500 flex-shrink-0">
                    Submission #2 approved <span className="text-slate-600 text-xs ml-2">2 d ago</span>
                  </div>
                </div>
              ) : (
                <div className="space-y-2 mt-3">
                  {/* Expanded FYIs */}
                  <div className="flex items-center justify-between p-3 bg-[#0f1729] border border-[#1e2a3a] rounded-lg">
                    <div className="flex items-center gap-3">
                      <div className="w-2 h-2 rounded-full bg-cyan-400 shadow-[0_0_5px_#5fd0e0]"></div>
                      <div>
                        <div className="text-sm text-slate-200 font-medium">Render complete: 'Hero exterior · golden hour'</div>
                        <div className="text-xs text-slate-500">Redd Mixed-Use · 2 hr ago · 4K · 240 credits used</div>
                      </div>
                    </div>
                    <button className="text-xs text-slate-400 hover:text-white px-3 py-1 rounded bg-slate-800">View</button>
                  </div>
                  <div className="flex items-center justify-between p-3 bg-[#0f1729] border border-[#1e2a3a] rounded-lg">
                    <div className="flex items-center gap-3">
                      <div className="w-2 h-2 rounded-full bg-cyan-400 shadow-[0_0_5px_#5fd0e0]"></div>
                      <div>
                        <div className="text-sm text-slate-200 font-medium">Briefing regeneration finished — 14 sections updated</div>
                        <div className="text-xs text-slate-500">Bastrop Pavilion · yesterday · "New EJScreen data triggered changes..."</div>
                      </div>
                    </div>
                    <button className="text-xs text-slate-400 hover:text-white px-3 py-1 rounded bg-slate-800">View</button>
                  </div>
                  <div className="flex items-center justify-between p-3 bg-[#0b1220] border border-[#1e2a3a] rounded-lg opacity-70">
                    <div className="flex items-center gap-3">
                      <div className="w-2 h-2 rounded-full bg-slate-600"></div>
                      <div>
                        <div className="text-sm text-slate-400 font-medium">Submission #2 approved by Grand County reviewer</div>
                        <div className="text-xs text-slate-500">Redd Mixed-Use · 2 d ago · "Comments closed..."</div>
                      </div>
                    </div>
                    <button className="text-xs text-slate-500 hover:text-slate-300 px-3 py-1 rounded bg-slate-800/50">View</button>
                  </div>
                  <div className="flex items-center justify-between p-3 bg-[#0b1220] border border-[#1e2a3a] rounded-lg opacity-70">
                    <div className="flex items-center gap-3">
                      <div className="w-2 h-2 rounded-full bg-slate-600"></div>
                      <div>
                        <div className="text-sm text-slate-400 font-medium">Render complete: 'Lobby interior daylight'</div>
                        <div className="text-xs text-slate-500">Redd Mixed-Use · 4 d ago · 4K</div>
                      </div>
                    </div>
                    <button className="text-xs text-slate-500 hover:text-slate-300 px-3 py-1 rounded bg-slate-800/50">View</button>
                  </div>
                </div>
              )}
            </section>

            <div className="pt-8 flex justify-center">
              <button className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-300 transition-colors">
                <Archive className="w-4 h-4" />
                47 archived · view
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* RIGHT RAIL */}
      <div className="w-72 flex-shrink-0 bg-[#0f1729] border-l border-[#1e2a3a] p-5 flex flex-col overflow-y-auto">
        
        {/* Filters */}
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-4">
            <Filter className="w-4 h-4 text-slate-400" />
            <h3 className="text-sm font-medium text-slate-300 uppercase tracking-wider">Filter by engagement</h3>
          </div>
          
          <div className="space-y-2">
            <label className="flex items-center justify-between group cursor-pointer">
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 rounded border border-cyan-500 bg-cyan-500/20 flex items-center justify-center text-cyan-400">
                  <CheckSquare className="w-3 h-3" />
                </div>
                <span className="text-sm text-slate-200">Redd Mixed-Use</span>
              </div>
              <span className="text-xs text-slate-500 bg-slate-800 px-1.5 rounded">6</span>
            </label>
            <label className="flex items-center justify-between group cursor-pointer opacity-70 hover:opacity-100">
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 rounded border border-slate-600 flex items-center justify-center text-transparent">
                  <CheckSquare className="w-3 h-3" />
                </div>
                <span className="text-sm text-slate-400">Bastrop Pavilion</span>
              </div>
              <span className="text-xs text-slate-500 bg-slate-800 px-1.5 rounded">2</span>
            </label>
            <label className="flex items-center justify-between group cursor-pointer opacity-70 hover:opacity-100">
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 rounded border border-slate-600 flex items-center justify-center text-transparent">
                  <CheckSquare className="w-3 h-3" />
                </div>
                <span className="text-sm text-slate-400">Lemhi River Lodge</span>
              </div>
              <span className="text-xs text-slate-500 bg-slate-800 px-1.5 rounded">1</span>
            </label>
            <label className="flex items-center justify-between group cursor-pointer opacity-70 hover:opacity-100">
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 rounded border border-slate-600 flex items-center justify-center text-transparent">
                  <CheckSquare className="w-3 h-3" />
                </div>
                <span className="text-sm text-slate-400">Park City Civic</span>
              </div>
              <span className="text-xs text-slate-500 bg-slate-800 px-1.5 rounded">1</span>
            </label>
          </div>
        </div>

        {/* AI Suggestions */}
        <div className="mb-8">
          <div className="bg-gradient-to-b from-indigo-900/30 to-[#0f1729] border border-indigo-500/20 rounded-xl p-4 relative overflow-hidden">
            <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-500/10 blur-2xl rounded-full translate-x-10 -translate-y-10"></div>
            
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="w-4 h-4 text-indigo-400" />
              <h3 className="text-sm font-medium text-indigo-300">AI Assistant</h3>
            </div>
            
            <p className="text-sm text-slate-300 mb-4 leading-relaxed">
              I noticed you have <span className="font-medium text-white">3 reviewer requests</span> open. Want me to draft holding-reply messages to all 3?
            </p>
            
            <button className="w-full py-2 bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 text-sm font-medium rounded-lg border border-indigo-500/30 transition-colors">
              Generate Drafts
            </button>
          </div>
        </div>

        {/* Today's Plan */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-slate-300 uppercase tracking-wider">Today's plan</h3>
            <button className="text-xs text-cyan-400 hover:text-cyan-300">Edit</button>
          </div>
          
          <div className="relative before:absolute before:inset-y-0 before:left-[11px] before:w-px before:bg-[#1e2a3a] space-y-4">
            <div className="relative pl-8">
              <div className="absolute left-[8px] top-1.5 w-2 h-2 rounded-full bg-red-500 shadow-[0_0_8px_#ef4444]"></div>
              <div className="text-xs font-medium text-slate-300 mb-0.5">9:30 AM <span className="text-slate-500 font-normal ml-1">(45 min)</span></div>
              <div className="text-sm text-slate-400 leading-tight">Grand County corrections</div>
            </div>
            
            <div className="relative pl-8">
              <div className="absolute left-[8px] top-1.5 w-2 h-2 rounded-full bg-amber-500 shadow-[0_0_8px_#f59e0b]"></div>
              <div className="text-xs font-medium text-slate-300 mb-0.5">10:30 AM <span className="text-slate-500 font-normal ml-1">(15 min)</span></div>
              <div className="text-sm text-slate-400 leading-tight">BIM re-export</div>
            </div>
            
            <div className="relative pl-8 opacity-70">
              <div className="absolute left-[8px] top-1.5 w-2 h-2 rounded-full bg-slate-600"></div>
              <div className="text-xs font-medium text-slate-400 mb-0.5">10:45 AM <span className="text-slate-600 font-normal ml-1">(10 min)</span></div>
              <div className="text-sm text-slate-500 leading-tight">Briefing sources refresh</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
