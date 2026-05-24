import React, { useState } from "react";
import {
  Search,
  MessageSquare,
  PenTool,
  Highlighter,
  MousePointer2,
  Maximize,
  ZoomIn,
  ZoomOut,
  ArrowUpRight,
  Circle,
  Type,
  Ruler,
  Eraser,
  MessageCircle,
  Video,
  Layers,
  Map,
  ImageIcon,
  MoreVertical,
  CheckCircle2,
  Clock,
  Sparkles,
  Paperclip,
  AtSign,
  ChevronDown,
  ChevronRight,
  User,
  Users,
  Eye,
  Check,
  X,
  Play
} from "lucide-react";

export function MarkupStudio() {
  const [activeTool, setActiveTool] = useState("pin");
  const [expandedRenderPanel, setExpandedRenderPanel] = useState(false);

  return (
    <div 
      className="flex w-full overflow-hidden text-[#0b1220] font-sans antialiased"
      style={{ backgroundColor: "#f5f1eb", width: "1280px", height: "900px" }}
    >
      {/* LEFT RAIL - Project Drawings (~240px to fit content nicely) */}
      <div 
        className="w-[240px] flex-shrink-0 flex flex-col border-r overflow-y-auto"
        style={{ borderColor: "#d9d2c5", backgroundColor: "#fcfbf9" }}
      >
        {/* Project Header */}
        <div className="p-4 border-b" style={{ borderColor: "#d9d2c5" }}>
          <div className="flex items-start justify-between mb-2">
            <div>
              <h1 className="font-semibold text-[15px] leading-tight text-[#0b1220]">Redd Mixed-Use</h1>
              <p className="text-[12px] text-[#0b1220]/60 mt-0.5">Moab, UT</p>
            </div>
            <div className="w-8 h-8 rounded-full bg-[#0a6a78]/10 border flex items-center justify-center overflow-hidden flex-shrink-0" style={{ borderColor: "#0a6a78]/20" }}>
              <img src={`https://api.dicebear.com/7.x/notionists/svg?seed=Maria`} alt="Maria" className="w-full h-full object-cover" />
            </div>
          </div>
          
          <div className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-[#0a6a78]/10 text-[#0a6a78] mb-3">
            Phase: Design Review v3
          </div>
          
          <div className="space-y-1.5 mt-1">
            <div className="flex items-center text-[11px] text-[#0b1220]/70">
              <Clock className="w-3 h-3 mr-1.5 opacity-60" /> Last update: 2 hr ago
            </div>
            <div className="flex items-center text-[11px] text-[#0b1220]/70">
              <span className="w-2 h-2 rounded-full bg-[#c2613d] mr-1.5"></span> 5 questions waiting on you
            </div>
          </div>
        </div>

        {/* 3D Model Group */}
        <div className="p-4 border-b" style={{ borderColor: "#d9d2c5" }}>
          <div className="flex items-center justify-between mb-3 cursor-pointer group">
            <h2 className="text-[12px] font-semibold text-[#0b1220] uppercase tracking-wider">3D Model</h2>
            <ChevronDown className="w-4 h-4 text-[#0b1220]/40 group-hover:text-[#0b1220]/70" />
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-2 p-1.5 -mx-1.5 rounded-md hover:bg-black/5 cursor-pointer">
              <div className="w-10 h-7 bg-[#0b1220]/5 rounded border border-black/5 flex items-center justify-center overflow-hidden">
                <svg viewBox="0 0 40 28" className="w-full h-full text-[#0a6a78] opacity-50"><path d="M5 20L20 5L35 20Z" fill="currentColor"/></svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[12px] text-[#0b1220] truncate">Exterior</div>
                <div className="text-[10px] text-[#0b1220]/50">2 hr ago</div>
              </div>
            </div>
            <div className="flex items-center gap-2 p-1.5 -mx-1.5 rounded-md hover:bg-black/5 cursor-pointer">
              <div className="w-10 h-7 bg-[#0b1220]/5 rounded border border-black/5 flex items-center justify-center">
                <svg viewBox="0 0 40 28" className="w-full h-full text-[#0a6a78] opacity-50"><rect x="10" y="8" width="20" height="12" fill="currentColor"/></svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[12px] text-[#0b1220] truncate">Lobby</div>
                <div className="text-[10px] text-[#0b1220]/50">1 d ago</div>
              </div>
            </div>
            <div className="flex items-center gap-2 p-1.5 -mx-1.5 rounded-md hover:bg-black/5 cursor-pointer">
              <div className="w-10 h-7 bg-[#0b1220]/5 rounded border border-black/5 flex items-center justify-center">
                <svg viewBox="0 0 40 28" className="w-full h-full text-[#0a6a78] opacity-50"><circle cx="20" cy="14" r="8" fill="currentColor"/></svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[12px] text-[#0b1220] truncate">Aerial</div>
                <div className="text-[10px] text-[#0b1220]/50">3 d ago</div>
              </div>
            </div>
          </div>
        </div>

        {/* Sheets Group */}
        <div className="p-4 border-b flex-1" style={{ borderColor: "#d9d2c5" }}>
          <div className="flex items-center justify-between mb-3 cursor-pointer group">
            <h2 className="text-[12px] font-semibold text-[#0b1220] uppercase tracking-wider">Sheets (5)</h2>
            <ChevronDown className="w-4 h-4 text-[#0b1220]/40 group-hover:text-[#0b1220]/70" />
          </div>
          <div className="space-y-0.5">
            <div className="flex items-center gap-2 px-2 py-1.5 -mx-2 rounded-md hover:bg-black/5 cursor-pointer text-[#0b1220]/70">
              <Layers className="w-3.5 h-3.5 opacity-70" />
              <span className="text-[12px] flex-1">A0.0 Cover</span>
            </div>
            <div className="flex items-center gap-2 px-2 py-1.5 -mx-2 rounded-md bg-white border shadow-sm cursor-pointer relative" style={{ borderColor: "#0a6a78" }}>
              <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-[#0a6a78] rounded-l-md"></div>
              <Map className="w-3.5 h-3.5 text-[#0a6a78]" />
              <span className="text-[12px] flex-1 font-medium text-[#0b1220]">A1.1 Site plan</span>
              <span className="flex items-center justify-center bg-[#c2613d] text-white text-[9px] font-bold h-4 w-4 rounded-full">1</span>
            </div>
            <div className="flex items-center gap-2 px-2 py-1.5 -mx-2 rounded-md hover:bg-black/5 cursor-pointer text-[#0b1220]/70">
              <Layers className="w-3.5 h-3.5 opacity-70" />
              <span className="text-[12px] flex-1">A2.1 Floor plans</span>
              <span className="flex items-center justify-center bg-[#f5cb5c] text-[#0b1220] text-[9px] font-bold h-4 w-4 rounded-full">1</span>
            </div>
            <div className="flex items-center gap-2 px-2 py-1.5 -mx-2 rounded-md hover:bg-black/5 cursor-pointer text-[#0b1220]/70">
              <Layers className="w-3.5 h-3.5 opacity-70" />
              <span className="text-[12px] flex-1">A3.1 Elevations</span>
              <span className="flex items-center justify-center bg-black/10 text-[#0b1220] text-[9px] font-bold h-4 w-4 rounded-full">1</span>
            </div>
            <div className="flex items-center gap-2 px-2 py-1.5 -mx-2 rounded-md hover:bg-black/5 cursor-pointer text-[#0b1220]/70">
              <Layers className="w-3.5 h-3.5 opacity-70" />
              <span className="text-[12px] flex-1">A4.1 Sections</span>
            </div>
          </div>
        </div>

        {/* AI Renderings Mini-Section */}
        <div className="p-4 bg-white/40">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[11px] font-semibold text-[#0b1220]/70 uppercase tracking-wider">Renderings (4)</h2>
          </div>
          <div className="flex gap-2 mb-3 overflow-x-auto pb-1 hide-scrollbar">
            <div className="w-14 h-10 rounded border bg-[#0b1220]/5 flex-shrink-0 relative overflow-hidden" style={{ borderColor: "#d9d2c5" }}>
              <div className="absolute inset-0 bg-gradient-to-br from-amber-200/40 to-orange-500/40 mix-blend-multiply"></div>
              <svg viewBox="0 0 40 28" className="w-full h-full text-[#0b1220] opacity-20"><path d="M5 20L20 5L35 20Z" fill="currentColor"/></svg>
            </div>
            <div className="w-14 h-10 rounded border bg-[#0b1220]/5 flex-shrink-0 relative overflow-hidden" style={{ borderColor: "#d9d2c5" }}>
              <svg viewBox="0 0 40 28" className="w-full h-full text-[#0b1220] opacity-20"><rect x="10" y="8" width="20" height="12" fill="currentColor"/></svg>
            </div>
            <div className="w-14 h-10 rounded border bg-[#0b1220]/5 flex-shrink-0 relative overflow-hidden" style={{ borderColor: "#d9d2c5" }}>
               <svg viewBox="0 0 40 28" className="w-full h-full text-[#0b1220] opacity-20"><circle cx="20" cy="14" r="8" fill="currentColor"/></svg>
            </div>
          </div>
          <button className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded border text-[11px] font-medium transition-colors hover:bg-black/5" style={{ borderColor: "#d9d2c5", color: "#0b1220" }}>
            <Sparkles className="w-3 h-3 text-[#c2613d]" />
            AI render this view
          </button>
        </div>
      </div>

      {/* CENTER CANVAS - Drawing Surface */}
      <div className="flex-1 relative flex flex-col bg-[#e8e4db] overflow-hidden">
        
        {/* Canvas Header */}
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-4 bg-white/90 backdrop-blur-sm px-4 py-2 rounded-full shadow-sm border border-black/5">
          <div className="flex items-center gap-2">
            <Map className="w-4 h-4 text-[#0a6a78]" />
            <span className="text-[13px] font-medium text-[#0b1220]">A1.1 Site Plan</span>
          </div>
          <div className="w-px h-4 bg-black/10"></div>
          <div className="flex items-center gap-2">
            <div className="flex -space-x-1.5">
              <div className="w-5 h-5 rounded-full bg-[#c2613d] border-2 border-white flex items-center justify-center text-white text-[9px] font-bold z-10">J</div>
              <div className="w-5 h-5 rounded-full bg-[#0a6a78] border-2 border-white flex items-center justify-center z-0 overflow-hidden">
                 <img src={`https://api.dicebear.com/7.x/notionists/svg?seed=Maria`} alt="Maria" className="w-full h-full object-cover" />
              </div>
            </div>
            <span className="text-[11px] text-[#0b1220]/60"><span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block mr-1"></span>live</span>
          </div>
          <div className="w-px h-4 bg-black/10"></div>
          <button className="text-[11px] font-medium text-[#0a6a78] hover:text-[#0a6a78]/80 transition-colors">
            Resolve all
          </button>
        </div>

        {/* The Sheet Itself */}
        <div className="absolute inset-0 flex items-center justify-center p-12 pointer-events-none">
          <div className="w-full h-full max-w-4xl max-h-[800px] bg-[#faf9f7] shadow-xl border border-black/5 relative flex flex-col pointer-events-auto overflow-hidden">
            {/* Paper texture overlay */}
            <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{ backgroundImage: "url('data:image/svg+xml,%3Csvg viewBox=%220 0 200 200%22 xmlns=%22http://www.w3.org/2000/svg%22%3E%3Cfilter id=%22noiseFilter%22%3E%3CfeTurbulence type=%22fractalNoise%22 baseFrequency=%220.65%22 numOctaves=%223%22 stitchTiles=%22stitch%22/%3E%3C/filter%3E%3Crect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23noiseFilter)%22/%3E%3C/svg%3E')" }}></div>
            
            {/* Grid overlay */}
            <div className="absolute inset-0 opacity-[0.05] pointer-events-none" style={{ backgroundImage: "linear-gradient(#0b1220 1px, transparent 1px), linear-gradient(90deg, #0b1220 1px, transparent 1px)", backgroundSize: "40px 40px" }}></div>

            {/* Drawing content mockup */}
            <div className="absolute inset-8 border-2 border-[#0b1220]/80">
              <div className="absolute right-0 bottom-0 w-64 h-32 border-l-2 border-t-2 border-[#0b1220]/80 flex flex-col">
                <div className="flex-1 p-2 flex flex-col justify-end border-b-2 border-[#0b1220]/80">
                  <div className="text-[10px] font-bold tracking-widest text-[#0b1220]">CARDINAL STUDIO</div>
                </div>
                <div className="h-8 flex">
                  <div className="flex-1 border-r-2 border-[#0b1220]/80 flex items-center justify-center text-[10px] font-bold">SITE PLAN</div>
                  <div className="w-16 flex items-center justify-center text-[14px] font-bold bg-[#0b1220]/5">A1.1</div>
                </div>
              </div>

              {/* Main Plan Linework Graphic */}
              <div className="absolute inset-8 bottom-40 right-12 opacity-80">
                <svg width="100%" height="100%" viewBox="0 0 800 600" preserveAspectRatio="xMidYMid meet" className="text-[#0b1220]">
                  <rect x="100" y="100" width="600" height="400" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="10 5" />
                  <path d="M150 150 L350 150 L350 350 L150 350 Z" fill="none" stroke="currentColor" strokeWidth="4" />
                  <path d="M400 200 L650 200 L650 450 L400 450 Z" fill="none" stroke="currentColor" strokeWidth="4" />
                  <circle cx="250" cy="250" r="40" fill="none" stroke="currentColor" strokeWidth="2" />
                  <rect x="450" y="250" width="100" height="150" fill="none" stroke="currentColor" strokeWidth="2" />
                  <path d="M50 300 L750 300" stroke="currentColor" strokeWidth="1" strokeDasharray="5 5" />
                  <path d="M375 50 L375 550" stroke="currentColor" strokeWidth="1" strokeDasharray="5 5" />
                  <rect x="680" y="120" width="40" height="40" fill="currentColor" opacity="0.1" />
                  <path d="M700 110 L700 100 L710 100 M700 100 L690 115 L710 115 Z" fill="currentColor" stroke="none" />
                  <text x="695" y="90" fontSize="12" fill="currentColor" fontWeight="bold">N</text>
                </svg>
              </div>

              {/* Markups Overlay */}
              <div className="absolute top-[20%] right-[30%]">
                {/* Freehand Circle (from prompt, pretending it's A3.1 or placed here as an example markup) */}
                <svg width="120" height="100" className="absolute -top-12 -left-16 pointer-events-none text-[#c2613d] opacity-80" viewBox="0 0 100 100">
                  <path d="M20,50 Q10,10 50,10 T90,50 T50,90 T20,50" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>

              {/* The Active Pin (NE Corner) */}
              <div className="absolute top-[32%] right-[25%] group cursor-pointer">
                <div className="relative">
                  <div className="absolute -inset-4 bg-[#c2613d]/10 rounded-full scale-0 group-hover:scale-100 transition-transform"></div>
                  <div className="w-8 h-8 -ml-4 -mt-8 relative z-10 flex flex-col items-center">
                    <div className="w-6 h-6 bg-[#c2613d] rounded-full border-2 border-white shadow-md flex items-center justify-center text-white">
                      <MessageSquare className="w-3 h-3" />
                    </div>
                    <div className="w-0.5 h-3 bg-[#c2613d] -mt-1"></div>
                    <div className="w-1.5 h-1.5 bg-[#c2613d] rounded-full -mt-0.5 shadow-sm"></div>
                  </div>
                  {/* Ping animation for active */}
                  <div className="absolute -ml-1 -mt-1.5 w-3 h-3 bg-[#c2613d] rounded-full animate-ping opacity-75"></div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Floating Toolbar (Left) */}
        <div className="absolute left-6 top-1/2 -translate-y-1/2 flex flex-col items-center gap-3">
          <div className="bg-white rounded-full p-1.5 shadow-lg border border-black/5 flex flex-col gap-1">
            <button onClick={() => setActiveTool("select")} className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${activeTool === "select" ? "bg-[#0b1220]/5 text-[#0b1220]" : "text-[#0b1220]/50 hover:text-[#0b1220] hover:bg-black/5"}`}>
              <MousePointer2 className="w-4 h-4" />
            </button>
            <div className="w-6 h-px bg-black/5 mx-auto my-0.5"></div>
            <button onClick={() => setActiveTool("pin")} className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${activeTool === "pin" ? "bg-[#c2613d]/10 text-[#c2613d]" : "text-[#0b1220]/50 hover:text-[#0b1220] hover:bg-black/5"}`}>
              <MessageSquare className="w-4 h-4" />
            </button>
            <button onClick={() => setActiveTool("pen")} className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${activeTool === "pen" ? "bg-[#0b1220]/5 text-[#0b1220]" : "text-[#0b1220]/50 hover:text-[#0b1220] hover:bg-black/5"}`}>
              <PenTool className="w-4 h-4" />
            </button>
            <button onClick={() => setActiveTool("highlighter")} className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${activeTool === "highlighter" ? "bg-[#0b1220]/5 text-[#0b1220]" : "text-[#0b1220]/50 hover:text-[#0b1220] hover:bg-black/5"}`}>
              <Highlighter className="w-4 h-4" />
            </button>
            <button onClick={() => setActiveTool("shape")} className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${activeTool === "shape" ? "bg-[#0b1220]/5 text-[#0b1220]" : "text-[#0b1220]/50 hover:text-[#0b1220] hover:bg-black/5"}`}>
              <Circle className="w-4 h-4" />
            </button>
            <button onClick={() => setActiveTool("text")} className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${activeTool === "text" ? "bg-[#0b1220]/5 text-[#0b1220]" : "text-[#0b1220]/50 hover:text-[#0b1220] hover:bg-black/5"}`}>
              <Type className="w-4 h-4" />
            </button>
            <button onClick={() => setActiveTool("measure")} className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${activeTool === "measure" ? "bg-[#0b1220]/5 text-[#0b1220]" : "text-[#0b1220]/50 hover:text-[#0b1220] hover:bg-black/5"}`}>
              <Ruler className="w-4 h-4" />
            </button>
            <div className="w-6 h-px bg-black/5 mx-auto my-0.5"></div>
            <button onClick={() => setActiveTool("eraser")} className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${activeTool === "eraser" ? "bg-[#0b1220]/5 text-[#0b1220]" : "text-[#0b1220]/50 hover:text-[#0b1220] hover:bg-black/5"}`}>
              <Eraser className="w-4 h-4" />
            </button>
          </div>
          
          {/* Color swatch active indicator */}
          <div className="bg-white rounded-full p-2 shadow-lg border border-black/5 flex flex-col gap-2">
            <div className="w-5 h-5 rounded-full bg-[#c2613d] border-2 border-white ring-1 ring-black/10 cursor-pointer"></div>
            <div className="w-5 h-5 rounded-full bg-[#f5cb5c] border-2 border-white ring-1 ring-black/10 cursor-pointer"></div>
            <div className="w-5 h-5 rounded-full bg-[#0a6a78] border-2 border-white ring-1 ring-black/10 cursor-pointer"></div>
          </div>
        </div>

        {/* Floating Zoom Controls (Right) */}
        <div className="absolute right-6 top-1/2 -translate-y-1/2 flex flex-col gap-3">
          <div className="bg-white rounded-full p-1.5 shadow-lg border border-black/5 flex flex-col gap-1">
            <button className="w-8 h-8 rounded-full flex items-center justify-center text-[#0b1220]/60 hover:text-[#0b1220] hover:bg-black/5 transition-colors">
              <ZoomIn className="w-4 h-4" />
            </button>
            <div className="w-full text-center text-[10px] font-medium text-[#0b1220]/40 my-1">
              85%
            </div>
            <button className="w-8 h-8 rounded-full flex items-center justify-center text-[#0b1220]/60 hover:text-[#0b1220] hover:bg-black/5 transition-colors">
              <ZoomOut className="w-4 h-4" />
            </button>
            <div className="w-6 h-px bg-black/5 mx-auto my-0.5"></div>
            <button className="w-8 h-8 rounded-full flex items-center justify-center text-[#0b1220]/60 hover:text-[#0b1220] hover:bg-black/5 transition-colors">
              <Maximize className="w-4 h-4" />
            </button>
          </div>
          
          <button className="bg-[#0b1220] text-white rounded-full p-2 shadow-lg border border-black/10 hover:bg-[#0b1220]/90 transition-colors flex items-center justify-center group relative w-11 h-11 mx-auto">
             <div className="absolute right-full mr-3 whitespace-nowrap bg-[#0b1220] text-white text-[11px] font-medium px-2 py-1 rounded opacity-0 translate-x-2 pointer-events-none group-hover:opacity-100 group-hover:translate-x-0 transition-all">View in 3D</div>
             <ArrowUpRight className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* RIGHT PANE - Inspector & Thread (~320px) */}
      <div 
        className="w-[320px] flex-shrink-0 bg-white border-l flex flex-col shadow-[-4px_0_12px_rgba(0,0,0,0.02)] z-20 relative"
        style={{ borderColor: "#d9d2c5" }}
      >
        {/* Tabs */}
        <div className="flex border-b" style={{ borderColor: "#d9d2c5" }}>
          <button className="flex-1 py-3 text-[12px] font-medium text-[#0b1220] border-b-2 border-[#0b1220]">
            Markups on A1.1 (1)
          </button>
          <button className="flex-1 py-3 text-[12px] font-medium text-[#0b1220]/50 hover:text-[#0b1220] transition-colors">
            All open (5)
          </button>
        </div>

        {/* Thread View */}
        <div className="flex-1 overflow-y-auto bg-white flex flex-col">
          {/* Thread Header Context */}
          <div className="p-4 border-b bg-[#faf9f7]" style={{ borderColor: "#d9d2c5" }}>
            <div className="flex items-center justify-between mb-3">
               <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-amber-100/50 text-amber-700 text-[10px] font-bold tracking-wide border border-amber-200">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500"></span>
                  OPEN
               </div>
               <button className="text-[11px] text-[#0b1220]/50 hover:text-[#0b1220] font-medium flex items-center gap-1">
                 <CheckCircle2 className="w-3.5 h-3.5" /> Mark resolved
               </button>
            </div>
            
            <div className="w-full h-24 bg-white border rounded overflow-hidden relative mb-2" style={{ borderColor: "#d9d2c5" }}>
              {/* Mini map crop mockup */}
              <div className="absolute inset-0 opacity-20" style={{ backgroundImage: "linear-gradient(#0b1220 1px, transparent 1px), linear-gradient(90deg, #0b1220 1px, transparent 1px)", backgroundSize: "10px 10px" }}></div>
              <svg width="100%" height="100%" viewBox="0 0 100 60" preserveAspectRatio="none" className="text-[#0b1220] opacity-50 absolute inset-0">
                  <path d="M40 20 L90 20 L90 50 Z" fill="none" stroke="currentColor" strokeWidth="1" />
              </svg>
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-4 h-4 bg-[#c2613d]/20 rounded-full flex items-center justify-center">
                 <div className="w-2 h-2 bg-[#c2613d] rounded-full"></div>
              </div>
            </div>
            <p className="text-[11px] text-[#0b1220]/60">Pin on <span className="font-medium text-[#0b1220]">A1.1 Site plan</span> (NE corner)</p>
          </div>

          {/* Messages */}
          <div className="flex-1 p-4 space-y-5">
            {/* Client Message */}
            <div className="flex gap-3">
              <div className="w-7 h-7 rounded-full bg-[#c2613d] flex items-center justify-center text-white text-[11px] font-bold flex-shrink-0 mt-0.5">J</div>
              <div>
                <div className="flex items-baseline gap-2 mb-1">
                  <span className="text-[12px] font-semibold text-[#0b1220]">James (You)</span>
                  <span className="text-[10px] text-[#0b1220]/40">3 d ago</span>
                </div>
                <div className="text-[13px] text-[#0b1220]/80 leading-relaxed bg-[#f5f1eb] p-3 rounded-lg rounded-tl-none">
                  Can we shift the entry plaza 10 ft south for better afternoon shade?
                </div>
              </div>
            </div>

            {/* Architect Reply */}
            <div className="flex gap-3">
               <div className="w-7 h-7 rounded-full bg-[#0a6a78] border border-black/5 flex items-center justify-center flex-shrink-0 mt-0.5 overflow-hidden">
                 <img src={`https://api.dicebear.com/7.x/notionists/svg?seed=Maria`} alt="Maria" className="w-full h-full object-cover" />
               </div>
              <div>
                <div className="flex items-baseline gap-2 mb-1">
                  <span className="text-[12px] font-semibold text-[#0b1220]">Maria Castaneda</span>
                  <span className="text-[10px] text-[#0a6a78] bg-[#0a6a78]/10 px-1.5 py-0.5 rounded">Architect</span>
                  <span className="text-[10px] text-[#0b1220]/40">1 d ago</span>
                </div>
                <div className="text-[13px] text-[#0b1220]/80 leading-relaxed bg-white border p-3 rounded-lg rounded-tl-none shadow-sm" style={{ borderColor: "#d9d2c5" }}>
                  Studying this now. It compresses the drop-off lane slightly, but the shade benefits are clear. I'm generating a new render to show the impact on the canopy.
                </div>
              </div>
            </div>
          </div>

          {/* Composer */}
          <div className="p-4 border-t bg-white" style={{ borderColor: "#d9d2c5" }}>
             <div className="border rounded-lg shadow-sm focus-within:ring-2 focus-within:ring-[#0a6a78]/20 transition-all bg-white" style={{ borderColor: "#d9d2c5" }}>
               <textarea 
                 placeholder="Reply to thread..." 
                 className="w-full bg-transparent p-3 text-[13px] outline-none resize-none min-h-[80px] placeholder:text-[#0b1220]/30"
               ></textarea>
               <div className="flex items-center justify-between p-2 bg-[#faf9f7] border-t rounded-b-lg" style={{ borderColor: "#d9d2c5" }}>
                 <div className="flex gap-1">
                   <button className="p-1.5 text-[#0b1220]/40 hover:text-[#0b1220] hover:bg-black/5 rounded transition-colors"><Paperclip className="w-4 h-4" /></button>
                   <button className="p-1.5 text-[#0b1220]/40 hover:text-[#0b1220] hover:bg-black/5 rounded transition-colors"><AtSign className="w-4 h-4" /></button>
                 </div>
                 <button className="bg-[#c2613d] text-white px-4 py-1.5 rounded text-[12px] font-medium hover:bg-[#b05634] transition-colors shadow-sm">
                   Reply
                 </button>
               </div>
             </div>
          </div>
        </div>

        {/* AI Render Panel (Collapsible Bottom) */}
        <div className="border-t bg-[#0b1220] text-white transition-all duration-300 flex flex-col" style={{ borderColor: "#0b1220", height: expandedRenderPanel ? "340px" : "56px" }}>
           <button 
             className="w-full px-4 py-3 flex items-center justify-between hover:bg-white/5 transition-colors"
             onClick={() => setExpandedRenderPanel(!expandedRenderPanel)}
           >
             <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-amber-300" />
                <span className="text-[13px] font-medium">Generate AI Render</span>
             </div>
             <ChevronDown className={`w-4 h-4 opacity-50 transition-transform ${expandedRenderPanel ? "rotate-180" : ""}`} />
           </button>
           
           {expandedRenderPanel && (
             <div className="flex-1 p-4 pt-0 overflow-y-auto flex flex-col gap-4">
                <p className="text-[11px] text-white/60 leading-relaxed">
                  Turn the current camera angle into a photoreal visualization instantly.
                </p>

                <div className="space-y-3">
                  <div>
                    <label className="text-[10px] font-bold text-white/40 uppercase tracking-wider mb-1.5 block">Angle Source</label>
                    <div className="bg-white/10 rounded p-2 text-[12px] border border-white/10 flex items-center gap-2">
                       <Map className="w-3.5 h-3.5 text-white/50" />
                       Current active pin (A1.1 NE Corner)
                    </div>
                  </div>

                  <div>
                    <label className="text-[10px] font-bold text-white/40 uppercase tracking-wider mb-1.5 block">Mood / Lighting</label>
                    <div className="grid grid-cols-2 gap-2">
                      <button className="border border-[#c2613d] bg-[#c2613d]/10 text-white rounded p-2 text-[11px] font-medium text-left">Golden Hour</button>
                      <button className="border border-white/10 bg-white/5 hover:bg-white/10 text-white/70 rounded p-2 text-[11px] font-medium text-left transition-colors">Dusk / Evening</button>
                      <button className="border border-white/10 bg-white/5 hover:bg-white/10 text-white/70 rounded p-2 text-[11px] font-medium text-left transition-colors">Overcast</button>
                      <button className="border border-white/10 bg-white/5 hover:bg-white/10 text-white/70 rounded p-2 text-[11px] font-medium text-left transition-colors">Interior Daylight</button>
                    </div>
                  </div>
                  
                  <div>
                    <label className="text-[10px] font-bold text-white/40 uppercase tracking-wider mb-1.5 block">Fidelity</label>
                    <div className="flex bg-white/5 rounded border border-white/10 p-0.5">
                      <button className="flex-1 py-1 text-[11px] font-medium bg-white/20 rounded shadow-sm">Standard (1080p)</button>
                      <button className="flex-1 py-1 text-[11px] font-medium text-white/50 hover:text-white transition-colors">High (4K) ⚡</button>
                    </div>
                  </div>
                </div>

                <div className="mt-auto pt-2 border-t border-white/10">
                  <div className="flex justify-between items-center mb-2 text-[10px] text-white/40">
                    <span>Render credits</span>
                    <span>12 of 20 this month</span>
                  </div>
                  <button className="w-full bg-[#c2613d] hover:bg-[#b05634] text-white py-2.5 rounded font-medium text-[13px] shadow-lg transition-colors flex items-center justify-center gap-2">
                    <Sparkles className="w-4 h-4" />
                    Generate · 1 credit
                  </button>
                </div>
             </div>
           )}
        </div>
      </div>
    </div>
  );
}
