import React, { useState } from "react";
import {
  Inbox,
  Send,
  FileText,
  MessageSquare,
  Paperclip,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Sparkles,
  Plus,
  RefreshCw,
  Eye,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  ArrowRight,
  File,
  Download,
  Settings,
  X,
  FileCheck2,
  Search,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";

export function LetterThread() {
  const [rightPaneOpen, setRightPaneOpen] = useState(true);

  return (
    <div className="flex h-[900px] w-full bg-[#0b1220] text-slate-300 font-sans overflow-hidden">
      {/* LEFT PANE - Conversations Rail */}
      <div className="w-[320px] flex-shrink-0 flex flex-col border-r border-[#1e2a3a] bg-[#0b1220]">
        <div className="p-4 border-b border-[#1e2a3a] flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-200 tracking-wide">
              DELIVERABLES
            </h2>
            <button className="text-cyan-400 hover:text-cyan-300 transition-colors">
              <Plus size={16} />
            </button>
          </div>
          <div className="relative">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
            />
            <input
              type="text"
              placeholder="Search threads & evidence..."
              className="w-full bg-[#0f1729] border border-[#1e2a3a] rounded-md py-1.5 pl-8 pr-3 text-sm text-slate-200 focus:outline-none focus:border-cyan-500/50 transition-colors"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar">
          {/* INBOX */}
          <div className="px-4 py-3 border-b border-[#1e2a3a]/50">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Inbox size={14} className="text-slate-400" />
                <span className="text-xs font-medium text-slate-400">
                  INBOX
                </span>
              </div>
              <span className="text-[10px] text-slate-500 font-medium">
                2 ACTIVE · 1 CLOSED
              </span>
            </div>

            <div className="flex flex-col gap-1">
              {/* Active Thread */}
              <div className="relative p-3 rounded-lg bg-[#0f1729] border border-cyan-500/30 cursor-pointer group">
                <div className="absolute left-0 top-0 bottom-0 w-[3px] bg-cyan-500 rounded-l-lg" />
                <div className="flex justify-between items-start mb-1">
                  <span className="text-xs font-medium text-slate-200">
                    Grand County
                  </span>
                  <span className="text-[10px] text-slate-500">1 hr ago</span>
                </div>
                <div className="text-sm text-slate-300 font-medium truncate mb-2">
                  Response to Submission #3
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-amber-500/10 text-amber-500 border border-amber-500/20">
                      DRAFT
                    </span>
                    <div className="flex -space-x-1">
                      <div className="w-4 h-4 rounded-full bg-cyan-600 flex items-center justify-center text-[8px] font-bold text-white ring-1 ring-[#0f1729]">
                        M
                      </div>
                    </div>
                  </div>
                  <div className="w-1.5 h-1.5 rounded-full bg-cyan-500 shadow-[0_0_4px_rgba(95,208,224,0.5)]" />
                </div>
              </div>

              {/* Sent Thread */}
              <div className="relative p-3 rounded-lg hover:bg-[#0f1729]/50 border border-transparent cursor-pointer transition-colors">
                <div className="flex justify-between items-start mb-1">
                  <span className="text-xs font-medium text-slate-400">
                    Grand County
                  </span>
                  <span className="text-[10px] text-slate-500">5 d ago</span>
                </div>
                <div className="text-sm text-slate-400 truncate mb-2">
                  Response to Submission #2
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-green-500/10 text-green-500 border border-green-500/20">
                      SENT
                    </span>
                  </div>
                </div>
              </div>

              {/* AI Draft Thread */}
              <div className="relative p-3 rounded-lg hover:bg-[#0f1729]/50 border border-transparent cursor-pointer transition-colors">
                <div className="flex justify-between items-start mb-1">
                  <span className="text-xs font-medium text-slate-400">
                    System
                  </span>
                  <span className="text-[10px] text-slate-500">Just now</span>
                </div>
                <div className="text-sm text-slate-400 truncate mb-2 flex items-center gap-1.5">
                  <Sparkles size={12} className="text-violet-400" />
                  <span>Cover letter for Submission #3</span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-violet-500/10 text-violet-400 border border-violet-500/20">
                      AI DRAFT
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* EVIDENCE STAGED */}
          <div className="px-4 py-3">
            <div className="flex items-center justify-between mb-3 cursor-pointer group">
              <div className="flex items-center gap-2">
                <Paperclip size={14} className="text-slate-400" />
                <span className="text-xs font-medium text-slate-400 group-hover:text-slate-300 transition-colors">
                  EVIDENCE STAGED (10)
                </span>
              </div>
              <ChevronDown size={14} className="text-slate-500" />
            </div>

            <div className="flex flex-wrap gap-1.5 mb-3">
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-500/10 text-green-500 border border-green-500/20">
                5 VERIFIED
              </span>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/10 text-amber-500 border border-amber-500/20">
                3 PENDING
              </span>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-500/10 text-red-400 border border-red-500/20 flex items-center gap-1">
                <AlertTriangle size={10} /> 1 WITHDRAWN
              </span>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-500/10 text-violet-400 border border-violet-500/20 flex items-center gap-1">
                <Sparkles size={10} /> 1 AI
              </span>
            </div>

            <div className="flex flex-col gap-1.5">
              {/* Product Spec - Active */}
              <div className="p-2 rounded border border-[#1e2a3a] bg-[#0f1729]/50 flex flex-col gap-1 cursor-grab hover:border-cyan-500/30 transition-colors">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <FileCheck2 size={12} className="text-cyan-500" />
                    <span className="text-xs font-medium text-slate-300">
                      DensGlass Sheathing
                    </span>
                  </div>
                  <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                </div>
                <div className="text-[10px] text-slate-500 pl-4.5">
                  ESR-1006 · Georgia-Pacific
                </div>
              </div>

              {/* Product Spec - Withdrawn */}
              <div className="p-2 rounded border border-red-500/30 bg-red-500/5 flex flex-col gap-1 cursor-grab">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <FileCheck2 size={12} className="text-red-400" />
                    <span className="text-xs font-medium text-red-200">
                      Window Sealant XYZ-200
                    </span>
                  </div>
                  <div className="w-1.5 h-1.5 rounded-full bg-red-500" />
                </div>
                <div className="text-[10px] text-red-400/70 pl-4.5">
                  ESR-1432 · AcmeCo
                </div>
              </div>

              {/* Callout Spec - Applied */}
              <div className="p-2 rounded border border-[#1e2a3a] bg-[#0f1729]/50 flex flex-col gap-1 cursor-grab hover:border-cyan-500/30 transition-colors">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <MessageSquare size={12} className="text-cyan-500" />
                    <span className="text-xs font-medium text-slate-300">
                      Wall type W-A
                    </span>
                  </div>
                  <span className="text-[9px] text-green-500">APPLIED</span>
                </div>
                <div className="text-[10px] text-slate-500 pl-4.5 truncate">
                  Exterior 2×6 stud, R-21 batt...
                </div>
              </div>

              <div className="text-center py-2">
                <span className="text-xs text-slate-500 hover:text-slate-400 cursor-pointer">
                  + 7 more items
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* CENTER PANE - Thread View */}
      <div className="flex-1 flex flex-col bg-[#0b1220]">
        {/* Thread Header */}
        <div className="h-14 border-b border-[#1e2a3a] flex items-center justify-between px-6 bg-[#0f1729]/50 shrink-0">
          <div className="flex items-center gap-3">
            <h1 className="text-base font-medium text-slate-200">
              Response to Submission #3
            </h1>
            <span className="px-2 py-0.5 rounded text-xs font-medium bg-amber-500/10 text-amber-500 border border-amber-500/20">
              DRAFT
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button className="px-3 py-1.5 text-xs font-medium text-slate-300 bg-[#0b1220] border border-[#1e2a3a] rounded hover:bg-[#1e2a3a] transition-colors flex items-center gap-1.5">
              <RefreshCw size={12} />
              Render
            </button>
            <button className="px-3 py-1.5 text-xs font-medium text-slate-300 bg-[#0b1220] border border-[#1e2a3a] rounded hover:bg-[#1e2a3a] transition-colors flex items-center gap-1.5">
              Save
            </button>
            <div className="h-4 w-px bg-[#1e2a3a] mx-1" />
            <button
              className="p-1.5 text-slate-400 hover:text-slate-300 transition-colors"
              onClick={() => setRightPaneOpen(!rightPaneOpen)}
            >
              {rightPaneOpen ? (
                <PanelRightClose size={16} />
              ) : (
                <PanelRightOpen size={16} />
              )}
            </button>
          </div>
        </div>

        {/* Thread Content */}
        <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6 custom-scrollbar">
          {/* Inbound Message */}
          <div className="flex gap-4 max-w-3xl">
            <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-xs font-medium text-slate-300 shrink-0 mt-1">
              JP
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-slate-300">
                  Jim Petersen
                </span>
                <span className="text-xs text-slate-500">· Grand County</span>
                <span className="text-xs text-slate-500">· 4 hr ago</span>
              </div>
              <div className="p-4 rounded-lg bg-[#0f1729] border border-[#1e2a3a] text-sm text-slate-400 leading-relaxed relative">
                <div className="absolute -left-2 top-4 w-2 h-2 bg-[#0f1729] border-l border-b border-[#1e2a3a] rotate-45" />
                <p className="mb-2">
                  Please review the attached corrections for Submission #3. Note
                  specifically F-12 regarding exterior wall assembly compliance
                  and F-15 concerning the roof membrane verification.
                </p>
                <div className="flex items-center gap-2 mt-3 pt-3 border-t border-[#1e2a3a]/50">
                  <File size={14} className="text-slate-500" />
                  <span className="text-xs font-medium text-cyan-500 cursor-pointer hover:underline">
                    Corrections_Sub3_Final.pdf
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Outbound Draft */}
          <div className="flex gap-4 max-w-4xl ml-8">
            <div className="w-8 h-8 rounded-full bg-cyan-900/50 flex items-center justify-center text-xs font-medium text-cyan-400 border border-cyan-500/30 shrink-0 mt-1">
              M
            </div>
            <div className="flex-1 flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-slate-200">
                    Maria
                  </span>
                  <span className="text-xs text-cyan-500">· Outbound DRAFT</span>
                  <span className="text-xs text-slate-500">· editing now</span>
                </div>
                <MoreHorizontal size={14} className="text-slate-500 cursor-pointer hover:text-slate-300" />
              </div>

              <div className="rounded-lg bg-[#0f1729] border border-cyan-500/20 shadow-lg shadow-cyan-500/5 overflow-hidden relative">
                <div className="absolute -left-2 top-4 w-2 h-2 bg-[#0f1729] border-l border-b border-cyan-500/20 rotate-45" />

                {/* Letter Sections */}
                <div className="flex flex-col divide-y divide-[#1e2a3a]/50">
                  {/* Cover Section */}
                  <div className="p-4 flex gap-3 group hover:bg-[#0b1220]/30 transition-colors">
                    <ChevronRight size={16} className="text-slate-600 mt-0.5 cursor-pointer" />
                    <div className="flex-1">
                      <div className="text-sm font-medium text-slate-300 mb-1">Cover</div>
                      <div className="text-xs text-slate-500 line-clamp-1">To whom it may concern, enclosed please find our responses to...</div>
                    </div>
                  </div>

                  {/* F-12 Section (Expanded) */}
                  <div className="p-4 flex gap-3 bg-[#0b1220]/50 relative">
                    <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-cyan-500" />
                    <ChevronDown size={16} className="text-cyan-500 mt-0.5 cursor-pointer" />
                    <div className="flex-1 flex flex-col gap-4">
                      <div className="flex items-center justify-between">
                        <div className="text-sm font-medium text-cyan-400">Response to F-12</div>
                        <div className="flex items-center gap-2">
                          <button className="text-xs text-slate-400 hover:text-slate-300">Format</button>
                          <button className="text-xs text-slate-400 hover:text-slate-300">Insert</button>
                        </div>
                      </div>

                      <div className="text-sm text-slate-300 leading-relaxed bg-[#0f1729] border border-[#1e2a3a] rounded-md p-3 focus-within:border-cyan-500/50 outline-none" contentEditable suppressContentEditableWarning>
                        Regarding finding F-12, the exterior wall assembly WS-12 has been updated to reflect the required fire rating. We have specified DensGlass Sheathing which maintains compliance per ESR-1006. Note that the previously cited window sealant has been flagged and we are in the process of replacing it.
                      </div>

                      {/* Inline Evidence embedded in section */}
                      <div className="flex flex-col gap-2 p-3 bg-[#0b1220] rounded-md border border-[#1e2a3a]">
                        <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Pinned Evidence</div>

                        <div className="flex items-center gap-3">
                          {/* Evidence Chip 1 */}
                          <div className="flex-1 p-2 rounded border border-[#1e2a3a] bg-[#0f1729] flex flex-col gap-1 group/chip">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-1.5">
                                <MessageSquare size={12} className="text-cyan-500" />
                                <span className="text-xs font-medium text-slate-300">Wall section WS-12</span>
                              </div>
                              <span className="text-[9px] text-amber-500">DRAFT</span>
                            </div>
                            <div className="text-[10px] text-slate-500 pl-4.5 truncate">
                              Footing to parapet at typical ext...
                            </div>
                          </div>

                          {/* Evidence Chip 2 */}
                          <div className="flex-1 p-2 rounded border border-[#1e2a3a] bg-[#0f1729] flex flex-col gap-1 group/chip">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-1.5">
                                <FileCheck2 size={12} className="text-cyan-500" />
                                <span className="text-xs font-medium text-slate-300">DensGlass</span>
                              </div>
                              <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                            </div>
                            <div className="text-[10px] text-slate-500 pl-4.5 truncate">
                              ESR-1006 · ACTIVE
                            </div>
                          </div>

                          {/* Evidence Chip 3 - Warning */}
                          <div className="flex-1 p-2 rounded border border-red-500/40 bg-red-500/10 flex flex-col gap-1 relative overflow-hidden group/chip">
                            <div className="absolute top-0 right-0 bg-red-500/20 text-red-400 text-[8px] px-1 py-0.5 rounded-bl font-medium flex items-center gap-0.5">
                              <AlertTriangle size={8} /> SWAP REQ
                            </div>
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-1.5">
                                <FileCheck2 size={12} className="text-red-400" />
                                <span className="text-xs font-medium text-red-200 truncate pr-6">Window Sealant</span>
                              </div>
                            </div>
                            <div className="text-[10px] text-red-400/80 pl-4.5 truncate">
                              WITHDRAWN
                            </div>
                          </div>
                        </div>

                        {/* Error Ribbon */}
                        <div className="mt-1 flex items-start gap-1.5 text-red-400 text-[11px] bg-red-500/5 p-1.5 rounded border border-red-500/20">
                          <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                          <span>⚠ 1 cited spec withdrawn — swap before sending.</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Signature Section */}
                  <div className="p-4 flex gap-3 group hover:bg-[#0b1220]/30 transition-colors">
                    <ChevronRight size={16} className="text-slate-600 mt-0.5 cursor-pointer" />
                    <div className="flex-1">
                      <div className="text-sm font-medium text-slate-300 mb-1">Signature</div>
                      <div className="text-xs text-slate-500">Sincerely, Maria · Principal Architect</div>
                    </div>
                  </div>
                </div>

                {/* AI Suggestions & Add Section */}
                <div className="p-3 bg-[#0b1220] border-t border-cyan-500/20 flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <button className="px-3 py-1.5 rounded bg-[#0f1729] border border-[#1e2a3a] text-xs font-medium text-slate-300 hover:border-cyan-500/50 hover:text-cyan-400 transition-colors flex items-center gap-1.5 w-fit">
                      <Plus size={12} />
                      Add section
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2 mt-1">
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-violet-500/10 border border-violet-500/20 text-[11px] text-violet-300 cursor-pointer hover:bg-violet-500/20 transition-colors">
                      <Sparkles size={10} />
                      Suggested: add response to F-15 — draft?
                    </div>
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-violet-500/10 border border-violet-500/20 text-[11px] text-violet-300 cursor-pointer hover:bg-violet-500/20 transition-colors">
                      <Sparkles size={10} />
                      Suggested: cite Tyvek HomeWrap (pending)
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="h-8" /> {/* Spacer */}
        </div>

        {/* Footer Actions */}
        <div className="h-16 border-t border-[#1e2a3a] bg-[#0f1729]/80 shrink-0 px-6 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex flex-col">
              <div className="text-[10px] font-medium text-slate-500 mb-1">RENDER QUEUE</div>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5 text-xs text-slate-400">
                  <FileText size={12} />
                  <span>PDF v0</span>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-slate-400">
                  <FileText size={12} />
                  <span>DOCX v0</span>
                </div>
                <button className="text-[11px] text-cyan-500 font-medium hover:underline ml-1">
                  Generate
                </button>
              </div>
            </div>
          </div>

          <div className="relative group/tooltip">
            <button className="px-4 py-2 bg-cyan-600 text-white text-sm font-medium rounded opacity-50 cursor-not-allowed flex items-center gap-2">
              <Send size={14} />
              Send to jurisdiction
            </button>
            <div className="absolute bottom-full right-0 mb-2 w-48 p-2 bg-[#1e2a3a] border border-[#2a3f5a] rounded text-[10px] text-slate-300 hidden group-hover/tooltip:block shadow-xl z-10">
              Cannot send: Wait for renders to generate and resolve 1 withdrawn product spec.
            </div>
          </div>
        </div>
      </div>

      {/* RIGHT PANE - Evidence Inspector */}
      {rightPaneOpen && (
        <div className="w-[320px] flex-shrink-0 flex flex-col border-l border-[#1e2a3a] bg-[#0f1729]/30">
          <div className="p-4 border-b border-[#1e2a3a] flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-200 tracking-wide">
              INSPECTOR
            </h2>
            <button
              className="text-slate-500 hover:text-slate-300 transition-colors"
              onClick={() => setRightPaneOpen(false)}
            >
              <X size={16} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-6 custom-scrollbar">
            {/* Context Header */}
            <div>
              <div className="text-[10px] font-bold text-cyan-500 uppercase tracking-wider mb-2">
                Active Context
              </div>
              <div className="text-sm font-medium text-slate-200 mb-1">
                Section: Response to F-12
              </div>
              <div className="text-xs text-slate-500">
                Editing inline content and 3 evidence links.
              </div>
            </div>

            {/* Linked Finding */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <div className="h-px flex-1 bg-[#1e2a3a]" />
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                  Origin Finding
                </span>
                <div className="h-px flex-1 bg-[#1e2a3a]" />
              </div>
              
              <div className="p-3 bg-[#0b1220] border border-[#1e2a3a] rounded-lg">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold text-red-400">F-12</span>
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-red-500/10 text-red-400 border border-red-500/20">
                    SEVERE
                  </span>
                </div>
                <div className="text-xs text-slate-300 mb-2">
                  Exterior wall assembly fire rating not clearly specified on A4.
                </div>
                <div className="text-[10px] text-slate-500">
                  Ref: IBC 2021 Sec 705.5
                </div>
              </div>
            </div>

            {/* Inspecting Evidence Item (The withdrawn one) */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <div className="h-px flex-1 bg-[#1e2a3a]" />
                <span className="text-[10px] font-semibold text-red-400 uppercase tracking-wider">
                  Needs Attention
                </span>
                <div className="h-px flex-1 bg-[#1e2a3a]" />
              </div>

              <div className="p-3 bg-red-500/5 border border-red-500/30 rounded-lg flex flex-col gap-3">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-1.5">
                      <FileCheck2 size={14} className="text-red-400" />
                      <span className="text-sm font-medium text-red-200">
                        Old Window Sealant
                      </span>
                    </div>
                  </div>
                  <div className="text-xs text-slate-400 mb-0.5">
                    ESR-1432 · AcmeCo
                  </div>
                  <div className="text-[10px] text-red-400/80">
                    Status: WITHDRAWN · Last valid 2 mo ago
                  </div>
                </div>

                <div className="bg-[#0b1220] p-2 rounded border border-red-500/20 text-xs text-slate-300">
                  This product's evaluation report has been withdrawn by the manufacturer. It cannot be used as compliance evidence.
                </div>

                <div className="flex flex-col gap-2 pt-2 border-t border-red-500/20">
                  <button className="w-full py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 text-xs font-medium rounded border border-red-500/30 transition-colors">
                    Swap Evidence
                  </button>
                  <div className="flex gap-2">
                    <button className="flex-1 py-1.5 bg-[#0b1220] hover:bg-[#1e2a3a] text-slate-300 text-xs font-medium rounded border border-[#1e2a3a] transition-colors flex justify-center items-center gap-1.5">
                      <RefreshCw size={10} /> Refresh
                    </button>
                    <button className="flex-1 py-1.5 bg-[#0b1220] hover:bg-[#1e2a3a] text-slate-300 text-xs font-medium rounded border border-[#1e2a3a] transition-colors flex justify-center items-center gap-1.5">
                      <Eye size={10} /> Catalog
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Other Specs */}
            <div className="flex flex-col gap-2 opacity-60">
              <div className="flex items-center gap-2">
                <div className="h-px flex-1 bg-[#1e2a3a]" />
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                  Valid Evidence
                </span>
                <div className="h-px flex-1 bg-[#1e2a3a]" />
              </div>
              <div className="p-2 border border-[#1e2a3a] rounded-lg text-xs text-slate-400 flex justify-between items-center">
                <span>DensGlass Sheathing</span>
                <span className="text-[9px] text-green-500">ACTIVE</span>
              </div>
              <div className="p-2 border border-[#1e2a3a] rounded-lg text-xs text-slate-400 flex justify-between items-center">
                <span>Wall section WS-12</span>
                <span className="text-[9px] text-amber-500">DRAFT</span>
              </div>
            </div>

          </div>
        </div>
      )}
    </div>
  );
}
