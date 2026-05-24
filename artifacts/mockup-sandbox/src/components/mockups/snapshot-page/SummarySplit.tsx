import React, { useState } from "react";
import {
  ChevronLeft,
  MapPin,
  Clock,
  Layers,
  Box,
  Building,
  Grid3X3,
  FileJson,
  FileIcon,
  ChevronDown,
  ChevronRight,
  Maximize,
  Minus,
  Plus,
  Rotate3D,
  CheckCircle2,
  FolderArchive,
  Pencil,
  Send,
  Eye,
  Camera,
  Map,
  MessageSquare,
  FileText,
  MousePointerClick,
  Settings,
  Tags,
  Users
} from "lucide-react";

export function SummarySplit() {
  return (
    <div className="h-screen w-full flex bg-[#040810] text-slate-300 font-sans overflow-hidden">
      {/* Main Content Area */}
      <div className="flex-1 flex p-4 gap-4 min-w-0">
        
        {/* LEFT COLUMN: Project Summary Card */}
        <div className="w-[38%] min-w-[400px] flex flex-col gap-4 overflow-y-auto pr-1 custom-scrollbar">
          
          <div className="bg-[#0b1220] border border-[#1e2a3a] rounded-lg p-5 flex flex-col gap-6">
            
            {/* Header */}
            <div className="flex flex-col gap-3">
              <button className="flex items-center text-xs text-slate-400 hover:text-white mb-1 w-fit transition-colors">
                <ChevronLeft className="w-3 h-3 mr-1" />
                Projects
              </button>
              
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <h1 className="text-2xl font-semibold text-white tracking-tight">Redd</h1>
                  <span className="px-2 py-0.5 rounded-full bg-[#102a2d] text-[#5fd0e0] text-[10px] font-medium border border-[#1e4a4d] uppercase tracking-wider">
                    Active
                  </span>
                </div>
              </div>

              <div className="flex flex-col gap-1.5 text-sm text-slate-400">
                <div className="flex items-center gap-2">
                  <MapPin className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                  <span className="truncate">143 E 100 N Moab UT 84532 · Moab, UT</span>
                </div>
              </div>
            </div>

            <div className="h-px w-full bg-[#1e2a3a]"></div>

            {/* KPIs */}
            <div className="flex flex-col gap-3">
              <h2 className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest">Snapshot Metrics</h2>
              
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-[#121c2d] border border-[#1e2a3a] rounded-md p-3">
                  <div className="flex items-center gap-2 mb-2 text-slate-400">
                    <FileIcon className="w-4 h-4" />
                    <span className="text-xs font-medium">SHEETS</span>
                  </div>
                  <div className="text-xl font-medium text-white">15</div>
                </div>
                
                <div className="bg-[#121c2d] border border-[#1e2a3a] rounded-md p-3">
                  <div className="flex items-center gap-2 mb-2 text-slate-400">
                    <Box className="w-4 h-4" />
                    <span className="text-xs font-medium">ROOMS</span>
                  </div>
                  <div className="text-xl font-medium text-white">0</div>
                </div>

                <div className="bg-[#121c2d] border border-[#1e2a3a] rounded-md p-3">
                  <div className="flex items-center gap-2 mb-2 text-slate-400">
                    <Layers className="w-4 h-4" />
                    <span className="text-xs font-medium">LEVELS</span>
                  </div>
                  <div className="text-xl font-medium text-white">7</div>
                </div>

                <div className="bg-[#121c2d] border border-[#1e2a3a] rounded-md p-3">
                  <div className="flex items-center gap-2 mb-2 text-slate-400">
                    <Grid3X3 className="w-4 h-4" />
                    <span className="text-xs font-medium">WALLS</span>
                  </div>
                  <div className="text-xl font-medium text-white">45</div>
                </div>
              </div>
              
              <div className="flex items-center gap-1.5 text-[11px] text-slate-500 mt-1">
                <Clock className="w-3 h-3" />
                <span>Captured from latest snapshot 18 hr ago</span>
              </div>
            </div>

            <div className="h-px w-full bg-[#1e2a3a]"></div>

            {/* Timeline */}
            <div className="flex flex-col gap-3">
              <h2 className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest">Activity & Snapshots</h2>
              
              <div className="flex flex-col gap-2">
                
                {/* Expanded Current Snapshot */}
                <div className="bg-[#102a2d]/30 border border-[#5fd0e0]/30 rounded-md p-3 flex flex-col gap-3 relative">
                  <div className="absolute left-0 top-0 bottom-0 w-1 bg-[#5fd0e0] rounded-l-md"></div>
                  
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-5 h-5 rounded bg-[#102a2d] border border-[#1e4a4d] flex items-center justify-center text-[#5fd0e0]">
                        <Camera className="w-3 h-3" />
                      </div>
                      <span className="text-sm font-medium text-[#5fd0e0]">18 hr ago</span>
                    </div>
                    <ChevronDown className="w-4 h-4 text-slate-500" />
                  </div>
                  
                  <div className="flex items-center gap-2 text-xs text-slate-300">
                    <span>15sh</span>
                    <span className="text-slate-600">·</span>
                    <span>0rm</span>
                    <span className="text-slate-600">·</span>
                    <span>7lv</span>
                    <span className="text-slate-600">·</span>
                    <span>45w</span>
                  </div>

                  {/* Expanded Content */}
                  <div className="bg-[#0b1220] rounded border border-[#1e2a3a] p-3 mt-1 flex flex-col gap-3">
                    <div className="grid grid-cols-5 gap-2">
                      <div className="aspect-[3/4] bg-slate-800 rounded-sm border border-slate-700 flex flex-col">
                        <div className="flex-1 bg-slate-900 m-[2px] rounded-[1px] relative overflow-hidden">
                          <div className="absolute top-1 left-1 right-1 h-1 bg-slate-800 rounded-sm"></div>
                          <div className="absolute top-3 left-1 w-2 h-2 bg-slate-800 rounded-sm"></div>
                        </div>
                        <div className="h-3 flex items-center justify-center text-[8px] text-slate-400">A101</div>
                      </div>
                      <div className="aspect-[3/4] bg-slate-800 rounded-sm border border-slate-700 flex flex-col">
                        <div className="flex-1 bg-slate-900 m-[2px] rounded-[1px] relative overflow-hidden">
                          <div className="absolute top-1 left-1 right-1 h-1 bg-slate-800 rounded-sm"></div>
                          <div className="absolute top-3 left-1 right-1 bottom-1 bg-slate-800 rounded-sm"></div>
                        </div>
                        <div className="h-3 flex items-center justify-center text-[8px] text-slate-400">A102</div>
                      </div>
                      <div className="aspect-[3/4] bg-slate-800 rounded-sm border border-slate-700 flex flex-col">
                        <div className="flex-1 bg-slate-900 m-[2px] rounded-[1px] relative overflow-hidden">
                          <div className="absolute top-1 left-1 w-3 h-3 bg-slate-800 rounded-sm"></div>
                          <div className="absolute top-5 left-1 right-1 h-1 bg-slate-800 rounded-sm"></div>
                        </div>
                        <div className="h-3 flex items-center justify-center text-[8px] text-slate-400">A103</div>
                      </div>
                      <div className="aspect-[3/4] bg-slate-800/50 rounded-sm border border-slate-700/50 flex flex-col items-center justify-center">
                        <span className="text-[10px] text-slate-500">+12</span>
                      </div>
                    </div>

                    <div className="flex justify-between items-center text-xs text-slate-400">
                      <div className="flex items-center gap-1.5">
                        <div className="w-4 h-4 rounded-full bg-slate-700 flex items-center justify-center text-[9px] text-white">JS</div>
                        <span>Captured by System</span>
                      </div>
                      <span>42.8 MB</span>
                    </div>

                    <button className="flex items-center gap-1.5 text-xs text-[#5fd0e0] hover:text-white transition-colors mt-1 w-fit">
                      <FileJson className="w-3.5 h-3.5" />
                      <span>View raw JSON</span>
                    </button>
                  </div>
                </div>

                {/* Historical Snapshots */}
                {[
                  { time: "2 d ago", stats: "14sh · 0rm · 7lv · 42w" },
                  { time: "5 d ago", stats: "12sh · 0rm · 6lv · 38w" },
                  { time: "1 wk ago", stats: "10sh · 0rm · 5lv · 30w" },
                  { time: "2 wk ago", stats: "8sh · 0rm · 4lv · 22w" },
                ].map((snap, i) => (
                  <div key={i} className="bg-[#121c2d] border border-[#1e2a3a] rounded-md p-3 flex items-center justify-between hover:bg-[#162235] cursor-pointer transition-colors group">
                    <div className="flex items-center gap-3">
                      <div className="w-5 h-5 rounded bg-[#1a2638] border border-[#2a384a] flex items-center justify-center text-slate-400 group-hover:text-slate-300">
                        <Camera className="w-3 h-3" />
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-medium text-slate-300">{snap.time}</span>
                        <span className="text-xs text-slate-500">{snap.stats}</span>
                      </div>
                    </div>
                    <ChevronRight className="w-4 h-4 text-slate-600 group-hover:text-slate-400" />
                  </div>
                ))}
              </div>
            </div>

            <div className="h-px w-full bg-[#1e2a3a]"></div>

            {/* Actions */}
            <div className="flex flex-col gap-3">
              <h2 className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest">What's Next</h2>
              
              <div className="flex flex-col gap-2">
                <button className="w-full flex items-center justify-center gap-2 bg-[#5fd0e0] hover:bg-[#4bc0d0] text-[#040810] font-medium rounded-md py-2.5 px-4 text-sm transition-colors">
                  <Send className="w-4 h-4" />
                  Submit to jurisdiction
                </button>
                
                <div className="grid grid-cols-2 gap-2 mt-1">
                  <button className="flex items-center justify-center gap-2 bg-[#121c2d] hover:bg-[#1a2638] border border-[#1e2a3a] text-slate-300 rounded-md py-2 px-3 text-sm transition-colors">
                    <Pencil className="w-3.5 h-3.5" />
                    Edit details
                  </button>
                  <button className="flex items-center justify-center gap-2 bg-[#121c2d] hover:bg-[#1a2638] border border-[#1e2a3a] text-slate-300 rounded-md py-2 px-3 text-sm transition-colors">
                    <FolderArchive className="w-3.5 h-3.5" />
                    Archive
                  </button>
                </div>
              </div>
            </div>

          </div>
        </div>

        {/* RIGHT COLUMN: BIM Viewer */}
        <div className="flex-1 relative bg-[#080d16] border border-[#1e2a3a] rounded-lg overflow-hidden flex flex-col shadow-xl">
          
          {/* Viewer Header */}
          <div className="h-12 border-b border-[#1e2a3a] bg-[#0b1220]/80 backdrop-blur flex items-center justify-between px-4 z-10 shrink-0">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <Box className="w-4 h-4 text-[#5fd0e0]" />
                <span className="text-xs font-semibold tracking-wider text-slate-200">BIM MODEL</span>
              </div>
              <div className="w-px h-4 bg-[#1e2a3a]"></div>
              <span className="text-xs text-slate-400">101 elements</span>
            </div>
            
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 cursor-pointer group">
                <div className="relative inline-flex items-center h-4 w-7 rounded-full bg-[#1e2a3a] transition-colors group-hover:bg-[#2a384a]">
                  <span className="inline-block w-3 h-3 transform rounded-full bg-slate-400 translate-x-0.5 transition-transform" />
                </div>
                <span className="text-xs text-slate-400 group-hover:text-slate-300 transition-colors">Compare with previous</span>
              </label>
              
              <div className="w-px h-4 bg-[#1e2a3a]"></div>
              
              <button className="text-slate-400 hover:text-white transition-colors">
                <Maximize className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Viewer Canvas Area */}
          <div className="flex-1 relative overflow-hidden perspective-1000">
            {/* Ambient Background Glow */}
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-[#101a2a] via-[#040810] to-[#040810]"></div>
            
            {/* Grid Pattern */}
            <div className="absolute inset-0" style={{
              backgroundImage: `
                linear-gradient(to right, #1e2a3a 1px, transparent 1px),
                linear-gradient(to bottom, #1e2a3a 1px, transparent 1px)
              `,
              backgroundSize: '40px 40px',
              transform: 'rotateX(60deg) scale(2) translateY(-20%)',
              transformOrigin: 'top center',
              opacity: 0.3
            }}></div>

            {/* 3D Massing Mockup */}
            <div className="absolute inset-0 flex items-center justify-center transform-style-3d">
              {/* Main Mass */}
              <div className="absolute w-64 h-48 bg-[#2a384a] border border-[#3a4b60] shadow-[10px_20px_30px_rgba(0,0,0,0.5)] transform -rotate-12 skew-x-12 translate-y-8 flex flex-col justify-between p-4">
                <div className="w-full h-1 bg-[#1e2a3a]"></div>
                <div className="w-full h-1 bg-[#1e2a3a]"></div>
                <div className="w-full h-1 bg-[#1e2a3a]"></div>
                <div className="w-full h-1 bg-[#1e2a3a]"></div>
                <div className="w-full h-1 bg-[#1e2a3a]"></div>
              </div>
              
              {/* Side Mass */}
              <div className="absolute w-32 h-24 bg-[#1e2a3a] border border-[#2a384a] shadow-[5px_10px_20px_rgba(0,0,0,0.5)] transform -rotate-12 skew-x-12 -translate-x-32 translate-y-16 flex flex-col justify-between p-2">
                <div className="w-full h-0.5 bg-[#121c2d]"></div>
                <div className="w-full h-0.5 bg-[#121c2d]"></div>
                <div className="w-full h-0.5 bg-[#121c2d]"></div>
              </div>

              {/* Top Highlight Mass */}
              <div className="absolute w-24 h-16 bg-[#3a4b60] border border-[#4a5f78] opacity-80 transform -rotate-12 skew-x-12 translate-x-12 -translate-y-12"></div>
            </div>

            {/* Viewport Hint */}
            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-[#0b1220]/80 backdrop-blur border border-[#1e2a3a] rounded-full px-4 py-1.5 flex items-center gap-3 shadow-lg">
              <span className="text-[11px] text-slate-400">Drag to pan</span>
              <span className="w-1 h-1 rounded-full bg-slate-600"></span>
              <span className="text-[11px] text-slate-400">Scroll to zoom</span>
              <span className="w-1 h-1 rounded-full bg-slate-600"></span>
              <span className="text-[11px] text-slate-400">Right-drag to rotate</span>
              <span className="w-1 h-1 rounded-full bg-slate-600"></span>
              <span className="text-[11px] text-[#5fd0e0] hover:text-white cursor-pointer transition-colors">Reset view</span>
            </div>

            {/* Overlay Controls */}
            <div className="absolute right-4 top-4 flex flex-col gap-2">
              <div className="bg-[#0b1220]/80 backdrop-blur border border-[#1e2a3a] rounded-md overflow-hidden flex flex-col shadow-lg">
                <button className="p-2 text-slate-400 hover:text-white hover:bg-[#1e2a3a] transition-colors">
                  <Plus className="w-4 h-4" />
                </button>
                <div className="h-px w-full bg-[#1e2a3a]"></div>
                <button className="p-2 text-slate-400 hover:text-white hover:bg-[#1e2a3a] transition-colors">
                  <Minus className="w-4 h-4" />
                </button>
              </div>
              <div className="bg-[#0b1220]/80 backdrop-blur border border-[#1e2a3a] rounded-md shadow-lg">
                <button className="p-2 text-slate-400 hover:text-white hover:bg-[#1e2a3a] transition-colors rounded-md">
                  <Rotate3D className="w-4 h-4" />
                </button>
              </div>
            </div>

          </div>
        </div>

      </div>

      {/* FAR RIGHT: VIEWS Rail */}
      <div className="w-64 border-l border-[#1e2a3a] bg-[#0b1220] flex flex-col h-full shrink-0">
        <div className="p-4 border-b border-[#1e2a3a]">
          <h3 className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest">Views</h3>
        </div>
        <div className="flex-1 overflow-y-auto py-2 custom-scrollbar">
          <div className="px-2 flex flex-col gap-0.5">
            
            <button className="w-full flex items-center gap-3 px-3 py-2 rounded-md bg-[#102a2d] text-[#5fd0e0] text-sm font-medium">
              <Camera className="w-4 h-4" />
              Snapshots
            </button>
            <button className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-slate-400 hover:text-slate-200 hover:bg-[#121c2d] text-sm font-medium transition-colors">
              <FileIcon className="w-4 h-4" />
              Sheets
            </button>
            <button className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-slate-400 hover:text-slate-200 hover:bg-[#121c2d] text-sm font-medium transition-colors">
              <Box className="w-4 h-4" />
              3D model
            </button>
            <button className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-slate-400 hover:text-slate-200 hover:bg-[#121c2d] text-sm font-medium transition-colors">
              <Map className="w-4 h-4" />
              Site
            </button>
            <button className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-slate-400 hover:text-slate-200 hover:bg-[#121c2d] text-sm font-medium transition-colors">
              <Building className="w-4 h-4" />
              Site context
            </button>
            
            <div className="my-2 h-px bg-[#1e2a3a] mx-3"></div>
            
            <button className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-slate-400 hover:text-slate-200 hover:bg-[#121c2d] text-sm font-medium transition-colors">
              <Send className="w-4 h-4" />
              Submissions
            </button>
            <button className="w-full flex items-center justify-between px-3 py-2 rounded-md text-slate-400 hover:text-slate-200 hover:bg-[#121c2d] text-sm font-medium transition-colors">
              <div className="flex items-center gap-3">
                <CheckCircle2 className="w-4 h-4" />
                Findings
              </div>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-[#1e2a3a] text-slate-300">4</span>
            </button>
            <button className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-slate-400 hover:text-slate-200 hover:bg-[#121c2d] text-sm font-medium transition-colors">
              <MessageSquare className="w-4 h-4" />
              Response tasks
            </button>
            <button className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-slate-400 hover:text-slate-200 hover:bg-[#121c2d] text-sm font-medium transition-colors">
              <FileText className="w-4 h-4" />
              Deliverable letters
            </button>
            
            <div className="my-2 h-px bg-[#1e2a3a] mx-3"></div>

            <button className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-slate-400 hover:text-slate-200 hover:bg-[#121c2d] text-sm font-medium transition-colors">
              <Tags className="w-4 h-4" />
              Detail callouts
            </button>
            <button className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-slate-400 hover:text-slate-200 hover:bg-[#121c2d] text-sm font-medium transition-colors">
              <Box className="w-4 h-4" />
              Product specs
            </button>

            <div className="my-2 h-px bg-[#1e2a3a] mx-3"></div>

            <button className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-slate-400 hover:text-slate-200 hover:bg-[#121c2d] text-sm font-medium transition-colors">
              <Pencil className="w-4 h-4" />
              Design Tools
            </button>
            <button className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-slate-400 hover:text-slate-200 hover:bg-[#121c2d] text-sm font-medium transition-colors">
              <Eye className="w-4 h-4" />
              Presentations
            </button>
            <button className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-slate-400 hover:text-slate-200 hover:bg-[#121c2d] text-sm font-medium transition-colors">
              <FolderArchive className="w-4 h-4" />
              Publish prep
            </button>
            <button className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-slate-400 hover:text-slate-200 hover:bg-[#121c2d] text-sm font-medium transition-colors">
              <Settings className="w-4 h-4" />
              Settings
            </button>

          </div>
        </div>
      </div>
      
      <style dangerouslySetInnerHTML={{__html: `
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #1e2a3a;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #2a384a;
        }
        .perspective-1000 {
          perspective: 1000px;
        }
        .transform-style-3d {
          transform-style: preserve-3d;
        }
      `}} />
    </div>
  );
}
