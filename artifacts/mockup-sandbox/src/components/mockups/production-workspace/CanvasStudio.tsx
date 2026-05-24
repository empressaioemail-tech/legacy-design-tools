import React, { useState } from "react";
import {
  Image as ImageIcon,
  Layers,
  LayoutTemplate,
  MonitorPlay,
  Play,
  Settings2,
  Share,
  SlidersHorizontal,
  FileBox,
  FileCheck,
  FileText,
  AlertTriangle,
  CheckCircle2,
  Clock,
  MoreHorizontal,
  ChevronDown,
  ChevronRight,
  Download,
  Plus,
  RefreshCw,
  X,
  CreditCard,
  Maximize2
} from "lucide-react";

type Mode = "Render" | "Compose" | "Publish";

export function CanvasStudio() {
  const [activeMode, setActiveMode] = useState<Mode>("Compose");
  const [selectedSlide, setSelectedSlide] = useState(7);
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null);

  // Render mock data
  const renders = [
    { id: "r1", name: "Hero exterior @ golden hour", status: "complete", type: "4K", time: "18 hr ago", credits: 240, thumb: "bg-gradient-to-br from-amber-500/20 to-blue-900/40" },
    { id: "r2", name: "Lobby interior daylight", status: "complete", type: "4K", time: "14 hr ago", variants: 3, thumb: "bg-gradient-to-br from-slate-200/20 to-slate-600/40" },
    { id: "r3", name: "Site aerial massing study", status: "complete", type: "1080p", time: "12 hr ago", thumb: "bg-gradient-to-br from-emerald-500/20 to-teal-900/40" },
    { id: "r4", name: "Street view sunset", status: "in-progress", progress: 60, eta: "4 min", type: "4K", thumb: "bg-gradient-to-br from-rose-500/10 to-purple-900/20 border border-[#5fd0e0]/30 border-dashed" },
    { id: "r5", name: "Lobby interior nighttime", status: "queued", thumb: "bg-[#0b1220] border border-[#1e2a3a] border-dashed" },
    { id: "r6", name: "Hero exterior twilight", status: "draft", thumb: "bg-[#0b1220] border border-[#1e2a3a] border-dashed" },
  ];

  const slides = Array.from({ length: 14 }).map((_, i) => ({
    id: `s${i + 1}`,
    index: i + 1,
    section: i === 0 ? "Cover" : i <= 3 ? "Site Context" : i <= 7 ? "Findings" : i <= 10 ? "Renders" : i <= 11 ? "Letters" : "Appendix",
    sectionColor: i === 0 ? "bg-purple-500" : i <= 3 ? "bg-blue-500" : i <= 7 ? "bg-amber-500" : i <= 10 ? "bg-[#5fd0e0]" : i <= 11 ? "bg-emerald-500" : "bg-slate-500",
  }));

  const bundleAtoms = [
    { id: "a1", name: "Project Briefing", status: "ready" },
    { id: "a2", name: "Client Letter #2", status: "draft" },
    { id: "a3", name: "Plan Review Findings", status: "blocking", count: 4 },
  ];

  return (
    <div className="flex h-[900px] w-[1280px] bg-[#0b1220] text-slate-300 font-sans overflow-hidden selection:bg-[#5fd0e0]/30">
      {/* GLOBAL LEFT NAV RAIL (Collapsing OS Tabs) */}
      <div className="w-[60px] border-r border-[#1e2a3a] bg-[#0f1729] flex flex-col items-center py-4 z-50">
        <div className="w-8 h-8 rounded bg-gradient-to-br from-[#5fd0e0] to-blue-600 mb-8 shadow-[0_0_15px_rgba(95,208,224,0.3)]"></div>
        <div className="flex flex-col gap-6 flex-1 w-full items-center">
          <div className="w-10 h-10 flex items-center justify-center text-slate-500 hover:text-slate-300 rounded-lg cursor-pointer transition-colors"><FileBox size={20} /></div>
          <div className="w-10 h-10 flex items-center justify-center text-slate-500 hover:text-slate-300 rounded-lg cursor-pointer transition-colors"><CheckCircle2 size={20} /></div>
          <div className="w-10 h-10 flex items-center justify-center bg-[#5fd0e0]/10 text-[#5fd0e0] rounded-lg cursor-pointer border border-[#5fd0e0]/20 shadow-[inset_0_0_10px_rgba(95,208,224,0.1)] relative">
            <LayoutTemplate size={20} />
            <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 bg-[#5fd0e0] rounded-r"></div>
          </div>
        </div>
        <div className="w-10 h-10 flex items-center justify-center text-slate-500 hover:text-slate-300 rounded-lg cursor-pointer mt-auto"><Settings2 size={20} /></div>
      </div>

      {/* ASSET PALETTE (LEFT) */}
      <div className="w-[260px] border-r border-[#1e2a3a] bg-[#0b1220] flex flex-col z-40">
        <div className="p-4 border-b border-[#1e2a3a]">
          <h2 className="text-sm font-medium text-slate-200 tracking-wide uppercase">Assets</h2>
          <div className="flex gap-2 mt-3 overflow-x-auto pb-1 scrollbar-hide">
            <span className="px-2 py-1 text-[10px] uppercase font-medium tracking-wider bg-[#5fd0e0]/20 text-[#5fd0e0] border border-[#5fd0e0]/30 rounded cursor-pointer whitespace-nowrap">All</span>
            <span className="px-2 py-1 text-[10px] uppercase font-medium tracking-wider bg-[#1e2a3a] text-slate-400 border border-transparent hover:border-[#1e2a3a] rounded cursor-pointer whitespace-nowrap">Ready</span>
            <span className="px-2 py-1 text-[10px] uppercase font-medium tracking-wider bg-[#1e2a3a] text-slate-400 border border-transparent hover:border-[#1e2a3a] rounded cursor-pointer whitespace-nowrap">In Progress</span>
            <span className="px-2 py-1 text-[10px] uppercase font-medium tracking-wider bg-[#1e2a3a] text-slate-400 border border-transparent hover:border-[#1e2a3a] rounded cursor-pointer whitespace-nowrap">Draft</span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-6 custom-scrollbar">
          {/* Renders Section */}
          <div>
            <div className="flex items-center justify-between text-xs font-medium text-slate-400 mb-3 px-1 cursor-pointer hover:text-slate-200">
              <div className="flex items-center gap-1.5"><ChevronDown size={14} /> Renders (6)</div>
              <Plus size={14} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              {renders.map(r => (
                <div key={r.id} className="group relative cursor-pointer" onClick={() => setSelectedAsset(r.id)}>
                  <div className={`aspect-[4/3] rounded border ${r.status === 'in-progress' ? 'border-[#5fd0e0]' : selectedAsset === r.id ? 'border-[#5fd0e0] ring-1 ring-[#5fd0e0]' : 'border-[#1e2a3a] hover:border-slate-600'} ${r.thumb} relative overflow-hidden transition-all`}>
                    {/* Fake building silhouette */}
                    {(r.status === 'complete' || r.status === 'in-progress') && (
                       <div className="absolute inset-x-2 bottom-0 h-1/2 bg-black/40 blur-[1px]" style={{ clipPath: 'polygon(0% 100%, 0% 60%, 20% 60%, 20% 40%, 40% 40%, 40% 20%, 60% 20%, 60% 50%, 80% 50%, 80% 70%, 100% 70%, 100% 100%)' }}></div>
                    )}
                    
                    {r.status === 'in-progress' && (
                      <div className="absolute inset-0 bg-[#0b1220]/60 flex flex-col items-center justify-center p-2 backdrop-blur-[1px]">
                        <div className="w-full h-1 bg-[#1e2a3a] rounded-full overflow-hidden mb-1">
                          <div className="h-full bg-[#5fd0e0]" style={{ width: `${r.progress}%` }}></div>
                        </div>
                        <span className="text-[9px] text-[#5fd0e0] font-mono">{r.eta}</span>
                      </div>
                    )}
                    {r.status === 'complete' && (
                      <div className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-[#22c55e]"></div>
                    )}
                    {r.variants && (
                      <div className="absolute bottom-1 right-1 px-1 py-0.5 bg-black/60 rounded text-[8px] text-slate-300 font-mono">+{r.variants}</div>
                    )}
                  </div>
                  <div className="mt-1.5 text-[10px] text-slate-400 leading-tight truncate px-0.5 group-hover:text-slate-200">{r.name}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Slides Section */}
          <div>
            <div className="flex items-center justify-between text-xs font-medium text-slate-400 mb-3 px-1 cursor-pointer hover:text-slate-200">
              <div className="flex items-center gap-1.5"><ChevronDown size={14} /> Slides (14)</div>
            </div>
            <div className="flex flex-col gap-1">
              {slides.map(s => (
                <div key={s.id} className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer ${selectedSlide === s.index ? 'bg-[#1e2a3a] text-slate-200' : 'hover:bg-[#1e2a3a]/50 text-slate-400'}`} onClick={() => setSelectedSlide(s.index)}>
                  <div className={`w-1.5 h-1.5 rounded-full ${s.sectionColor}`}></div>
                  <span className="text-[10px] w-4 text-slate-500 font-mono">{s.index}</span>
                  <div className="w-6 h-4 bg-slate-800 rounded flex-shrink-0 border border-slate-700"></div>
                  <span className="text-xs truncate">{s.section} Slide</span>
                </div>
              ))}
            </div>
          </div>

          {/* Atoms Section */}
          <div>
            <div className="flex items-center justify-between text-xs font-medium text-slate-400 mb-3 px-1 cursor-pointer hover:text-slate-200">
              <div className="flex items-center gap-1.5"><ChevronDown size={14} /> Bundle Atoms</div>
            </div>
            <div className="flex flex-col gap-1.5">
              {bundleAtoms.map(a => (
                <div key={a.id} className="flex items-center justify-between px-2 py-1.5 bg-[#0f1729] border border-[#1e2a3a] rounded hover:border-slate-600 cursor-pointer">
                  <div className="flex items-center gap-2 overflow-hidden">
                    {a.status === 'ready' && <FileCheck size={12} className="text-[#22c55e] flex-shrink-0" />}
                    {a.status === 'draft' && <FileText size={12} className="text-[#f59e0b] flex-shrink-0" />}
                    {a.status === 'blocking' && <AlertTriangle size={12} className="text-[#ef4444] flex-shrink-0" />}
                    <span className="text-[10px] text-slate-300 truncate">{a.name}</span>
                  </div>
                  {a.count && <span className="text-[9px] bg-[#ef4444]/20 text-[#ef4444] px-1 rounded font-mono">{a.count}</span>}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Bottom Credits */}
        <div className="p-4 border-t border-[#1e2a3a] bg-[#0f1729]">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] text-slate-400 uppercase tracking-wider font-medium flex items-center gap-1"><CreditCard size={12} /> Render Credits</span>
            <span className="text-xs font-mono text-[#5fd0e0]">1,240 <span className="text-slate-500">/ 2,000</span></span>
          </div>
          <div className="w-full h-1.5 bg-[#1e2a3a] rounded-full overflow-hidden mb-2">
            <div className="h-full bg-gradient-to-r from-blue-600 to-[#5fd0e0]" style={{ width: '62%' }}></div>
          </div>
          <button className="text-[10px] text-slate-400 hover:text-slate-200 transition-colors">Buy credits &rarr;</button>
        </div>
      </div>

      {/* MAIN CANVAS AREA */}
      <div className="flex-1 flex flex-col relative bg-[#0b1220] z-30">
        {/* Rulers / Guides Background */}
        <div className="absolute inset-0 pointer-events-none opacity-20" 
             style={{ 
               backgroundImage: 'linear-gradient(to right, #1e2a3a 1px, transparent 1px), linear-gradient(to bottom, #1e2a3a 1px, transparent 1px)', 
               backgroundSize: '100px 100px',
               backgroundPosition: 'center center'
             }}>
        </div>
        <div className="absolute top-0 left-0 right-0 h-4 border-b border-[#1e2a3a] bg-[#0b1220]/80 backdrop-blur pointer-events-none flex text-[8px] text-slate-600 px-4 items-end overflow-hidden">
          <span className="w-[100px]">0</span><span className="w-[100px]">100</span><span className="w-[100px]">200</span><span className="w-[100px]">300</span><span className="w-[100px]">400</span><span className="w-[100px]">500</span><span className="w-[100px]">600</span><span className="w-[100px]">700</span>
        </div>
        <div className="absolute top-0 left-0 bottom-0 w-4 border-r border-[#1e2a3a] bg-[#0b1220]/80 backdrop-blur pointer-events-none flex flex-col text-[8px] text-slate-600 py-4 items-start overflow-hidden pt-6">
          <span className="h-[100px]">0</span><span className="h-[100px]">-100</span><span className="h-[100px]">-200</span><span className="h-[100px]">-300</span><span className="h-[100px]">-400</span><span className="h-[100px]">-500</span>
        </div>

        {/* TOP BAR / MODE SWITCHER */}
        <div className="h-14 flex items-center justify-center relative z-40 mt-4">
          <div className="bg-[#0f1729] border border-[#1e2a3a] rounded-full p-1 flex items-center gap-1 shadow-lg">
            <button 
              className={`flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-medium transition-all ${activeMode === 'Render' ? 'bg-[#1e2a3a] text-slate-200' : 'text-slate-500 hover:text-slate-300'}`}
              onClick={() => setActiveMode('Render')}
            >
              <ImageIcon size={14} /> Render
            </button>
            <button 
              className={`flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-medium transition-all ${activeMode === 'Compose' ? 'bg-[#5fd0e0]/20 text-[#5fd0e0] shadow-[0_0_10px_rgba(95,208,224,0.15)] border border-[#5fd0e0]/30' : 'text-slate-500 hover:text-slate-300'}`}
              onClick={() => setActiveMode('Compose')}
            >
              <LayoutTemplate size={14} /> Compose
            </button>
            <button 
              className={`flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-medium transition-all ${activeMode === 'Publish' ? 'bg-[#1e2a3a] text-slate-200' : 'text-slate-500 hover:text-slate-300'}`}
              onClick={() => setActiveMode('Publish')}
            >
              <Share size={14} /> Publish
            </button>
          </div>
          
          <div className="absolute right-4 top-1 flex items-center gap-2">
            <div className="flex items-center gap-1 bg-[#0f1729] border border-[#1e2a3a] rounded px-3 py-1.5 cursor-pointer hover:border-slate-600 transition-colors">
              <span className="text-[10px] text-slate-400 font-medium">v3 (Draft)</span>
              <ChevronDown size={12} className="text-slate-500" />
            </div>
            <button className="flex items-center gap-1.5 bg-[#0f1729] border border-[#1e2a3a] rounded px-3 py-1.5 text-xs text-slate-300 hover:text-slate-100 hover:bg-[#1e2a3a] transition-colors">
              <RefreshCw size={12} /> Regenerate
            </button>
            <button className="flex items-center gap-1.5 bg-[#0f1729] border border-[#1e2a3a] rounded px-3 py-1.5 text-xs text-slate-300 hover:text-slate-100 hover:bg-[#1e2a3a] transition-colors">
              <MonitorPlay size={12} /> Present
            </button>
            <button className="flex items-center gap-1.5 bg-slate-200 text-slate-900 rounded px-3 py-1.5 text-xs font-medium hover:bg-white transition-colors">
              <Download size={12} /> PDF
            </button>
          </div>
        </div>

        {/* CANVAS WORKSPACE (Compose Mode) */}
        <div className="flex-1 flex items-center justify-center p-12 relative z-30">
          {/* Active Slide Rendering */}
          <div className="w-[800px] aspect-[16/9] bg-slate-900 shadow-2xl relative flex flex-col overflow-hidden ring-1 ring-[#1e2a3a] group">
            {/* Slide Content Mock */}
            <div className="absolute inset-0 bg-gradient-to-br from-amber-500/20 to-blue-900/40">
              <div className="absolute inset-0 bg-black/20"></div>
              {/* Fake building silhouette */}
              <div className="absolute inset-x-0 bottom-0 h-[60%] bg-black/50 blur-[2px]" style={{ clipPath: 'polygon(0% 100%, 0% 70%, 10% 70%, 10% 50%, 25% 50%, 25% 30%, 40% 30%, 40% 50%, 65% 50%, 65% 60%, 80% 60%, 80% 80%, 100% 80%, 100% 100%)' }}></div>
            </div>
            <div className="relative z-10 p-10 flex flex-col h-full">
              <div className="flex items-start justify-between">
                <div>
                  <h1 className="text-4xl font-light text-white tracking-tight drop-shadow-md">Northwest Perspective</h1>
                  <p className="text-lg text-white/80 mt-2 font-light drop-shadow">Golden hour visualization of the main entry plaza</p>
                </div>
                <div className="text-white/60 font-mono text-sm drop-shadow">07</div>
              </div>
              <div className="mt-auto">
                <div className="bg-black/40 backdrop-blur-md border border-white/10 p-6 rounded-lg max-w-lg">
                  <h3 className="text-white text-sm font-medium uppercase tracking-wider mb-2">Key Finding Resolution</h3>
                  <p className="text-white/70 text-sm leading-relaxed">The setback along the western edge has been increased to 25ft to accommodate the required fire access lane, addressing Finding #A-42.</p>
                </div>
              </div>
            </div>
            
            {/* Canvas overlay controls (appear on hover) */}
            <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity flex gap-2">
              <button className="bg-black/50 backdrop-blur hover:bg-black/70 text-white p-2 rounded"><Maximize2 size={16} /></button>
            </div>
            
            {/* Outline selection indicator */}
            <div className="absolute inset-0 border-2 border-[#5fd0e0]/0 group-hover:border-[#5fd0e0]/50 pointer-events-none transition-colors">
              <div className="absolute top-0 left-0 w-2 h-2 border-t-2 border-l-2 border-[#5fd0e0]"></div>
              <div className="absolute top-0 right-0 w-2 h-2 border-t-2 border-r-2 border-[#5fd0e0]"></div>
              <div className="absolute bottom-0 left-0 w-2 h-2 border-b-2 border-l-2 border-[#5fd0e0]"></div>
              <div className="absolute bottom-0 right-0 w-2 h-2 border-b-2 border-r-2 border-[#5fd0e0]"></div>
            </div>
          </div>
        </div>

        {/* TIMELINE STRIP (Bottom) */}
        <div className="h-[120px] bg-[#0f1729] border-t border-[#1e2a3a] relative z-40 flex flex-col shadow-[0_-10px_30px_rgba(0,0,0,0.5)]">
          <div className="h-6 border-b border-[#1e2a3a] bg-[#0b1220] flex items-center px-4 justify-between">
            <div className="flex items-center gap-4 text-[10px] text-slate-500 font-mono uppercase tracking-wider">
              <span>Deck Assembly</span>
              <span className="text-slate-400">14 Slides</span>
              <span>12:00</span>
            </div>
            <div className="flex gap-2">
              <div className="w-2 h-2 rounded-full bg-purple-500" title="Cover"></div>
              <div className="w-2 h-2 rounded-full bg-blue-500" title="Context"></div>
              <div className="w-2 h-2 rounded-full bg-amber-500" title="Findings"></div>
              <div className="w-2 h-2 rounded-full bg-[#5fd0e0]" title="Renders"></div>
              <div className="w-2 h-2 rounded-full bg-emerald-500" title="Letters"></div>
            </div>
          </div>
          
          <div className="flex-1 overflow-x-auto flex items-center px-4 gap-1 relative scrollbar-hide">
            {/* Playhead line */}
            <div className="absolute top-0 bottom-0 w-0.5 bg-[#5fd0e0] z-20 pointer-events-none shadow-[0_0_10px_#5fd0e0]" style={{ left: `${4 * 16 + (selectedSlide - 1) * 88 + 44}px` }}>
              <div className="absolute -top-2 -translate-x-1/2 w-3 h-3 bg-[#5fd0e0] rotate-45"></div>
            </div>

            {slides.map((s, i) => (
              <React.Fragment key={s.id}>
                {/* Slide Card */}
                <div 
                  className={`relative flex-shrink-0 w-20 h-14 rounded overflow-hidden cursor-pointer border-2 transition-all ${selectedSlide === s.index ? 'border-[#5fd0e0] ring-2 ring-[#5fd0e0]/20 z-10' : 'border-[#1e2a3a] hover:border-slate-500'}`}
                  onClick={() => setSelectedSlide(s.index)}
                >
                  <div className={`h-1.5 w-full ${s.sectionColor}`}></div>
                  <div className={`bg-slate-800 h-full p-1 flex items-end ${s.index === 7 ? 'bg-gradient-to-br from-amber-500/20 to-blue-900/40' : ''}`}>
                    <span className="text-[9px] font-mono text-white/50">{s.index}</span>
                  </div>
                </div>
                {/* Insert gap */}
                {i < slides.length - 1 && (
                  <div className="w-4 h-full flex items-center justify-center opacity-0 hover:opacity-100 cursor-pointer group flex-shrink-0">
                    <div className="w-0.5 h-8 bg-slate-700 group-hover:bg-[#5fd0e0] transition-colors relative flex items-center justify-center">
                      <div className="absolute w-3 h-3 bg-slate-800 rounded-full border border-slate-600 group-hover:border-[#5fd0e0] flex items-center justify-center text-[#5fd0e0]">
                        <Plus size={8} />
                      </div>
                    </div>
                  </div>
                )}
              </React.Fragment>
            ))}
          </div>
        </div>

        {/* Floating Publish Hand-off */}
        <div className="absolute bottom-[140px] right-4 bg-[#0f1729] border border-[#ef4444]/40 shadow-xl rounded-full px-4 py-2 flex items-center gap-3 cursor-pointer hover:bg-[#1e2a3a] transition-colors z-40 group">
          <div className="flex -space-x-1">
            <div className="w-5 h-5 rounded-full border border-[#0f1729] bg-[#22c55e] flex items-center justify-center text-white"><CheckCircle2 size={10} /></div>
            <div className="w-5 h-5 rounded-full border border-[#0f1729] bg-[#ef4444] flex items-center justify-center text-white"><AlertTriangle size={10} /></div>
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] uppercase font-semibold text-slate-300 tracking-wider">Publish Prep</span>
            <span className="text-[10px] text-[#ef4444]">70% ready · 3 blockers</span>
          </div>
          <ChevronRight size={14} className="text-slate-500 group-hover:text-slate-300 transform group-hover:translate-x-1 transition-all" />
        </div>
      </div>

      {/* INSPECTOR (RIGHT) */}
      <div className="w-[300px] border-l border-[#1e2a3a] bg-[#0b1220] flex flex-col z-40 relative">
        <div className="h-14 border-b border-[#1e2a3a] flex items-center px-4 shrink-0 bg-[#0f1729]">
          <h2 className="text-sm font-medium text-slate-200">Slide Properties</h2>
        </div>
        
        <div className="flex-1 overflow-y-auto p-5 custom-scrollbar">
          {/* Active section indicator */}
          <div className="flex items-center gap-2 mb-6">
            <div className="w-3 h-3 rounded-sm bg-[#5fd0e0]"></div>
            <span className="text-xs text-slate-300 font-medium">Renders Section</span>
            <span className="text-[10px] text-slate-500 ml-auto bg-[#1e2a3a] px-2 py-0.5 rounded">Slide 7 of 14</span>
          </div>

          <div className="space-y-6">
            {/* Layout Picker */}
            <div>
              <label className="text-[10px] uppercase text-slate-500 font-semibold tracking-wider mb-2 block">Layout Template</label>
              <div className="grid grid-cols-3 gap-2">
                <div className="aspect-[4/3] rounded border border-[#5fd0e0] bg-[#5fd0e0]/10 flex flex-col p-1.5 cursor-pointer">
                  <div className="w-full h-1/2 bg-[#5fd0e0]/20 rounded-sm mb-1"></div>
                  <div className="w-2/3 h-1 bg-[#5fd0e0]/40 rounded-full mb-0.5"></div>
                  <div className="w-1/2 h-1 bg-[#5fd0e0]/40 rounded-full"></div>
                </div>
                <div className="aspect-[4/3] rounded border border-[#1e2a3a] bg-[#0f1729] hover:border-slate-600 flex p-1.5 gap-1 cursor-pointer">
                  <div className="w-1/2 h-full bg-slate-800 rounded-sm"></div>
                  <div className="w-1/2 flex flex-col justify-center">
                    <div className="w-full h-1 bg-slate-700 rounded-full mb-1"></div>
                    <div className="w-2/3 h-1 bg-slate-700 rounded-full"></div>
                  </div>
                </div>
                <div className="aspect-[4/3] rounded border border-[#1e2a3a] bg-[#0f1729] hover:border-slate-600 flex flex-col items-center justify-center p-1.5 cursor-pointer">
                  <div className="w-full h-full bg-slate-800 rounded-sm"></div>
                </div>
              </div>
            </div>

            {/* Source Atoms */}
            <div>
              <label className="text-[10px] uppercase text-slate-500 font-semibold tracking-wider mb-2 flex items-center justify-between">
                <span>Source Atoms</span>
                <span className="text-[#5fd0e0] cursor-pointer hover:underline">+ Add</span>
              </label>
              <div className="bg-[#0f1729] border border-[#1e2a3a] rounded-lg p-2 flex flex-col gap-2">
                <div className="flex gap-3">
                  <div className="w-16 h-12 bg-gradient-to-br from-amber-500/20 to-blue-900/40 rounded border border-[#1e2a3a]"></div>
                  <div className="flex flex-col justify-center overflow-hidden">
                    <span className="text-xs text-slate-200 truncate">Hero exterior @ golden hour</span>
                    <span className="text-[10px] text-[#22c55e] flex items-center gap-1 mt-0.5"><Clock size={10} /> Updated 18h ago</span>
                  </div>
                </div>
                <div className="flex gap-3 pt-2 border-t border-[#1e2a3a]">
                  <div className="w-16 h-12 bg-slate-800 rounded border border-[#1e2a3a] flex items-center justify-center text-slate-600">
                    <AlertTriangle size={14} className="text-amber-500/50" />
                  </div>
                  <div className="flex flex-col justify-center overflow-hidden">
                    <span className="text-xs text-slate-200 truncate">Finding #A-42</span>
                    <span className="text-[10px] text-amber-500 flex items-center gap-1 mt-0.5"><RefreshCw size={10} /> Status changed</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Editable Content */}
            <div>
              <label className="text-[10px] uppercase text-slate-500 font-semibold tracking-wider mb-2 block">Slide Heading</label>
              <input type="text" className="w-full bg-[#0f1729] border border-[#1e2a3a] rounded p-2 text-sm text-slate-200 focus:outline-none focus:border-[#5fd0e0] transition-colors" defaultValue="Northwest Perspective" />
            </div>

            <div>
              <label className="text-[10px] uppercase text-slate-500 font-semibold tracking-wider mb-2 block">Caption / Notes</label>
              <textarea className="w-full bg-[#0f1729] border border-[#1e2a3a] rounded p-2 text-sm text-slate-200 focus:outline-none focus:border-[#5fd0e0] transition-colors h-24 resize-none" defaultValue="Golden hour visualization of the main entry plaza. The setback along the western edge has been increased to 25ft to accommodate the required fire access lane, addressing Finding #A-42."></textarea>
            </div>

            {/* Settings Toggles */}
            <div className="space-y-3 pt-4 border-t border-[#1e2a3a]">
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-300">Include in exported deck</span>
                <div className="w-8 h-4 bg-[#5fd0e0] rounded-full relative cursor-pointer shadow-[0_0_10px_rgba(95,208,224,0.2)]">
                  <div className="absolute right-0.5 top-0.5 w-3 h-3 bg-white rounded-full"></div>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-300">Show page numbers</span>
                <div className="w-8 h-4 bg-[#5fd0e0] rounded-full relative cursor-pointer shadow-[0_0_10px_rgba(95,208,224,0.2)]">
                  <div className="absolute right-0.5 top-0.5 w-3 h-3 bg-white rounded-full"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
