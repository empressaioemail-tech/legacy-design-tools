import React, { useState } from "react";
import { 
  Inbox, Bell, AlertTriangle, Sparkles, AtSign, CheckCircle2, 
  Building2, Filter, Archive, Reply, ChevronRight, Check,
  Clock, UserPlus, Tag, MoreHorizontal, FileText,
  MessageSquare, FileCode, CheckSquare, XCircle, Search, Home, LayoutGrid, Settings, HelpCircle, User
} from "lucide-react";

export function TriageInbox() {
  const items = [
    {
      id: 1, type: "action-red", icon: AlertTriangle, color: "text-[#ef4444]", dot: "bg-[#ef4444]",
      title: "Grand County reviewer requested corrections on Submission #3",
      engagement: "Redd Mixed-Use", time: "14 min ago", unread: true,
      body: "4 findings to address; revision due Friday Jun 7",
    },
    {
      id: 2, type: "ai-alert", icon: Sparkles, color: "text-[#a78bfa]", dot: "bg-[#a78bfa]",
      title: "Product spec withdrawn: 'Old Window Sealant XYZ-200'",
      engagement: "Redd Mixed-Use", time: "1 hr ago", unread: true,
      body: "Used in detail D-W-04. Suggest swap to GE Silpruf SCS2000.",
    },
    {
      id: 3, type: "status", icon: CheckCircle2, color: "text-[#22c55e]", dot: "bg-[#22c55e]",
      title: "Render complete: 'Hero exterior · golden hour'",
      engagement: "Redd Mixed-Use", time: "2 hr ago", unread: true,
      body: "4K · 240 credits used",
    },
    {
      id: 4, type: "mention", icon: AtSign, color: "text-[#5fd0e0]", dot: "bg-[#5fd0e0]",
      title: "@Maria — James left a freehand markup on Sheet A3.1",
      engagement: "Redd Mixed-Use", time: "4 hr ago", unread: true,
      body: "Love these proportions! Make these bigger?",
    },
    {
      id: 5, type: "action-amber", icon: AlertTriangle, color: "text-[#f59e0b]", dot: "bg-[#f59e0b]",
      title: "Reviewer requested BIM model refresh",
      engagement: "Lemhi River Lodge", time: "6 hr ago", unread: true,
      body: "Jim P. (Lemhi County) requests an updated GLB export — last seen v2 from 3 wk ago.",
    },
    {
      id: 6, type: "status", icon: CheckCircle2, color: "text-[#22c55e]", dot: "bg-[#22c55e]",
      title: "Briefing regeneration finished — 14 sections updated",
      engagement: "Bastrop Pavilion", time: "yesterday", unread: true,
      body: "New EJScreen data triggered changes to Sections C and E.",
    },
    {
      id: 7, type: "status-read", icon: CheckCircle2, color: "text-[#64748b]", dot: "bg-[#64748b]",
      title: "Submission #2 approved by Grand County reviewer",
      engagement: "Redd Mixed-Use", time: "2 d ago", unread: false,
      body: "Comments closed. Letter #1 marked sent.",
    },
    {
      id: 8, type: "ai-read", icon: Sparkles, color: "text-[#64748b]", dot: "bg-[#64748b]",
      title: "Plan review run completed — 5 findings detected",
      engagement: "Bastrop Pavilion", time: "2 d ago", unread: false,
      body: "1 blocker, 3 concerns, 1 advisory.",
    },
    {
      id: 9, type: "mention-read", icon: AtSign, color: "text-[#64748b]", dot: "bg-[#64748b]",
      title: "@Maria — Sarah commented on Letter #2 draft",
      engagement: "Redd Mixed-Use", time: "3 d ago", unread: false,
      body: "Can we soften the tone of the intro paragraph?",
    },
    {
      id: 10, type: "action-read", icon: AlertTriangle, color: "text-[#64748b]", dot: "bg-[#64748b]",
      title: "Reviewer requested briefing sources refresh",
      engagement: "Park City Civic", time: "4 d ago", unread: false,
      body: "Add the new 2026 floodplain data.",
    },
    {
      id: 11, type: "ai-read", icon: Sparkles, color: "text-[#64748b]", dot: "bg-[#64748b]",
      title: "Render complete: 'Lobby interior daylight'",
      engagement: "Redd Mixed-Use", time: "4 d ago", unread: false,
      body: "4K · View render.",
    },
  ];

  const [selectedId, setSelectedId] = useState(1);
  const [hoveredId, setHoveredId] = useState<number | null>(null);

  return (
    <div className="flex h-screen w-full bg-[#0b1220] text-[#e2e8f0] font-sans overflow-hidden text-sm">
      {/* LEFT RAIL */}
      <div className="w-[64px] flex-shrink-0 flex flex-col items-center py-4 border-r border-[#1e2a3a] bg-[#0b1220] z-10 relative">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#5fd0e0] to-blue-600 flex items-center justify-center mb-6 shadow-[0_0_15px_rgba(95,208,224,0.3)]">
          <Building2 className="w-5 h-5 text-white" />
        </div>
        
        <div className="flex flex-col gap-4 w-full px-2">
          <div className="w-full aspect-square rounded-lg flex items-center justify-center text-[#94a3b8] hover:text-[#e2e8f0] hover:bg-[#1e2a3a]/50 cursor-pointer transition-colors relative">
            <Home className="w-5 h-5" />
          </div>
          
          <div className="w-full aspect-square rounded-lg flex items-center justify-center text-[#5fd0e0] bg-[#5fd0e0]/10 cursor-pointer transition-colors relative">
            <Inbox className="w-5 h-5" />
            <div className="absolute top-1 right-1 w-4 h-4 bg-[#5fd0e0] text-[#0b1220] rounded-full text-[10px] font-bold flex items-center justify-center">
              6
            </div>
          </div>
          
          <div className="w-full aspect-square rounded-lg flex items-center justify-center text-[#94a3b8] hover:text-[#e2e8f0] hover:bg-[#1e2a3a]/50 cursor-pointer transition-colors">
            <LayoutGrid className="w-5 h-5" />
          </div>
          <div className="w-full aspect-square rounded-lg flex items-center justify-center text-[#94a3b8] hover:text-[#e2e8f0] hover:bg-[#1e2a3a]/50 cursor-pointer transition-colors">
            <Search className="w-5 h-5" />
          </div>
        </div>

        <div className="mt-auto flex flex-col gap-4 w-full px-2">
          <div className="w-full aspect-square rounded-lg flex items-center justify-center text-[#94a3b8] hover:text-[#e2e8f0] hover:bg-[#1e2a3a]/50 cursor-pointer transition-colors">
            <HelpCircle className="w-5 h-5" />
          </div>
          <div className="w-full aspect-square rounded-lg flex items-center justify-center text-[#94a3b8] hover:text-[#e2e8f0] hover:bg-[#1e2a3a]/50 cursor-pointer transition-colors">
            <Settings className="w-5 h-5" />
          </div>
          <div className="w-full aspect-square rounded-lg flex items-center justify-center bg-[#1e2a3a] cursor-pointer transition-colors overflow-hidden">
            <img src="https://i.pravatar.cc/150?u=maria" alt="Maria" className="w-full h-full object-cover opacity-80" />
          </div>
        </div>
      </div>

      {/* LIST PANE */}
      <div className="w-[360px] flex-shrink-0 flex flex-col border-r border-[#1e2a3a] bg-[#0f1729] overflow-hidden">
        <div className="p-4 border-b border-[#1e2a3a] flex-shrink-0">
          <div className="flex space-x-4 mb-4 text-[#94a3b8] text-xs font-medium uppercase tracking-wider overflow-x-auto no-scrollbar whitespace-nowrap">
            <div className="text-[#e2e8f0] border-b-2 border-[#5fd0e0] pb-1 cursor-pointer">All · 11</div>
            <div className="hover:text-[#e2e8f0] cursor-pointer pb-1">Unread · 6</div>
            <div className="hover:text-[#e2e8f0] cursor-pointer pb-1">Action · 3</div>
            <div className="hover:text-[#e2e8f0] cursor-pointer pb-1">Mentions · 2</div>
            <div className="hover:text-[#e2e8f0] cursor-pointer pb-1">AI · 3</div>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2 text-xs">
              <button className="flex items-center space-x-1 px-2 py-1 bg-[#1e2a3a] rounded-md text-[#94a3b8] hover:text-[#e2e8f0]">
                <span>All engagements</span>
                <ChevronRight className="w-3 h-3 rotate-90" />
              </button>
              <button className="flex items-center space-x-1 px-2 py-1 bg-[#1e2a3a] rounded-md text-[#94a3b8] hover:text-[#e2e8f0]">
                <span>All types</span>
                <ChevronRight className="w-3 h-3 rotate-90" />
              </button>
            </div>
            <div className="flex items-center space-x-2">
              <button className="p-1 text-[#94a3b8] hover:text-[#e2e8f0]" title="Mark all read"><Check className="w-4 h-4" /></button>
              <button className="p-1 text-[#94a3b8] hover:text-[#e2e8f0]" title="Archive"><Archive className="w-4 h-4" /></button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto no-scrollbar">
          {items.map((item) => {
            const isSelected = item.id === selectedId;
            const isHovered = item.id === hoveredId;
            const Icon = item.icon;

            return (
              <div 
                key={item.id}
                onClick={() => setSelectedId(item.id)}
                onMouseEnter={() => setHoveredId(item.id)}
                onMouseLeave={() => setHoveredId(null)}
                className={`relative p-4 border-b border-[#1e2a3a]/50 cursor-pointer transition-colors group
                  ${isSelected ? 'bg-[#1e2a3a]/40' : item.unread ? 'bg-[#0f1729]' : 'bg-[#0b1220]/50'}
                  ${isHovered && !isSelected ? 'bg-[#1e2a3a]/20' : ''}
                `}
              >
                {/* Left status bar */}
                <div className={`absolute left-0 top-0 bottom-0 w-[3px] ${isSelected ? 'bg-[#5fd0e0]' : (item.unread ? item.dot : 'bg-transparent')}`} />
                
                {/* Content */}
                <div className="flex items-start gap-3 pl-1">
                  <div className={`mt-0.5 ${item.color}`}>
                    <Icon className="w-4 h-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <div className="text-[10px] uppercase font-semibold text-[#94a3b8] truncate">{item.engagement}</div>
                      <div className="text-[10px] text-[#94a3b8] whitespace-nowrap ml-2 flex-shrink-0">{item.time}</div>
                    </div>
                    <div className={`text-sm leading-tight mb-1 line-clamp-2 pr-4 ${item.unread ? 'font-medium text-[#e2e8f0]' : 'text-[#94a3b8]'}`}>
                      {item.title}
                    </div>
                    <div className="text-xs text-[#94a3b8] truncate pr-4">
                      {item.body}
                    </div>
                  </div>
                </div>

                {/* Keyboard hints on hover */}
                {isHovered && !isSelected && (
                  <div className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center space-x-1 bg-[#1e2a3a] px-2 py-1 rounded shadow-lg opacity-0 group-hover:opacity-100 transition-opacity">
                    <span className="text-[10px] text-[#94a3b8]"><kbd className="font-mono bg-[#0b1220] px-1 py-0.5 rounded border border-[#1e2a3a]">E</kbd> arc</span>
                    <span className="text-[10px] text-[#94a3b8]"><kbd className="font-mono bg-[#0b1220] px-1 py-0.5 rounded border border-[#1e2a3a]">S</kbd> snz</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex-shrink-0 p-3 border-t border-[#1e2a3a] text-xs text-[#64748b] flex justify-between items-center bg-[#0b1220]">
          <span>11 items</span>
          <span>0:18 avg triage time today</span>
        </div>
      </div>

      {/* DETAIL PANE */}
      <div className="flex-1 flex flex-col min-w-0 bg-[#0b1220]">
        <div className="p-6 pb-0 flex-shrink-0">
          <div className="flex items-center space-x-2 text-xs text-[#94a3b8] mb-4">
            <span className="hover:text-[#e2e8f0] cursor-pointer">Redd Mixed-Use</span>
            <ChevronRight className="w-3 h-3" />
            <span className="hover:text-[#e2e8f0] cursor-pointer">Submission #3</span>
            <ChevronRight className="w-3 h-3" />
            <span className="px-2 py-0.5 rounded bg-[#ef4444]/10 text-[#ef4444] border border-[#ef4444]/20">Corrections requested</span>
          </div>
          
          <div className="flex justify-between items-start gap-4 mb-4">
            <h1 className="text-2xl font-semibold text-[#e2e8f0] leading-tight max-w-[80%]">
              Grand County reviewer requested corrections on Submission #3
            </h1>
            <button className="flex items-center space-x-2 px-3 py-1.5 bg-[#1e2a3a] hover:bg-[#2a3b52] rounded-md text-sm transition-colors border border-[#1e2a3a] hover:border-[#374151]">
              <Reply className="w-4 h-4" />
              <span>Reply</span>
            </button>
          </div>

          <div className="flex items-center space-x-3 mb-8">
            <img src="https://i.pravatar.cc/150?u=jim" alt="Jim Petersen" className="w-8 h-8 rounded-full bg-[#1e2a3a]" />
            <div>
              <div className="text-sm font-medium text-[#e2e8f0]">Jim Petersen</div>
              <div className="text-xs text-[#94a3b8]">Grand County · 14 min ago</div>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 pb-8 no-scrollbar">
          <div className="bg-[#0f1729] rounded-xl border border-[#1e2a3a] overflow-hidden mb-6">
            <div className="p-5 border-b border-[#1e2a3a]">
              <div className="pl-4 border-l-2 border-[#1e2a3a] text-[#94a3b8] italic text-sm mb-6">
                "I've reviewed the latest submission for Redd Mixed-Use. There are a few outstanding items regarding the egress widths and the window sealant specs in the Type D units. Please address these 4 findings before we can proceed with approval. The deadline for revision is Friday Jun 7."
              </div>

              <div className="flex items-center space-x-4 text-sm font-medium text-[#e2e8f0]">
                <div className="flex items-center space-x-2">
                  <AlertTriangle className="w-4 h-4 text-[#ef4444]" />
                  <span>4 findings to address</span>
                </div>
                <div className="w-1 h-1 rounded-full bg-[#334155]" />
                <div className="flex items-center space-x-2">
                  <Clock className="w-4 h-4 text-[#f59e0b]" />
                  <span>Revision due Friday Jun 7</span>
                </div>
                <div className="w-1 h-1 rounded-full bg-[#334155]" />
                <span className="text-[#94a3b8]">6 days from now</span>
              </div>
            </div>

            <div className="p-5 bg-[#0b1220]/50">
              <h3 className="text-xs font-semibold text-[#94a3b8] uppercase tracking-wider mb-4">Findings preview</h3>
              <div className="grid grid-cols-2 gap-3">
                {[
                  { id: "F-102", title: "Egress stair width below minimum", code: "IBC 1011.2", sev: "bg-[#ef4444]" },
                  { id: "F-103", title: "Unapproved sealant in D-W-04", code: "Local 14.3", sev: "bg-[#ef4444]" },
                  { id: "F-104", title: "Missing fire block details on Level 3", code: "IBC 718.2", sev: "bg-[#f59e0b]" },
                  { id: "F-105", title: "Clarify ADA turning radius in Unit C", code: "ANSI 117.1", sev: "bg-[#f59e0b]" },
                ].map((finding) => (
                  <div key={finding.id} className="bg-[#0f1729] border border-[#1e2a3a] rounded-lg p-3 hover:border-[#5fd0e0]/50 cursor-pointer transition-colors">
                    <div className="flex items-center space-x-2 mb-2">
                      <div className={`w-2 h-2 rounded-full ${finding.sev}`} />
                      <span className="text-xs font-medium text-[#e2e8f0]">{finding.id}</span>
                      <span className="px-1.5 py-0.5 rounded bg-[#1e2a3a] text-[#94a3b8] text-[10px]">{finding.code}</span>
                    </div>
                    <div className="text-sm text-[#94a3b8] truncate">{finding.title}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="mb-8">
            <h3 className="text-xs font-semibold text-[#94a3b8] uppercase tracking-wider mb-3">Suggested next steps</h3>
            <div className="flex flex-wrap gap-3">
              <button className="flex items-center space-x-2 px-4 py-2.5 bg-gradient-to-r from-[#0b4a56] to-[#0f3442] hover:from-[#0d5b6b] hover:to-[#124456] border border-[#5fd0e0]/30 rounded-lg text-[#5fd0e0] text-sm font-medium transition-all shadow-[0_0_15px_rgba(95,208,224,0.1)] hover:shadow-[0_0_20px_rgba(95,208,224,0.2)]">
                <FileCode className="w-4 h-4" />
                <span>Open submission</span>
                <ChevronRight className="w-4 h-4 ml-1 opacity-70" />
              </button>
              
              <button className="flex items-center space-x-2 px-4 py-2.5 bg-[#1e2a3a] hover:bg-[#2a3b52] border border-[#1e2a3a] hover:border-[#374151] rounded-lg text-[#e2e8f0] text-sm font-medium transition-colors">
                <Sparkles className="w-4 h-4 text-[#a78bfa]" />
                <span>Draft response letter (AI)</span>
              </button>
              
              <button className="flex items-center space-x-2 px-4 py-2.5 bg-[#1e2a3a] hover:bg-[#2a3b52] border border-[#1e2a3a] hover:border-[#374151] rounded-lg text-[#e2e8f0] text-sm font-medium transition-colors">
                <UserPlus className="w-4 h-4 text-[#94a3b8]" />
                <span>Assign to teammate</span>
              </button>
            </div>
          </div>

          <div>
            <h3 className="text-xs font-semibold text-[#64748b] uppercase tracking-wider mb-3">Activity / Related in Inbox</h3>
            <div className="border-l border-[#1e2a3a] ml-2 pl-4 py-1 space-y-4">
              <div className="flex items-start gap-3">
                <div className="w-5 h-5 rounded-full bg-[#0f1729] border border-[#1e2a3a] flex items-center justify-center -ml-[27px] mt-0.5 shrink-0 text-[#5fd0e0]">
                  <AtSign className="w-3 h-3" />
                </div>
                <div>
                  <div className="text-sm text-[#e2e8f0]">James left a freehand markup on Sheet A3.1</div>
                  <div className="text-xs text-[#64748b]">4 hr ago · <span className="text-[#5fd0e0] hover:underline cursor-pointer">Open markup</span></div>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-5 h-5 rounded-full bg-[#0f1729] border border-[#1e2a3a] flex items-center justify-center -ml-[27px] mt-0.5 shrink-0 text-[#22c55e]">
                  <CheckCircle2 className="w-3 h-3" />
                </div>
                <div>
                  <div className="text-sm text-[#e2e8f0]">Render complete: 'Hero exterior · golden hour'</div>
                  <div className="text-xs text-[#64748b]">2 hr ago · <span className="text-[#5fd0e0] hover:underline cursor-pointer">View render</span></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* RIGHT INSPECTOR */}
      <div className="w-[240px] flex-shrink-0 border-l border-[#1e2a3a] bg-[#0f1729] flex flex-col">
        <div className="p-4 border-b border-[#1e2a3a]">
          <h3 className="text-xs font-semibold text-[#94a3b8] uppercase tracking-wider mb-3">Actions</h3>
          <div className="space-y-1">
            <button className="w-full flex items-center space-x-3 px-3 py-2 rounded-md hover:bg-[#1e2a3a] text-[#e2e8f0] transition-colors text-sm text-left group">
              <CheckSquare className="w-4 h-4 text-[#94a3b8] group-hover:text-[#22c55e]" />
              <span>Mark done</span>
            </button>
            <button className="w-full flex items-center justify-between px-3 py-2 rounded-md hover:bg-[#1e2a3a] text-[#e2e8f0] transition-colors text-sm text-left group">
              <div className="flex items-center space-x-3">
                <Clock className="w-4 h-4 text-[#94a3b8] group-hover:text-[#e2e8f0]" />
                <span>Snooze</span>
              </div>
              <ChevronRight className="w-3 h-3 text-[#64748b] rotate-90" />
            </button>
            <button className="w-full flex items-center space-x-3 px-3 py-2 rounded-md hover:bg-[#1e2a3a] text-[#e2e8f0] transition-colors text-sm text-left group">
              <Archive className="w-4 h-4 text-[#94a3b8] group-hover:text-[#e2e8f0]" />
              <span>Archive</span>
            </button>
            <button className="w-full flex items-center space-x-3 px-3 py-2 rounded-md hover:bg-[#1e2a3a] text-[#e2e8f0] transition-colors text-sm text-left group">
              <UserPlus className="w-4 h-4 text-[#94a3b8] group-hover:text-[#e2e8f0]" />
              <span>Assign</span>
            </button>
            <button className="w-full flex items-center space-x-3 px-3 py-2 rounded-md hover:bg-[#1e2a3a] text-[#e2e8f0] transition-colors text-sm text-left group">
              <Tag className="w-4 h-4 text-[#94a3b8] group-hover:text-[#e2e8f0]" />
              <span>Tag</span>
            </button>
          </div>
        </div>

        <div className="p-4 border-b border-[#1e2a3a]">
          <h3 className="text-xs font-semibold text-[#94a3b8] uppercase tracking-wider mb-3">About engagement</h3>
          <div className="bg-[#0b1220] rounded-lg p-3 border border-[#1e2a3a]">
            <div className="flex items-center space-x-2 mb-2">
              <div className="w-8 h-8 rounded bg-[#1e2a3a] flex items-center justify-center text-[#5fd0e0]">
                <Building2 className="w-4 h-4" />
              </div>
              <div>
                <div className="text-sm font-medium text-[#e2e8f0]">Redd Mixed-Use</div>
                <div className="text-[10px] text-[#64748b] uppercase">Design Dev</div>
              </div>
            </div>
            <div className="flex items-center justify-between text-xs mt-3 pt-3 border-t border-[#1e2a3a]">
              <span className="text-[#94a3b8]">Inbox items</span>
              <span className="text-[#5fd0e0] cursor-pointer hover:underline">6 items</span>
            </div>
          </div>
        </div>

        <div className="p-4">
          <h3 className="text-xs font-semibold text-[#94a3b8] uppercase tracking-wider mb-3">Reviewer profile</h3>
          <div className="bg-[#0b1220] rounded-lg p-3 border border-[#1e2a3a]">
            <div className="flex items-center space-x-2 mb-3">
              <img src="https://i.pravatar.cc/150?u=jim" alt="Jim Petersen" className="w-8 h-8 rounded-full bg-[#1e2a3a]" />
              <div>
                <div className="text-sm font-medium text-[#e2e8f0]">Jim Petersen</div>
                <div className="text-xs text-[#94a3b8]">Grand County</div>
              </div>
            </div>
            <div className="space-y-1.5 text-xs">
              <div className="flex justify-between">
                <span className="text-[#64748b]">Reviews (YTD)</span>
                <span className="text-[#e2e8f0]">18</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#64748b]">Usual turnaround</span>
                <span className="text-[#e2e8f0]">3-5 days</span>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-auto p-4 bg-[#0b1220] border-t border-[#1e2a3a]">
          <div className="grid grid-cols-2 gap-y-2 text-[10px] text-[#64748b]">
            <div className="flex items-center space-x-1.5">
              <kbd className="font-mono bg-[#1e2a3a] px-1 py-0.5 rounded text-[#94a3b8]">J</kbd>
              <kbd className="font-mono bg-[#1e2a3a] px-1 py-0.5 rounded text-[#94a3b8]">K</kbd>
              <span>next/prev</span>
            </div>
            <div className="flex items-center space-x-1.5">
              <kbd className="font-mono bg-[#1e2a3a] px-1 py-0.5 rounded text-[#94a3b8]">E</kbd>
              <span>archive</span>
            </div>
            <div className="flex items-center space-x-1.5">
              <kbd className="font-mono bg-[#1e2a3a] px-1 py-0.5 rounded text-[#94a3b8]">S</kbd>
              <span>snooze</span>
            </div>
            <div className="flex items-center space-x-1.5">
              <kbd className="font-mono bg-[#1e2a3a] px-1 py-0.5 rounded text-[#94a3b8]">A</kbd>
              <span>assign</span>
            </div>
            <div className="flex items-center space-x-1.5">
              <kbd className="font-mono bg-[#1e2a3a] px-1 py-0.5 rounded text-[#94a3b8]">R</kbd>
              <span>reply</span>
            </div>
            <div className="flex items-center space-x-1.5 col-span-2 mt-1">
              <kbd className="font-mono bg-[#1e2a3a] px-1 py-0.5 rounded text-[#94a3b8]">⌘ ↵</kbd>
              <span>open in engagement</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
