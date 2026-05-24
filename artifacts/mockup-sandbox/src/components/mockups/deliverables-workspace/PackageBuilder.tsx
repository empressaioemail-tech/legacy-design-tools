import React, { useState } from "react";
import {
  Search,
  Filter,
  GripVertical,
  CheckCircle2,
  AlertCircle,
  Clock,
  Sparkles,
  FileText,
  FileBox,
  Layout,
  DoorOpen,
  Box,
  Layers,
  FileCheck2,
  Download,
  Send,
  MoreVertical,
  ChevronDown,
  Plus,
  ArrowRight,
  RefreshCw,
  GitBranch,
  Link,
  MessageSquare
} from "lucide-react";

export function PackageBuilder() {
  const [activeLetter, setActiveLetter] = useState("letter-2");

  return (
    <div className="flex h-[900px] w-[1280px] bg-[#0b1220] text-slate-300 font-sans overflow-hidden">
      {/* LEFT RAIL - Evidence Library */}
      <div className="w-[280px] border-r border-[#1e2a3a] bg-[#0f1729] flex flex-col shrink-0">
        <div className="p-4 border-b border-[#1e2a3a]">
          <h2 className="text-sm font-semibold text-white mb-3">Evidence Library</h2>
          <div className="relative mb-3">
            <Search className="absolute left-2.5 top-2 w-4 h-4 text-slate-500" />
            <input
              type="text"
              placeholder="Search specs, findings..."
              className="w-full bg-[#0b1220] border border-[#1e2a3a] rounded text-xs px-8 py-1.5 text-white placeholder-slate-500 focus:outline-none focus:border-[#5fd0e0]"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {['All', 'Verified', 'Drafts', 'AI', 'Issues'].map(chip => (
              <button key={chip} className="px-2 py-0.5 rounded bg-[#1e2a3a] hover:bg-[#2a3b52] text-[10px] text-slate-300 transition-colors">
                {chip}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-4">
          {/* Product Specs */}
          <div>
            <button className="flex items-center justify-between w-full px-2 py-1 text-xs font-medium text-slate-400 hover:text-white group">
              <span className="flex items-center gap-1.5"><Box className="w-3.5 h-3.5" /> Product Specs (5)</span>
              <div className="flex items-center gap-1">
                <Plus className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                <ChevronDown className="w-3 h-3" />
              </div>
            </button>
            <div className="mt-1 space-y-1">
              <ProductSpecItem name="DensGlass Sheathing" mfg="Georgia-Pacific" id="ESR-1006" status="active" />
              <ProductSpecItem name="Hardie Plank Lap Siding" mfg="James Hardie" id="ESR-2290" status="active" />
              <ProductSpecItem name="TPO Roofing Membrane" mfg="GAF" id="ESR-1659" status="active" />
              <ProductSpecItem name="Old Window Sealant XYZ-200" mfg="AcmeCo" id="ESR-1432" status="withdrawn" issue="Needs swap" />
              <ProductSpecItem name="AI Draft: Tyvek HomeWrap" mfg="DuPont" id="ESR-1993" status="pending" />
            </div>
          </div>

          {/* Detail Callouts */}
          <div>
            <button className="flex items-center justify-between w-full px-2 py-1 text-xs font-medium text-slate-400 hover:text-white group">
              <span className="flex items-center gap-1.5"><Layers className="w-3.5 h-3.5" /> Detail Callouts (5)</span>
              <div className="flex items-center gap-1">
                <Plus className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                <ChevronDown className="w-3 h-3" />
              </div>
            </button>
            <div className="mt-1 space-y-1">
              <CalloutItem type="wall" id="W-A" desc="Exterior 2×6 stud..." status="applied" />
              <CalloutItem type="wall" id="W-B" desc="Interior 2×4 stud..." status="applied" />
              <CalloutItem type="door" id="DS-1" desc="Main entry + corridor..." status="pushed" />
              <CalloutItem type="section" id="WS-12" desc="Footing to parapet..." status="draft" ai />
              <CalloutItem type="room" id="RF-LOBBY" desc="Lobby floor: terrazzo..." status="pending" />
            </div>
          </div>

          {/* Findings & Response Tasks */}
          <div>
            <button className="flex items-center justify-between w-full px-2 py-1 text-xs font-medium text-slate-400 hover:text-white group">
              <span className="flex items-center gap-1.5"><MessageSquare className="w-3.5 h-3.5" /> Findings & Tasks (4)</span>
              <ChevronDown className="w-3 h-3" />
            </button>
            <div className="mt-1 space-y-1">
              <FindingItem id="F-12" desc="Egress width at lobby corridor" rtCount={2} />
              <FindingItem id="F-13" desc="Fire rating at demising wall" rtCount={1} />
              <FindingItem id="F-14" desc="Energy calc discrepancy" rtCount={0} />
              <FindingItem id="F-15" desc="Missing accessibility details" rtCount={2} />
            </div>
          </div>
        </div>
      </div>

      {/* CENTER CANVAS - Letter Editor */}
      <div className="flex-1 flex flex-col min-w-0 bg-[#0b1220] relative">
        {/* Editor Header */}
        <div className="h-16 px-6 border-b border-[#1e2a3a] flex items-center justify-between shrink-0">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-lg font-semibold text-white">Response to Grand County corrections</h1>
              <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-[#f59e0b]/10 text-[#f59e0b] border border-[#f59e0b]/20">DRAFT</span>
            </div>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-slate-500">Letter #2 · Submission #3</span>
              <span className="w-1 h-1 rounded-full bg-slate-700"></span>
              <span className="text-xs text-slate-400">Last edited 1 hr ago by Maria</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#1e2a3a] hover:bg-[#2a3b52] text-xs font-medium text-white transition-colors">
              <FileCheck2 className="w-3.5 h-3.5 text-slate-400" /> Render PDF
            </button>
            <button className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#1e2a3a] hover:bg-[#2a3b52] text-xs font-medium text-white transition-colors">
              <FileText className="w-3.5 h-3.5 text-slate-400" /> Render DOCX
            </button>
            <button className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#22c55e]/10 text-[#22c55e] border border-[#22c55e]/20 text-xs font-medium opacity-50 cursor-not-allowed">
              <Send className="w-3.5 h-3.5" /> Send
            </button>
          </div>
        </div>

        {/* Editor Body */}
        <div className="flex-1 overflow-y-auto custom-scrollbar px-12 py-8">
          <div className="max-w-3xl mx-auto space-y-6 pb-20">
            
            <SectionBlock title="Cover" status="complete" />
            <SectionBlock title="Intro" status="complete" />
            
            <SectionBlock title="Response to F-12" status="complete" />
            
            {/* Expanded Section */}
            <div className="bg-[#0f1729] border border-[#5fd0e0]/30 rounded-lg p-5 shadow-[0_0_15px_rgba(95,208,224,0.05)] relative group transition-all">
              <div className="absolute -left-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 cursor-grab text-slate-500 p-1">
                <GripVertical className="w-4 h-4" />
              </div>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  <MessageSquare className="w-4 h-4 text-slate-400" /> Response to F-13: Fire rating at demising wall
                </h3>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1 px-2 py-0.5 rounded bg-[#22c55e]/10 text-[#22c55e] text-[10px]">
                    <CheckCircle2 className="w-3 h-3" /> All cited items valid
                  </div>
                  <button className="text-slate-500 hover:text-white"><MoreVertical className="w-4 h-4" /></button>
                </div>
              </div>
              
              <div className="text-sm text-slate-300 mb-4 leading-relaxed outline-none" contentEditable suppressContentEditableWarning>
                In response to the plan reviewer's comment regarding the 1-hour fire separation requirement at the demising wall between the lobby and tenant space, we have updated the wall assembly. The wall is now specified as <span className="text-[#5fd0e0] font-medium bg-[#5fd0e0]/10 px-1 rounded">Wall Type W-A</span> which utilizes <span className="text-[#5fd0e0] font-medium bg-[#5fd0e0]/10 px-1 rounded">DensGlass Sheathing</span>. This assembly has been verified to meet the 1-hour requirement per the ICC-ES evaluation report.
              </div>

              <div className="border-t border-[#1e2a3a] pt-4 mt-2">
                <div className="text-xs font-medium text-slate-500 mb-2 flex items-center gap-1.5">
                  <Link className="w-3 h-3" /> Cited Evidence
                </div>
                <div className="flex gap-3">
                  {/* Evidence Chip 1 */}
                  <div className="flex items-center gap-3 p-2 rounded-md border border-[#1e2a3a] bg-[#0b1220] hover:border-[#5fd0e0]/50 transition-colors cursor-pointer w-[240px]">
                    <div className="w-8 h-8 rounded bg-[#1e2a3a] flex items-center justify-center shrink-0">
                      <Layers className="w-4 h-4 text-slate-400" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium text-white truncate">Wall Type W-A</div>
                      <div className="text-[10px] text-slate-500 truncate">Detail Callout Spec</div>
                    </div>
                    <div className="w-1.5 h-1.5 rounded-full bg-[#22c55e]"></div>
                  </div>
                  {/* Evidence Chip 2 */}
                  <div className="flex items-center gap-3 p-2 rounded-md border border-[#1e2a3a] bg-[#0b1220] hover:border-[#5fd0e0]/50 transition-colors cursor-pointer w-[240px]">
                    <div className="w-8 h-8 rounded bg-[#1e2a3a] flex items-center justify-center shrink-0">
                      <Box className="w-4 h-4 text-slate-400" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium text-white truncate">DensGlass Sheathing</div>
                      <div className="text-[10px] text-slate-500 truncate">ESR-1006</div>
                    </div>
                    <div className="w-1.5 h-1.5 rounded-full bg-[#22c55e]"></div>
                  </div>
                </div>
              </div>
            </div>

            {/* Drop Target */}
            <div className="border-2 border-dashed border-[#1e2a3a] hover:border-[#5fd0e0]/50 hover:bg-[#5fd0e0]/5 rounded-lg p-6 flex flex-col items-center justify-center text-center transition-all cursor-pointer group">
              <div className="w-10 h-10 rounded-full bg-[#1e2a3a] group-hover:bg-[#5fd0e0]/20 flex items-center justify-center mb-2 transition-colors">
                <Plus className="w-5 h-5 text-slate-400 group-hover:text-[#5fd0e0]" />
              </div>
              <p className="text-sm font-medium text-slate-300 group-hover:text-white">Add response</p>
              <p className="text-xs text-slate-500 mt-1">Drop a finding or evidence here</p>
            </div>

            <SectionBlock title="Signature" status="complete" />
            
          </div>
        </div>

        {/* AI Helper Pill */}
        <div className="absolute bottom-6 right-6 flex items-center gap-2 px-4 py-2 bg-[#a78bfa]/10 border border-[#a78bfa]/30 rounded-full shadow-lg cursor-pointer hover:bg-[#a78bfa]/20 transition-all">
          <Sparkles className="w-4 h-4 text-[#a78bfa]" />
          <span className="text-xs font-medium text-[#a78bfa]">AI: draft response for F-14?</span>
          <ArrowRight className="w-3.5 h-3.5 text-[#a78bfa]" />
        </div>
      </div>

      {/* RIGHT INSPECTOR - Letter Provenance */}
      <div className="w-[260px] border-l border-[#1e2a3a] bg-[#0f1729] flex flex-col shrink-0">
        <div className="p-4 border-b border-[#1e2a3a]">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <GitBranch className="w-4 h-4 text-[#5fd0e0]" /> Provenance
          </h2>
          <p className="text-xs text-slate-400 mt-1">14 atoms cited in this package</p>
        </div>
        
        <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
          <div className="relative pl-4 space-y-6 before:absolute before:left-[11px] before:top-2 before:bottom-2 before:w-[1px] before:bg-[#1e2a3a]">
            {/* Tree Node 1 */}
            <div className="relative">
              <div className="absolute -left-[21px] top-1.5 w-[9px] h-[1px] bg-[#1e2a3a]"></div>
              <div className="text-xs font-medium text-white mb-2">Response to F-12</div>
              <div className="space-y-1.5 pl-2">
                <AtomLeaf icon={<Layers className="w-3 h-3" />} text="Door Schedule DS-1" />
                <AtomLeaf icon={<Box className="w-3 h-3" />} text="Fire Door Co - ESR-4112" />
              </div>
            </div>
            
            {/* Tree Node 2 */}
            <div className="relative">
              <div className="absolute -left-[21px] top-1.5 w-[9px] h-[1px] bg-[#1e2a3a]"></div>
              <div className="text-xs font-medium text-white mb-2">Response to F-13</div>
              <div className="space-y-1.5 pl-2">
                <AtomLeaf icon={<Layers className="w-3 h-3" />} text="Wall Type W-A" />
                <AtomLeaf icon={<Box className="w-3 h-3" />} text="DensGlass - ESR-1006" />
                <AtomLeaf icon={<Box className="w-3 h-3" />} text="Hardie Lap - ESR-2290" />
              </div>
            </div>

            {/* Tree Node 3 */}
            <div className="relative opacity-50">
              <div className="absolute -left-[21px] top-1.5 w-[9px] h-[1px] bg-[#1e2a3a]"></div>
              <div className="text-xs font-medium text-white mb-2">Response to F-14</div>
              <div className="text-[10px] text-slate-500 italic pl-2">No evidence cited yet</div>
            </div>
          </div>
        </div>

        <div className="p-4 border-t border-[#1e2a3a] bg-[#0b1220]">
          <h3 className="text-xs font-semibold text-slate-300 mb-3">Render History</h3>
          <div className="space-y-2 mb-4">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400 flex items-center gap-1.5"><FileText className="w-3.5 h-3.5" /> DOCX v2</span>
              <span className="text-slate-500">2h ago</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400 flex items-center gap-1.5"><FileCheck2 className="w-3.5 h-3.5" /> PDF v1</span>
              <span className="text-slate-500">Yesterday</span>
            </div>
          </div>
          <button className="w-full py-2 bg-[#5fd0e0] hover:bg-[#4bc0d0] text-[#0b1220] font-medium text-xs rounded transition-colors flex items-center justify-center gap-2">
            <Send className="w-3.5 h-3.5" /> Send to Jurisdiction
          </button>
        </div>
      </div>

      {/* View Navigation Rail - Right Chrome */}
      <div className="w-12 border-l border-[#1e2a3a] bg-[#0f1729] flex flex-col items-center py-4 gap-4 shrink-0">
        <div className="w-8 h-8 rounded bg-[#1e2a3a] flex items-center justify-center cursor-pointer text-white">
          <PackageIcon className="w-4 h-4" />
        </div>
        <div className="w-8 h-8 rounded hover:bg-[#1e2a3a] flex items-center justify-center cursor-pointer text-slate-500 transition-colors">
          <Search className="w-4 h-4" />
        </div>
        <div className="w-8 h-8 rounded hover:bg-[#1e2a3a] flex items-center justify-center cursor-pointer text-slate-500 transition-colors">
          <CheckCircle2 className="w-4 h-4" />
        </div>
      </div>
      
      <style dangerouslySetInnerHTML={{__html: `
        .custom-scrollbar::-webkit-scrollbar { width: 4px; height: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #1e2a3a; border-radius: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #2a3b52; }
      `}} />
    </div>
  );
}

// Components

function ProductSpecItem({ name, mfg, id, status, issue }: { name: string, mfg: string, id: string, status: 'active' | 'withdrawn' | 'pending', issue?: string }) {
  const isWithdrawn = status === 'withdrawn';
  const isPending = status === 'pending';
  
  return (
    <div className={`group flex items-start gap-2 p-2 rounded border cursor-grab hover:bg-[#1e2a3a]/50 transition-colors ${isWithdrawn ? 'border-[#ef4444]/30 bg-[#ef4444]/5' : 'border-transparent'}`}>
      <div className="mt-1 opacity-0 group-hover:opacity-100 text-slate-500 transition-opacity">
        <GripVertical className="w-3 h-3" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${status === 'active' ? 'bg-[#22c55e]' : isWithdrawn ? 'bg-[#ef4444]' : 'bg-[#a78bfa]'}`} />
          <span className={`text-xs font-medium truncate ${isWithdrawn ? 'text-[#ef4444]' : 'text-slate-300'}`}>{name}</span>
        </div>
        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-slate-500">
          <span className="truncate">{mfg}</span>
          <span className="px-1 bg-[#1e2a3a] rounded text-slate-400">{id}</span>
        </div>
        {issue && (
          <div className="mt-1.5 text-[10px] font-medium text-[#ef4444] bg-[#ef4444]/10 px-1.5 py-0.5 rounded w-fit border border-[#ef4444]/20">
            {issue}
          </div>
        )}
      </div>
    </div>
  );
}

function CalloutItem({ type, id, desc, status, ai }: { type: 'wall' | 'door' | 'section' | 'room', id: string, desc: string, status: 'applied' | 'pushed' | 'draft' | 'pending', ai?: boolean }) {
  const icons = {
    wall: <Layers className="w-3 h-3" />,
    door: <DoorOpen className="w-3 h-3" />,
    section: <Layout className="w-3 h-3" />,
    room: <Box className="w-3 h-3" />
  };
  
  return (
    <div className="group flex items-start gap-2 p-2 rounded border border-transparent cursor-grab hover:bg-[#1e2a3a]/50 transition-colors">
      <div className="mt-1 opacity-0 group-hover:opacity-100 text-slate-500 transition-opacity">
        <GripVertical className="w-3 h-3" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-slate-400">{icons[type]}</span>
          <span className="text-xs font-medium text-slate-300 truncate">{id}</span>
          {ai && <Sparkles className="w-2.5 h-2.5 text-[#a78bfa]" />}
        </div>
        <div className="text-[10px] text-slate-500 truncate mt-0.5">{desc}</div>
        <div className="mt-1">
          <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded border uppercase
            ${status === 'applied' ? 'text-[#22c55e] border-[#22c55e]/20 bg-[#22c55e]/10' : 
              status === 'pushed' ? 'text-[#f59e0b] border-[#f59e0b]/20 bg-[#f59e0b]/10' : 
              status === 'draft' ? 'text-slate-400 border-slate-700 bg-slate-800' :
              'text-[#a78bfa] border-[#a78bfa]/20 bg-[#a78bfa]/10'}`}>
            {status}
          </span>
        </div>
      </div>
    </div>
  );
}

function FindingItem({ id, desc, rtCount }: { id: string, desc: string, rtCount: number }) {
  return (
    <div className="group flex items-start gap-2 p-2 rounded border border-transparent cursor-grab hover:bg-[#1e2a3a]/50 transition-colors">
      <div className="mt-1 opacity-0 group-hover:opacity-100 text-slate-500 transition-opacity">
        <GripVertical className="w-3 h-3" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full bg-[#ef4444] shrink-0" />
          <span className="text-xs font-medium text-slate-300 truncate">{id}</span>
          {rtCount > 0 && (
            <span className="text-[9px] text-slate-500 ml-auto flex items-center gap-0.5"><CheckCircle2 className="w-2.5 h-2.5" /> {rtCount} RTs</span>
          )}
        </div>
        <div className="text-[10px] text-slate-400 mt-0.5 leading-snug">{desc}</div>
      </div>
    </div>
  );
}

function SectionBlock({ title, status }: { title: string, status: string }) {
  return (
    <div className="bg-[#0b1220] border border-[#1e2a3a] rounded-lg p-4 hover:border-[#1e2a3a]/80 transition-colors group relative">
      <div className="absolute -left-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 cursor-grab text-slate-500 p-1">
        <GripVertical className="w-4 h-4" />
      </div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-6 h-6 rounded bg-[#1e2a3a] flex items-center justify-center">
            <Layout className="w-3.5 h-3.5 text-slate-400" />
          </div>
          <h3 className="text-sm font-medium text-slate-300 group-hover:text-white transition-colors">{title}</h3>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-500">120 words</span>
          <button className="text-slate-500 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"><MoreVertical className="w-4 h-4" /></button>
        </div>
      </div>
    </div>
  );
}

function AtomLeaf({ icon, text }: { icon: React.ReactNode, text: string }) {
  return (
    <div className="flex items-center gap-2 group cursor-pointer">
      <div className="text-slate-500 group-hover:text-[#5fd0e0] transition-colors">{icon}</div>
      <div className="text-[10px] text-slate-400 group-hover:text-slate-300 truncate transition-colors">{text}</div>
    </div>
  );
}

function PackageIcon(props: any) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
      <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
      <line x1="12" y1="22.08" x2="12" y2="12"></line>
    </svg>
  );
}
