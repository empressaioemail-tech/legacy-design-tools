import React, { useState } from "react";
import { 
  ChevronRight, 
  CheckCircle2, 
  Image as ImageIcon, 
  Layers, 
  LayoutTemplate, 
  FileText, 
  Lock, 
  AlertCircle,
  GripVertical,
  Plus,
  RefreshCw,
  Download,
  ChevronDown,
  Play,
  ArrowRight,
  Eye,
  History,
  Share2,
  Cpu,
  Settings,
  XSquare,
  Star,
  Upload,
  UploadCloud,
  CheckSquare,
  Square
} from "lucide-react";

export function StagePipeline() {
  const [activeStage, setActiveStage] = useState("assemble");
  const [activeSlide, setActiveSlide] = useState("render-1");
  const [checklist, setChecklist] = useState({
    metadata: true,
    briefing: true,
    planReview: true,
    findings: false,
    letterDrafted: true,
    letterSent: false,
    renders: true,
    legacyPlan: true,
    architectSignoff: false
  });

  return (
    <div className="flex flex-col h-[900px] w-[1280px] bg-[#0b1220] text-slate-300 font-sans overflow-hidden border border-[#1e2a3a] shadow-2xl relative select-none">
      
      {/* Top Stage Rail */}
      <div className="h-[90px] shrink-0 border-b border-[#1e2a3a] bg-[#0f1729] flex items-stretch">
        
        {/* Stage 1: Visualize */}
        <div 
          className={`flex-1 relative group cursor-pointer transition-colors hover:bg-[#1a2436] flex items-center px-6 border-r border-[#1e2a3a]/50 ${activeStage === "visualize" ? "bg-[#1a2436] ring-1 ring-inset ring-[#5fd0e0]/30 shadow-[inset_0_0_20px_rgba(95,208,224,0.05)]" : ""}`}
          onClick={() => setActiveStage("visualize")}
        >
          {activeStage === "visualize" && (
            <div className="absolute top-0 left-0 w-full h-0.5 bg-[#5fd0e0] shadow-[0_0_8px_#5fd0e0]" />
          )}
          <div className="flex flex-col gap-1.5 w-full">
            <div className="flex items-center gap-2">
              <CheckCircle2 className={`w-4 h-4 ${activeStage === "visualize" ? "text-[#5fd0e0]" : "text-[#22c55e]"}`} />
              <span className={`text-sm font-semibold tracking-wide ${activeStage === "visualize" ? "text-[#5fd0e0]" : "text-slate-200"}`}>1. VISUALIZE</span>
            </div>
            <div className="text-xs text-slate-400">3 of 6 renders ready &middot; 1 in progress &middot; 1 queued &middot; 1 draft</div>
            <div className="flex gap-1 mt-0.5">
              <div className="w-8 h-4 rounded bg-gradient-to-tr from-slate-800 to-slate-700 overflow-hidden relative">
                <div className="absolute inset-0 bg-emerald-500/20" />
              </div>
              <div className="w-8 h-4 rounded bg-gradient-to-tr from-slate-800 to-slate-700 overflow-hidden relative">
                <div className="absolute inset-0 bg-emerald-500/20" />
              </div>
              <div className="w-8 h-4 rounded bg-gradient-to-tr from-slate-800 to-slate-700 overflow-hidden relative">
                <div className="absolute inset-0 bg-[#5fd0e0]/20 border-b-2 border-[#5fd0e0]" />
              </div>
            </div>
          </div>
          <ChevronRight className="absolute right-[-12px] top-1/2 -translate-y-1/2 w-6 h-6 text-[#1e2a3a] z-10 drop-shadow-md" />
        </div>

        {/* Stage 2: Assemble */}
        <div 
          className={`flex-1 relative group cursor-pointer transition-colors hover:bg-[#1a2436] flex items-center px-8 border-r border-[#1e2a3a]/50 ${activeStage === "assemble" ? "bg-[#1a2436] ring-1 ring-inset ring-[#5fd0e0]/30 shadow-[inset_0_0_20px_rgba(95,208,224,0.05)]" : ""}`}
          onClick={() => setActiveStage("assemble")}
        >
          {activeStage === "assemble" && (
            <div className="absolute top-0 left-0 w-full h-0.5 bg-[#5fd0e0] shadow-[0_0_8px_#5fd0e0]" />
          )}
          <div className="flex flex-col gap-1.5 w-full">
            <div className="flex items-center gap-2">
              <Layers className={`w-4 h-4 ${activeStage === "assemble" ? "text-[#5fd0e0]" : "text-slate-400"}`} />
              <span className={`text-sm font-semibold tracking-wide ${activeStage === "assemble" ? "text-[#5fd0e0]" : "text-slate-200"}`}>2. ASSEMBLE</span>
            </div>
            <div className="text-xs text-slate-400">Deck v3 &middot; 14 slides &middot; <span className="text-[#f59e0b]">DRAFT</span> &middot; 6 sections complete</div>
            <div className="flex gap-1 mt-1">
              <div className="h-1 w-full bg-[#1e2a3a] rounded-full overflow-hidden flex">
                <div className="h-full bg-[#22c55e] w-[60%]" />
                <div className="h-full bg-[#f59e0b] w-[40%]" />
              </div>
            </div>
          </div>
          <ChevronRight className="absolute right-[-12px] top-1/2 -translate-y-1/2 w-6 h-6 text-[#1e2a3a] z-10 drop-shadow-md" />
        </div>

        {/* Stage 3: Publish */}
        <div 
          className={`flex-1 relative group cursor-pointer transition-colors hover:bg-[#1a2436] flex items-center px-8 opacity-80 ${activeStage === "publish" ? "bg-[#1a2436] ring-1 ring-inset ring-[#5fd0e0]/30 shadow-[inset_0_0_20px_rgba(95,208,224,0.05)] opacity-100" : ""}`}
          onClick={() => setActiveStage("publish")}
        >
          {activeStage === "publish" && (
            <div className="absolute top-0 left-0 w-full h-0.5 bg-[#5fd0e0] shadow-[0_0_8px_#5fd0e0]" />
          )}
          <div className="flex flex-col gap-1.5 w-full">
            <div className="flex items-center gap-2">
              <Lock className={`w-4 h-4 ${activeStage === "publish" ? "text-[#5fd0e0]" : "text-slate-500"}`} />
              <span className={`text-sm font-semibold tracking-wide ${activeStage === "publish" ? "text-[#5fd0e0]" : "text-slate-400"}`}>3. PUBLISH</span>
            </div>
            <div className="text-xs text-slate-400">70% ready &middot; <span className="text-[#ef4444]">3 blocking items</span></div>
            <div className="flex gap-1 mt-1">
              <div className="h-1 w-full bg-[#1e2a3a] rounded-full overflow-hidden flex">
                <div className="h-full bg-slate-500 w-[70%]" />
                <div className="h-full bg-[#ef4444] w-[30%]" />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        
        {/* RIGHT RAIL for "VIEWS" Nav Collapse */}
        <div className="w-[60px] border-r border-[#1e2a3a] bg-[#0b1220] flex flex-col items-center py-4 gap-6 shrink-0 z-20 shadow-[4px_0_10px_rgba(0,0,0,0.2)]">
           <div className="w-10 h-10 rounded-lg bg-[#1e2a3a] flex items-center justify-center text-slate-400 hover:text-slate-200 cursor-pointer">
              <Layers className="w-5 h-5" />
           </div>
           <div className="w-10 h-10 rounded-lg bg-[#5fd0e0]/10 border border-[#5fd0e0]/30 flex items-center justify-center text-[#5fd0e0] cursor-pointer">
              <Cpu className="w-5 h-5" />
           </div>
        </div>

        {/* MAIN CANVAS */}
        <div className="flex-1 flex flex-col min-w-0 bg-[#0b1220]">
          
          {activeStage === "visualize" && (
            <>
              {/* Action Bar */}
              <div className="h-[60px] border-b border-[#1e2a3a] flex items-center justify-between px-6 shrink-0 bg-[#0b1220]">
                <div className="flex items-center gap-4">
                  <div className="text-lg font-medium text-slate-200">Design Tools</div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-xs font-medium text-slate-400 bg-[#1e2a3a] px-3 py-1.5 rounded-full border border-slate-700">
                    <span className="text-[#5fd0e0]">1,240</span> / 2,000 credits
                  </div>
                  <button className="flex items-center gap-2 px-3 py-1.5 rounded bg-[#1e2a3a] hover:bg-[#253447] text-xs font-medium text-slate-300 transition-colors">
                    <Settings className="w-3.5 h-3.5" />
                    Configure Render
                  </button>
                  <button className="flex items-center gap-2 px-4 py-1.5 rounded bg-[#5fd0e0]/10 hover:bg-[#5fd0e0]/20 text-[#5fd0e0] border border-[#5fd0e0]/30 text-xs font-medium transition-colors">
                    <Play className="w-3.5 h-3.5" />
                    Kick off render
                  </button>
                </div>
              </div>
              <div className="flex-1 flex p-6 gap-6 overflow-y-auto custom-scrollbar relative">
                {/* Constellation background */}
                <div className="absolute inset-0 opacity-20 pointer-events-none" style={{ backgroundImage: 'radial-gradient(circle at center, #5fd0e0 1px, transparent 1px)', backgroundSize: '40px 40px' }} />
                
                <div className="grid grid-cols-3 gap-6 w-full auto-rows-max relative z-10">
                  {/* Hero exterior */}
                  <div className="bg-[#0f1729] border border-[#22c55e]/50 rounded-lg overflow-hidden group">
                    <div className="aspect-[16/9] relative bg-slate-800">
                       <div className="absolute inset-0 bg-gradient-to-tr from-[#0b1220] to-slate-700" />
                       <div className="absolute inset-0 bg-black/10 group-hover:bg-black/0 transition-colors" />
                    </div>
                    <div className="p-4">
                      <div className="flex justify-between items-start mb-2">
                        <div className="font-medium text-sm text-slate-200">Hero exterior @ golden hour</div>
                        <CheckCircle2 className="w-4 h-4 text-[#22c55e]" />
                      </div>
                      <div className="text-xs text-slate-500 flex gap-2">
                         <span>4K</span> &middot; <span>mnml.ai</span> &middot; <span>240 cr</span> &middot; <span>18hr ago</span>
                      </div>
                      <div className="mt-4 flex gap-2">
                        <button className="flex-1 py-1.5 bg-[#1e2a3a] rounded text-xs hover:bg-slate-700 transition-colors flex items-center justify-center gap-1"><Star className="w-3 h-3 text-[#f59e0b]" /> Preferred</button>
                        <button className="px-3 py-1.5 bg-[#1e2a3a] rounded text-xs hover:bg-slate-700 transition-colors"><Settings className="w-3 h-3" /></button>
                      </div>
                    </div>
                  </div>

                  {/* Lobby interior */}
                  <div className="bg-[#0f1729] border border-[#22c55e]/50 rounded-lg overflow-hidden group">
                    <div className="aspect-[16/9] relative bg-slate-800">
                       <div className="absolute inset-0 bg-gradient-to-br from-slate-800 to-slate-600" />
                       <div className="absolute bottom-2 right-2 bg-black/60 px-2 py-0.5 rounded text-[10px] text-white">3 variants</div>
                    </div>
                    <div className="p-4">
                      <div className="flex justify-between items-start mb-2">
                        <div className="font-medium text-sm text-slate-200">Lobby interior daylight</div>
                        <CheckCircle2 className="w-4 h-4 text-[#22c55e]" />
                      </div>
                      <div className="text-xs text-slate-500 flex gap-2">
                         <span>4K</span> &middot; <span>14hr ago</span>
                      </div>
                      <div className="mt-4 flex gap-2">
                        <button className="flex-1 py-1.5 bg-[#1e2a3a] rounded text-xs hover:bg-slate-700 transition-colors">View variants</button>
                      </div>
                    </div>
                  </div>

                  {/* Site aerial */}
                  <div className="bg-[#0f1729] border border-[#22c55e]/50 rounded-lg overflow-hidden">
                    <div className="aspect-[16/9] relative bg-slate-800">
                       <div className="absolute inset-0 bg-gradient-to-bl from-slate-700 to-[#0b1220]" />
                    </div>
                    <div className="p-4">
                      <div className="flex justify-between items-start mb-2">
                        <div className="font-medium text-sm text-slate-200">Site aerial massing study</div>
                        <CheckCircle2 className="w-4 h-4 text-[#22c55e]" />
                      </div>
                      <div className="text-xs text-slate-500 flex gap-2">
                         <span>1080p</span> &middot; <span>12hr ago</span>
                      </div>
                    </div>
                  </div>

                  {/* Street view */}
                  <div className="bg-[#0f1729] border border-[#5fd0e0]/50 shadow-[0_0_15px_rgba(95,208,224,0.1)] rounded-lg overflow-hidden relative">
                    <div className="absolute top-0 left-0 w-full h-1 bg-[#1e2a3a]">
                      <div className="h-full bg-[#5fd0e0] w-[60%]" />
                    </div>
                    <div className="aspect-[16/9] relative bg-slate-800/50 flex flex-col items-center justify-center">
                       <RefreshCw className="w-6 h-6 text-[#5fd0e0] animate-spin mb-2" />
                       <div className="text-xs font-medium text-[#5fd0e0]">IN PROGRESS 60%</div>
                       <div className="text-[10px] text-[#5fd0e0]/70">ETA 4 min</div>
                    </div>
                    <div className="p-4">
                      <div className="flex justify-between items-start mb-2">
                        <div className="font-medium text-sm text-slate-200">Street view sunset</div>
                      </div>
                      <div className="text-xs text-slate-500 flex gap-2">
                         <span>4K</span> &middot; <span>mnml.ai</span>
                      </div>
                      <div className="mt-4 flex gap-2">
                        <button className="flex-1 py-1.5 bg-[#ef4444]/10 text-[#ef4444] rounded text-xs hover:bg-[#ef4444]/20 transition-colors flex items-center justify-center gap-1"><XSquare className="w-3 h-3" /> Cancel job</button>
                      </div>
                    </div>
                  </div>

                  {/* Nighttime */}
                  <div className="bg-[#0f1729] border border-slate-700 border-dashed rounded-lg overflow-hidden opacity-70">
                    <div className="aspect-[16/9] relative bg-[#0b1220] flex items-center justify-center">
                       <div className="text-xs font-medium text-slate-400">QUEUED</div>
                    </div>
                    <div className="p-4">
                      <div className="flex justify-between items-start mb-2">
                        <div className="font-medium text-sm text-slate-400">Lobby interior nighttime</div>
                      </div>
                      <div className="text-xs text-[#f59e0b]">Waiting on credits</div>
                    </div>
                  </div>

                  {/* Twilight Draft */}
                  <div className="bg-[#0b1220] border border-slate-700 border-dashed rounded-lg overflow-hidden opacity-50 hover:opacity-100 transition-opacity cursor-pointer">
                    <div className="aspect-[16/9] relative flex items-center justify-center">
                       <div className="text-xs font-medium text-slate-500">DRAFT CONFIG</div>
                    </div>
                    <div className="p-4 border-t border-slate-800">
                      <div className="flex justify-between items-start mb-2">
                        <div className="font-medium text-sm text-slate-400">Hero exterior twilight</div>
                      </div>
                      <div className="text-xs text-slate-600">Not yet started</div>
                    </div>
                  </div>

                </div>
              </div>
            </>
          )}

          {activeStage === "assemble" && (
            <>
              {/* Action Bar */}
              <div className="h-[60px] border-b border-[#1e2a3a] flex items-center justify-between px-6 shrink-0 bg-[#0b1220]">
                <div className="flex items-center gap-4">
                  <div className="text-lg font-medium text-slate-200">Presentation Builder</div>
                </div>
                <div className="flex items-center gap-3">
                  <button className="flex items-center gap-2 px-3 py-1.5 rounded bg-[#1e2a3a] hover:bg-[#253447] text-xs font-medium text-slate-300 transition-colors">
                    <Eye className="w-3.5 h-3.5" />
                    Preview deck
                  </button>
                  <button className="flex items-center gap-2 px-3 py-1.5 rounded bg-[#1e2a3a] hover:bg-[#253447] text-xs font-medium text-slate-300 transition-colors">
                    <Download className="w-3.5 h-3.5" />
                    Generate draft PDF
                  </button>
                  <button className="flex items-center gap-2 px-4 py-1.5 rounded bg-[#5fd0e0]/10 hover:bg-[#5fd0e0]/20 text-[#5fd0e0] border border-[#5fd0e0]/30 text-xs font-medium transition-colors" onClick={() => setActiveStage("publish")}>
                    Hand off to Publish
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Canvas Content */}
              <div className="flex-1 flex overflow-hidden">
                
                {/* Storyboard (Left) */}
                <div className="w-[340px] border-r border-[#1e2a3a] overflow-y-auto bg-[#0b1220] p-4 custom-scrollbar">
                  <div className="flex flex-col gap-6 pb-8">
                    
                    {/* Section: Cover */}
                    <div className="flex flex-col gap-2">
                      <div className="text-[10px] font-semibold tracking-widest text-slate-500 uppercase flex items-center justify-between">
                        <span>Cover (1)</span>
                        <CheckCircle2 className="w-3 h-3 text-[#22c55e]" />
                      </div>
                      <div className="bg-[#0f1729] border border-[#1e2a3a] rounded-md p-3 flex gap-3 cursor-pointer hover:border-slate-700 transition-colors">
                        <GripVertical className="w-4 h-4 text-slate-600 mt-1 cursor-grab" />
                        <div className="flex-1">
                          <div className="text-sm text-slate-300 font-medium">Title Slide</div>
                          <div className="text-xs text-slate-500 mt-1">Project 1024</div>
                        </div>
                      </div>
                      <div className="h-6 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity cursor-pointer group">
                        <div className="h-px w-full bg-[#5fd0e0]/50 group-hover:bg-[#5fd0e0] relative">
                          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-[#0b1220] px-2 text-[#5fd0e0] text-[10px] flex items-center gap-1 font-medium">
                            <Plus className="w-3 h-3" /> Add section
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Section: Site Context */}
                    <div className="flex flex-col gap-2">
                      <div className="text-[10px] font-semibold tracking-widest text-slate-500 uppercase flex items-center justify-between">
                        <span>Site Context (3)</span>
                        <CheckCircle2 className="w-3 h-3 text-[#22c55e]" />
                      </div>
                      <div className="bg-[#0f1729] border border-[#1e2a3a] rounded-md p-3 flex gap-3 cursor-pointer hover:border-slate-700 transition-colors">
                        <GripVertical className="w-4 h-4 text-slate-600 mt-1 cursor-grab" />
                        <div className="flex-1">
                          <div className="text-sm text-slate-300 font-medium">Location Map</div>
                          <div className="flex gap-1 mt-2">
                            <span className="w-2 h-2 rounded-full bg-blue-500" title="GIS" />
                          </div>
                        </div>
                      </div>
                      <div className="bg-[#0f1729] border border-[#1e2a3a] rounded-md p-3 flex gap-3 cursor-pointer hover:border-slate-700 transition-colors">
                        <GripVertical className="w-4 h-4 text-slate-600 mt-1 cursor-grab" />
                        <div className="flex-1">
                          <div className="text-sm text-slate-300 font-medium">Zoning Constraints</div>
                          <div className="flex gap-1 mt-2">
                            <span className="w-2 h-2 rounded-full bg-purple-500" title="DOC" />
                            <span className="w-2 h-2 rounded-full bg-blue-500" title="GIS" />
                          </div>
                        </div>
                      </div>
                      <div className="h-6 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity cursor-pointer group">
                        <div className="h-px w-full bg-[#5fd0e0]/50 group-hover:bg-[#5fd0e0] relative">
                          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-[#0b1220] px-2 text-[#5fd0e0] text-[10px] flex items-center gap-1 font-medium">
                            <Plus className="w-3 h-3" /> Add section
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Section: Renders */}
                    <div className="flex flex-col gap-2">
                      <div className="text-[10px] font-semibold tracking-widest text-slate-500 uppercase flex items-center justify-between">
                        <span>Renders (3)</span>
                        <CheckCircle2 className="w-3 h-3 text-[#22c55e]" />
                      </div>
                      <div 
                        className={`bg-[#0f1729] border rounded-md p-3 flex gap-3 cursor-pointer transition-colors ${activeSlide === "render-1" ? "border-[#5fd0e0] bg-[#101c2c] shadow-[0_0_15px_rgba(95,208,224,0.1)]" : "border-[#1e2a3a] hover:border-slate-700"}`}
                        onClick={() => setActiveSlide("render-1")}
                      >
                        <GripVertical className={`w-4 h-4 mt-1 cursor-grab ${activeSlide === "render-1" ? "text-[#5fd0e0]/50" : "text-slate-600"}`} />
                        <div className="flex-1">
                          <div className="text-sm text-slate-200 font-medium flex items-center justify-between">
                            Hero View
                            {activeSlide === "render-1" && <div className="w-1.5 h-1.5 rounded-full bg-[#5fd0e0]" />}
                          </div>
                          <div className="w-full h-16 bg-slate-800 rounded mt-2 overflow-hidden relative">
                            <div className="absolute inset-0 bg-gradient-to-br from-slate-700 to-slate-900" />
                            <div className="absolute bottom-0 left-0 w-full h-1/2 bg-gradient-to-t from-black/50 to-transparent" />
                          </div>
                          <div className="flex gap-1 mt-2">
                            <span className="w-2 h-2 rounded-full bg-emerald-500" title="BIM" />
                          </div>
                        </div>
                      </div>
                      <div className="bg-[#0f1729] border border-[#1e2a3a] rounded-md p-3 flex gap-3 cursor-pointer hover:border-slate-700 transition-colors">
                        <GripVertical className="w-4 h-4 text-slate-600 mt-1 cursor-grab" />
                        <div className="flex-1">
                          <div className="text-sm text-slate-300 font-medium">Lobby Interior</div>
                          <div className="flex gap-1 mt-2">
                            <span className="w-2 h-2 rounded-full bg-emerald-500" title="BIM" />
                          </div>
                        </div>
                      </div>
                    </div>

                  </div>
                </div>

                {/* Slide Preview (Right) */}
                <div className="flex-1 bg-[#0f1729] flex flex-col p-6 overflow-y-auto">
                  
                  {/* The Slide Mockup */}
                  <div className="w-full aspect-[16/9] bg-white rounded-lg shadow-2xl overflow-hidden relative flex flex-col shrink-0 ring-1 ring-[#1e2a3a]">
                    {/* Simple slide rendering */}
                    <div className="flex-1 relative">
                      <div className="absolute inset-0 bg-gradient-to-tr from-slate-800 to-slate-600" />
                      <div className="absolute bottom-0 w-full h-1/3 bg-gradient-to-t from-black/80 to-transparent" />
                      <div className="absolute bottom-6 left-8">
                        <h2 className="text-3xl font-light text-white tracking-wide">Hero Exterior</h2>
                        <p className="text-white/70 text-sm mt-2 max-w-lg">Golden hour view from the southwest corner highlighting the main approach and material palette.</p>
                      </div>
                    </div>
                    <div className="h-12 bg-white flex items-center justify-between px-6 border-t border-slate-200">
                      <div className="text-slate-800 font-bold text-sm tracking-widest">SMARTCITY OS</div>
                      <div className="text-slate-400 text-xs">Slide 8</div>
                    </div>
                  </div>

                  {/* Slide Atoms Panel */}
                  <div className="mt-6 bg-[#0b1220] border border-[#1e2a3a] rounded-lg p-5">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
                        <Cpu className="w-4 h-4 text-slate-500" />
                        Slide Sources
                      </h3>
                      <button className="flex items-center gap-1.5 text-xs text-[#5fd0e0] hover:text-[#5fd0e0]/80 transition-colors">
                        <RefreshCw className="w-3 h-3" />
                        Regenerate slide draft (AI)
                      </button>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-4">
                      {/* Source 1 */}
                      <div className="bg-[#0f1729] border border-[#1e2a3a] p-3 rounded-md flex gap-3">
                        <div className="w-12 h-12 rounded bg-slate-800 shrink-0 overflow-hidden relative">
                          <div className="absolute inset-0 bg-gradient-to-br from-slate-700 to-slate-900" />
                        </div>
                        <div>
                          <div className="text-xs font-medium text-slate-300">Render: Hero exterior @ golden hour</div>
                          <div className="text-[10px] text-slate-500 mt-1 flex items-center gap-1">
                            <CheckCircle2 className="w-3 h-3 text-[#22c55e]" /> COMPLETE &middot; mnml.ai
                          </div>
                        </div>
                      </div>
                      {/* Source 2 */}
                      <div className="bg-[#0f1729] border border-[#1e2a3a] p-3 rounded-md flex gap-3">
                        <div className="w-12 h-12 rounded bg-slate-800 shrink-0 flex items-center justify-center">
                          <FileText className="w-5 h-5 text-slate-500" />
                        </div>
                        <div>
                          <div className="text-xs font-medium text-slate-300">Caption Template: Standard</div>
                          <div className="text-[10px] text-slate-500 mt-1">From Project Settings</div>
                        </div>
                      </div>
                    </div>
                  </div>

                </div>
              </div>
            </>
          )}

          {activeStage === "publish" && (
            <>
              {/* Action Bar */}
              <div className="h-[60px] border-b border-[#1e2a3a] flex items-center justify-between px-6 shrink-0 bg-[#0b1220]">
                <div className="flex items-center gap-4">
                  <div className="text-lg font-medium text-slate-200">Publish Prep</div>
                  <div className="bg-[#ef4444]/10 text-[#ef4444] px-2 py-0.5 rounded text-xs border border-[#ef4444]/30 font-medium">
                     3 BLOCKING ITEMS
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <button className="flex items-center gap-2 px-4 py-1.5 rounded bg-slate-800 text-slate-400 cursor-not-allowed text-xs font-medium transition-colors">
                    <Download className="w-3.5 h-3.5" />
                    Export Project Bundle
                  </button>
                </div>
              </div>

              <div className="flex-1 flex flex-col p-8 bg-[#0b1220] overflow-y-auto max-w-3xl mx-auto w-full">
                 <div className="flex items-center justify-between mb-8">
                    <div>
                      <h2 className="text-2xl font-light text-slate-200">Delivery Checklist</h2>
                      <p className="text-sm text-slate-400 mt-1">Verify all required artifacts are present before exporting the final bundle.</p>
                    </div>
                    <div className="text-right">
                       <div className="text-3xl font-light text-[#5fd0e0]">70%</div>
                       <div className="text-xs text-slate-500 uppercase tracking-widest font-semibold mt-1">Overall Progress</div>
                    </div>
                 </div>

                 <div className="space-y-4">
                    {/* Item 1 */}
                    <div className="flex items-start gap-4 p-4 rounded-lg bg-[#0f1729] border border-[#1e2a3a] hover:border-slate-700 transition-colors">
                       <div className="pt-0.5 cursor-pointer" onClick={() => setChecklist({...checklist, metadata: !checklist.metadata})}>
                          {checklist.metadata ? <CheckSquare className="w-5 h-5 text-[#22c55e]" /> : <Square className="w-5 h-5 text-slate-500" />}
                       </div>
                       <div className="flex-1">
                          <div className="text-sm font-medium text-slate-200">Project metadata complete</div>
                          <div className="text-xs text-slate-500 mt-1">Address, zoning codes, and contact info verified.</div>
                       </div>
                    </div>

                    {/* Item 2 */}
                    <div className="flex items-start gap-4 p-4 rounded-lg bg-[#0f1729] border border-[#1e2a3a] hover:border-slate-700 transition-colors">
                       <div className="pt-0.5 cursor-pointer" onClick={() => setChecklist({...checklist, briefing: !checklist.briefing})}>
                          {checklist.briefing ? <CheckSquare className="w-5 h-5 text-[#22c55e]" /> : <Square className="w-5 h-5 text-slate-500" />}
                       </div>
                       <div className="flex-1">
                          <div className="text-sm font-medium text-slate-200">Site briefing finalized</div>
                       </div>
                    </div>

                    {/* Item 3 */}
                    <div className="flex items-start gap-4 p-4 rounded-lg bg-[#0f1729] border border-[#1e2a3a] hover:border-slate-700 transition-colors">
                       <div className="pt-0.5 cursor-pointer" onClick={() => setChecklist({...checklist, planReview: !checklist.planReview})}>
                          {checklist.planReview ? <CheckSquare className="w-5 h-5 text-[#22c55e]" /> : <Square className="w-5 h-5 text-slate-500" />}
                       </div>
                       <div className="flex-1">
                          <div className="text-sm font-medium text-slate-200">Plan review run</div>
                          <div className="text-xs text-slate-500 mt-1">4 findings open &middot; must be 0</div>
                       </div>
                    </div>

                    {/* Item 4 - BLOCKING */}
                    <div className="flex items-start gap-4 p-4 rounded-lg bg-[#ef4444]/5 border border-[#ef4444]/30">
                       <div className="pt-0.5">
                          <AlertCircle className="w-5 h-5 text-[#ef4444]" />
                       </div>
                       <div className="flex-1">
                          <div className="text-sm font-medium text-[#ef4444]">All findings addressed</div>
                          <div className="text-xs text-slate-400 mt-1">4 open, 1 overridden</div>
                       </div>
                       <button className="text-xs bg-[#ef4444]/10 hover:bg-[#ef4444]/20 text-[#ef4444] px-3 py-1.5 rounded transition-colors">Resolve</button>
                    </div>

                    {/* Item 5 */}
                    <div className="flex items-start gap-4 p-4 rounded-lg bg-[#0f1729] border border-[#1e2a3a] hover:border-slate-700 transition-colors">
                       <div className="pt-0.5 cursor-pointer" onClick={() => setChecklist({...checklist, letterDrafted: !checklist.letterDrafted})}>
                          {checklist.letterDrafted ? <CheckSquare className="w-5 h-5 text-[#22c55e]" /> : <Square className="w-5 h-5 text-slate-500" />}
                       </div>
                       <div className="flex-1">
                          <div className="text-sm font-medium text-slate-200">Deliverable letter drafted</div>
                          <div className="text-xs text-slate-500 mt-1">Letter #2 &middot; <span className="text-[#f59e0b]">DRAFT</span>, awaiting send</div>
                       </div>
                    </div>

                    {/* Item 6 - PENDING */}
                    <div className="flex items-start gap-4 p-4 rounded-lg bg-[#0f1729] border border-[#f59e0b]/30">
                       <div className="pt-0.5">
                          <Square className="w-5 h-5 text-[#f59e0b]" />
                       </div>
                       <div className="flex-1">
                          <div className="text-sm font-medium text-[#f59e0b]">Letter sent</div>
                          <div className="text-xs text-slate-500 mt-1">Pending client review</div>
                       </div>
                    </div>

                    {/* Item 7 */}
                    <div className="flex items-start gap-4 p-4 rounded-lg bg-[#0f1729] border border-[#1e2a3a] hover:border-slate-700 transition-colors">
                       <div className="pt-0.5 cursor-pointer" onClick={() => setChecklist({...checklist, legacyPlan: !checklist.legacyPlan})}>
                          {checklist.legacyPlan ? <CheckSquare className="w-5 h-5 text-[#22c55e]" /> : <Square className="w-5 h-5 text-slate-500" />}
                       </div>
                       <div className="flex-1">
                          <div className="text-sm font-medium text-slate-200">Legacy plan uploaded</div>
                          <div className="text-xs text-slate-500 mt-1">Redd_existing_2019.pdf &middot; 14 MB &middot; uploaded yesterday</div>
                       </div>
                       <button className="text-xs bg-[#1e2a3a] hover:bg-slate-700 text-slate-300 px-3 py-1.5 rounded transition-colors flex items-center gap-1"><UploadCloud className="w-3 h-3" /> Update</button>
                    </div>

                    {/* Item 8 - BLOCKING */}
                    <div className="flex items-start gap-4 p-4 rounded-lg bg-[#ef4444]/5 border border-[#ef4444]/30">
                       <div className="pt-0.5 cursor-pointer" onClick={() => setChecklist({...checklist, architectSignoff: !checklist.architectSignoff})}>
                          {checklist.architectSignoff ? <CheckSquare className="w-5 h-5 text-[#22c55e]" /> : <Square className="w-5 h-5 text-[#ef4444]" />}
                       </div>
                       <div className="flex-1">
                          <div className="text-sm font-medium text-[#ef4444]">Architect sign-off</div>
                          <div className="text-xs text-slate-400 mt-1">Manual approval required</div>
                       </div>
                       <button className="text-xs bg-[#1e2a3a] hover:bg-slate-700 text-slate-300 px-3 py-1.5 rounded transition-colors flex items-center gap-1" onClick={() => setChecklist({...checklist, architectSignoff: true})}>Sign off</button>
                    </div>

                 </div>
              </div>
            </>
          )}

        </div>

        {/* RIGHT RAIL (Stage-Aware) */}
        <div className="w-[280px] bg-[#0b1220] border-l border-[#1e2a3a] flex flex-col shrink-0 relative">
          
          {activeStage === "visualize" && (
            <div className="p-5 flex flex-col gap-6 h-full">
               <div>
                 <div className="text-sm font-semibold text-slate-200 mb-3">Model Quality</div>
                 <div className="bg-[#0f1729] border border-[#1e2a3a] rounded-lg p-4 text-center">
                    <div className="text-2xl font-light text-[#22c55e] mb-1">A+</div>
                    <div className="text-xs text-slate-400">GLB Ready &middot; Materials mapped</div>
                 </div>
               </div>
               
               <div>
                 <div className="text-sm font-semibold text-slate-200 mb-3">Feeds into Assemble</div>
                 <div className="bg-[#0f1729] border border-[#1e2a3a] rounded-md p-3">
                    <div className="text-xs text-slate-400 mb-2 flex items-center justify-between">
                      <span>Renders used in deck</span>
                    </div>
                    <div className="text-sm text-slate-300 flex items-start gap-2">
                      <Layers className="w-4 h-4 shrink-0 mt-0.5 text-[#5fd0e0]" />
                      <span>3 of 6 selected<br/><span className="text-xs text-slate-500">Update presentation</span></span>
                    </div>
                 </div>
               </div>
            </div>
          )}

          {activeStage === "assemble" && (
            <>
              <div className="p-5 border-b border-[#1e2a3a]">
                <div className="flex items-center justify-between mb-4">
                  <div className="text-sm font-semibold text-slate-200">Version History</div>
                  <button className="text-xs text-slate-400 hover:text-slate-300 flex items-center gap-1 bg-[#1e2a3a] px-2 py-1 rounded">
                    v3 <ChevronDown className="w-3 h-3" />
                  </button>
                </div>
                
                <div className="flex flex-col gap-4 relative">
                  <div className="absolute left-2 top-2 bottom-2 w-px bg-[#1e2a3a]" />
                  
                  <div className="flex gap-3 relative">
                    <div className="w-4 h-4 rounded-full bg-[#0b1220] border-2 border-[#f59e0b] shrink-0 z-10" />
                    <div className="flex-1 -mt-1">
                      <div className="text-sm text-slate-200">v3 (Current)</div>
                      <div className="text-xs text-slate-500">2 hrs ago by Maria</div>
                      <div className="text-[10px] text-slate-400 mt-1 bg-[#1e2a3a]/50 p-1.5 rounded">
                        +2 slides, -1 from v2
                      </div>
                    </div>
                  </div>
                  
                  <div className="flex gap-3 relative">
                    <div className="w-4 h-4 rounded-full bg-[#1e2a3a] border-2 border-slate-600 shrink-0 z-10" />
                    <div className="flex-1 -mt-1">
                      <div className="text-sm text-slate-400">v2</div>
                      <div className="text-xs text-slate-500">Sent to client 3d ago</div>
                    </div>
                  </div>
                  
                  <div className="flex gap-3 relative">
                    <div className="w-4 h-4 rounded-full bg-[#1e2a3a] border-2 border-slate-600 shrink-0 z-10" />
                    <div className="flex-1 -mt-1">
                      <div className="text-sm text-slate-400">v1</div>
                      <div className="text-xs text-slate-500">Initial draft 1wk ago</div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="p-5 border-b border-[#1e2a3a]">
                <div className="text-sm font-semibold text-slate-200 mb-3">Share Targets</div>
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2 text-sm text-slate-300 bg-[#0f1729] p-2 rounded border border-[#1e2a3a]">
                    <div className="w-6 h-6 rounded-full bg-indigo-500/20 text-indigo-400 flex items-center justify-center text-xs font-bold">JD</div>
                    John Doe (Client)
                  </div>
                  <button className="flex items-center justify-center gap-2 w-full py-2 border border-dashed border-[#1e2a3a] text-xs text-slate-400 rounded hover:text-slate-300 hover:border-slate-600 transition-colors">
                    <Plus className="w-3 h-3" /> Add stakeholder
                  </button>
                </div>
              </div>

              <div className="p-5 flex-1 overflow-y-auto">
                <div className="text-xs font-semibold tracking-wider text-slate-500 uppercase mb-4">Pipeline Status</div>
                
                <div className="bg-[#0f1729] border border-[#1e2a3a] rounded-md p-3 mb-3 cursor-pointer hover:border-[#5fd0e0]/50 transition-colors" onClick={() => setActiveStage("visualize")}>
                  <div className="text-xs text-slate-400 mb-2 flex items-center justify-between">
                    <span>Waiting on Visualize</span>
                    <ArrowRight className="w-3 h-3" />
                  </div>
                  <div className="text-sm text-slate-300 flex items-start gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-[#5fd0e0] mt-1.5 animate-pulse" />
                    <span>Street view sunset<br/><span className="text-xs text-slate-500">ETA 4 min</span></span>
                  </div>
                </div>

                <div className="bg-[#0f1729] border border-[#1e2a3a] rounded-md p-3 cursor-pointer hover:border-slate-500 transition-colors" onClick={() => setActiveStage("publish")}>
                  <div className="text-xs text-slate-400 mb-2 flex items-center justify-between">
                    <span>Feeds into Publish</span>
                    <ArrowRight className="w-3 h-3" />
                  </div>
                  <div className="text-sm text-[#ef4444] flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>3 blocking items<br/><span className="text-xs text-slate-500">including Architect Sign-off</span></span>
                  </div>
                </div>
              </div>
            </>
          )}

          {activeStage === "publish" && (
            <div className="p-5 flex flex-col gap-6 h-full">
               <div>
                 <div className="text-sm font-semibold text-slate-200 mb-3">Project Metadata</div>
                 <div className="bg-[#0f1729] border border-[#1e2a3a] rounded-lg p-4">
                    <div className="text-xs text-slate-400 mb-1">Project ID</div>
                    <div className="text-sm text-slate-200 mb-3">PRJ-2026-1024</div>
                    <div className="text-xs text-slate-400 mb-1">Address</div>
                    <div className="text-sm text-slate-200 mb-3">1024 SmartCity Blvd.</div>
                    <div className="text-xs text-slate-400 mb-1">Client</div>
                    <div className="text-sm text-slate-200">Acme Development</div>
                 </div>
               </div>
               
               <div>
                 <div className="text-sm font-semibold text-slate-200 mb-3">Waiting on Assemble</div>
                 <div className="bg-[#0f1729] border border-[#1e2a3a] rounded-md p-3">
                    <div className="text-xs text-slate-400 mb-2 flex items-center justify-between">
                      <span>Presentation deck</span>
                    </div>
                    <div className="text-sm text-[#f59e0b] flex items-start gap-2">
                      <Layers className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>Deck is still DRAFT<br/><span className="text-xs text-slate-500">Generate final PDF</span></span>
                    </div>
                 </div>
               </div>
            </div>
          )}

          {/* Persistent Bottom Progress */}
          <div className="absolute bottom-0 w-full p-4 border-t border-[#1e2a3a] bg-[#0b1220]">
            <div className="flex justify-between text-xs mb-2">
              <span className="text-slate-400">Pipeline Progress</span>
              <span className="text-slate-200 font-medium">~75% Overall</span>
            </div>
            <div className="h-1.5 w-full bg-[#1e2a3a] rounded-full overflow-hidden flex">
              <div className="h-full bg-[#22c55e] w-[33%]" title="Visualize: Done" />
              <div className="h-full bg-[#f59e0b] w-[25%]" title="Assemble: Partial" />
              <div className="h-full bg-slate-700 w-[42%]" />
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
