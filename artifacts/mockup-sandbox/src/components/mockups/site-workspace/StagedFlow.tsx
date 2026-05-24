import React, { useState } from "react";
import {
  Check,
  ChevronRight,
  Layers,
  Map as MapIcon,
  RefreshCw,
  Upload,
  Download,
  Navigation2,
  FileText,
  Database,
  RadioReceiver,
  MapPin,
  Building2,
  Box,
  Globe,
  Settings,
  AlertTriangle,
  Info,
  Edit2
} from "lucide-react";

export function StagedFlow() {
  const [activeLayers, setActiveLayers] = useState<Record<string, boolean>>({
    zoning: true,
    flood: true,
    topo: true,
    ejscreen: false,
    broadband: false,
    parcel: true,
    qgis: false,
  });

  const toggleLayer = (layer: string) => {
    setActiveLayers((prev) => ({ ...prev, [layer]: !prev[layer] }));
  };

  return (
    <div className="flex w-full h-[900px] overflow-hidden text-slate-300 font-sans" style={{ backgroundColor: "#0b1220" }}>
      {/* LEFT STAGE RAIL */}
      <div className="w-[220px] shrink-0 border-r border-[#1e2a3a] flex flex-col bg-[#0b1220] z-10 relative shadow-xl">
        <div className="p-4 border-b border-[#1e2a3a]">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-2 h-2 rounded-full bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.6)]" />
            <span className="text-xs font-semibold tracking-wider text-green-400 uppercase">Active</span>
          </div>
          <h1 className="text-lg font-bold text-white truncate">Redd</h1>
          <p className="text-xs text-slate-500 uppercase tracking-wide mt-1">Site Workspace</p>
        </div>

        <div className="flex-1 p-4 flex flex-col gap-6 overflow-y-auto">
          {/* Stages */}
          <div className="flex flex-col relative">
            {/* Connecting line */}
            <div className="absolute left-[15px] top-4 bottom-4 w-px bg-[#1e2a3a] z-0" />

            {/* Stage 1 */}
            <div className="relative z-10 flex items-start gap-3 mb-6 opacity-60">
              <div className="w-8 h-8 rounded-full bg-green-900/40 border border-green-500/50 flex items-center justify-center shrink-0 text-green-400">
                <Check size={16} />
              </div>
              <div className="pt-1">
                <div className="text-sm font-semibold text-white">Locate</div>
                <div className="text-xs text-slate-500 mt-0.5 leading-snug">Where is this site?</div>
              </div>
            </div>

            {/* Stage 2 (Active) */}
            <div className="relative z-10 flex items-start gap-3 mb-6">
              <div className="w-8 h-8 rounded-full bg-[#5fd0e0]/20 border border-[#5fd0e0] flex items-center justify-center shrink-0 shadow-[0_0_12px_rgba(95,208,224,0.4)]">
                <div className="w-2.5 h-2.5 rounded-full bg-[#5fd0e0]" />
              </div>
              <div className="pt-1">
                <div className="text-sm font-bold text-[#5fd0e0]">Understand</div>
                <div className="text-xs text-slate-400 mt-0.5 leading-snug">What are the constraints?</div>
              </div>
            </div>

            {/* Stage 3 */}
            <div className="relative z-10 flex items-start gap-3 opacity-40">
              <div className="w-8 h-8 rounded-full bg-[#0f1729] border border-[#1e2a3a] flex items-center justify-center shrink-0 text-slate-500">
                <span className="text-xs font-bold">3</span>
              </div>
              <div className="pt-1">
                <div className="text-sm font-semibold text-white">Propose</div>
                <div className="text-xs text-slate-500 mt-0.5 leading-snug">What are we building?</div>
              </div>
            </div>
          </div>

          <div className="mt-auto">
            {/* Site Facts mini-summary */}
            <div className="bg-[#0f1729] border border-[#1e2a3a] rounded-lg p-3 mb-4">
              <div className="flex items-center justify-between mb-2">
                <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Site Facts</div>
                <button className="text-slate-500 hover:text-[#5fd0e0] transition-colors"><Edit2 size={12} /></button>
              </div>
              <div className="space-y-2">
                <div>
                  <div className="text-[10px] text-slate-500">Address</div>
                  <div className="text-xs text-slate-300 leading-tight">143 E 100 N Moab UT 84532</div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-500">Jurisdiction</div>
                  <div className="text-xs text-slate-300">Grand County, UT</div>
                </div>
                <div className="flex justify-between">
                  <div>
                    <div className="text-[10px] text-slate-500">Lot Area</div>
                    <div className="text-xs text-slate-300">0.38 acres</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-slate-500">Type</div>
                    <div className="text-xs text-slate-300">Mixed-use</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Next CTA */}
            <button className="w-full bg-[#5fd0e0] hover:bg-[#4bc0d0] text-[#0b1220] font-semibold text-sm py-2.5 px-4 rounded transition-colors flex items-center justify-between">
              <span>Mark complete</span>
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* MAIN CANVAS */}
      <div className="flex-1 flex flex-col min-w-0 bg-[#0b1220]">
        <div className="px-6 py-5 border-b border-[#1e2a3a] shrink-0 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Layers className="text-[#5fd0e0]" size={20} />
            <h2 className="text-lg font-medium text-white">Understand <span className="text-slate-500 font-normal ml-2">— Layer in the constraints that shape this site</span></h2>
          </div>
          <button className="text-xs font-medium text-[#5fd0e0] bg-[#5fd0e0]/10 border border-[#5fd0e0]/30 px-3 py-1.5 rounded hover:bg-[#5fd0e0]/20 transition-colors flex items-center gap-2">
            <RefreshCw size={14} />
            Generate Layers
          </button>
        </div>

        <div className="flex-1 flex min-h-0 overflow-hidden relative">
          {/* Scrollable Center Content */}
          <div className="flex-1 flex flex-col overflow-y-auto custom-scrollbar">
            
            {/* CONSTRAINT DECK */}
            <div className="p-6 shrink-0">
              <div className="space-y-6">
                
                {/* Local Group */}
                <div>
                  <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3 flex items-center gap-2">
                    <MapPin size={12} /> Local Data
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <LayerCard 
                      active={activeLayers.zoning} 
                      onClick={() => toggleLayer('zoning')}
                      title="Zoning (Grand County)" 
                      fact="R-2 Multifamily, 35' max, 20/10/15 setbacks"
                      time="2h ago"
                      color="bg-purple-500"
                    />
                    <LayerCard 
                      active={activeLayers.parcel} 
                      onClick={() => toggleLayer('parcel')}
                      title="Utah/UGRC Parcel" 
                      fact="Owner: Redd Holdings LLC, APN 01-0123-4567"
                      time="1d ago"
                      color="bg-cyan-500"
                    />
                  </div>
                </div>

                {/* Federal Group */}
                <div>
                  <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3 flex items-center gap-2">
                    <Globe size={12} /> Federal Data
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <LayerCard 
                      active={activeLayers.flood} 
                      onClick={() => toggleLayer('flood')}
                      title="FEMA Flood" 
                      fact="Zone X (minimal risk), Panel 49019C0455D"
                      time="1w ago"
                      color="bg-blue-500"
                    />
                    <LayerCard 
                      active={activeLayers.topo} 
                      onClick={() => toggleLayer('topo')}
                      title="USGS Topo" 
                      fact="4,025 ft elev, 3.2% avg slope"
                      time="1w ago"
                      color="bg-green-500"
                    />
                    <LayerCard 
                      active={activeLayers.ejscreen} 
                      onClick={() => toggleLayer('ejscreen')}
                      title="EPA EJScreen" 
                      fact="42nd %ile environmental burden"
                      time="2w ago"
                      color="bg-orange-500"
                    />
                    <LayerCard 
                      active={activeLayers.broadband} 
                      onClick={() => toggleLayer('broadband')}
                      title="FCC Broadband" 
                      fact="1 Gbps fiber available"
                      time="1m ago"
                      color="bg-rose-500"
                    />
                  </div>
                </div>

                {/* Manual Group */}
                <div>
                  <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3 flex items-center gap-2">
                    <Database size={12} /> Manual Uploads
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <LayerCard 
                      active={activeLayers.qgis} 
                      onClick={() => toggleLayer('qgis')}
                      title="Historic Aerial (1947)" 
                      fact="uploaded by jane@firm.com"
                      time="3d ago"
                      color="bg-amber-700"
                      isManual
                    />
                    <button className="border border-dashed border-[#1e2a3a] hover:border-[#5fd0e0]/50 hover:bg-[#5fd0e0]/5 rounded-lg flex flex-col items-center justify-center p-3 text-slate-400 hover:text-[#5fd0e0] transition-colors h-full min-h-[72px]">
                      <Upload size={16} className="mb-1" />
                      <span className="text-xs font-medium">Upload QGIS</span>
                    </button>
                  </div>
                </div>

              </div>
            </div>

            {/* LIVE COMBINED PREVIEW */}
            <div className="px-6 pb-6 flex-1 flex flex-col min-h-[400px]">
              <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">Live Combined Preview</div>
              <div className="flex-1 bg-[#0f1729] rounded-lg border border-[#1e2a3a] overflow-hidden relative group">
                
                {/* Fake 2D Map Base */}
                <div className="absolute inset-0 bg-[#080d17] overflow-hidden">
                  {/* Grid lines / Roads */}
                  <svg className="absolute inset-0 w-full h-full opacity-20" xmlns="http://www.w3.org/2000/svg">
                    <defs>
                      <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
                        <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#5fd0e0" strokeWidth="0.5"/>
                      </pattern>
                    </defs>
                    <rect width="100%" height="100%" fill="url(#grid)" />
                    <path d="M 0,150 Q 200,160 400,120 T 800,200" fill="none" stroke="#1e2a3a" strokeWidth="12" />
                    <path d="M 250,0 L 280,400" fill="none" stroke="#1e2a3a" strokeWidth="8" />
                  </svg>

                  {/* Layers */}
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="relative w-64 h-64">
                      
                      {/* Base Parcel Highlight */}
                      <svg className="absolute inset-0 w-full h-full overflow-visible pointer-events-none" viewBox="0 0 100 100">
                        <polygon points="20,10 80,20 90,80 30,90" 
                          fill={activeLayers.parcel ? "rgba(95,208,224,0.1)" : "rgba(255,255,255,0.02)"} 
                          stroke={activeLayers.parcel ? "#5fd0e0" : "#1e2a3a"} 
                          strokeWidth={activeLayers.parcel ? "2" : "1"} />
                        
                        {/* Overlays */}
                        {activeLayers.flood && (
                          <polygon points="10,40 100,60 100,100 10,100" fill="rgba(59, 130, 246, 0.2)" stroke="rgba(59, 130, 246, 0.4)" strokeWidth="1" />
                        )}
                        {activeLayers.ejscreen && (
                          <rect x="0" y="0" width="100" height="100" fill="rgba(249, 115, 22, 0.15)" />
                        )}
                        {activeLayers.topo && (
                          <g stroke="rgba(74, 222, 128, 0.4)" strokeWidth="0.5" fill="none">
                            <path d="M 0,20 Q 50,30 100,10" />
                            <path d="M 0,40 Q 50,50 100,30" />
                            <path d="M 0,60 Q 50,70 100,50" />
                            <path d="M 0,80 Q 50,90 100,70" />
                          </g>
                        )}
                        {activeLayers.zoning && (
                          <polygon points="20,10 80,20 90,80 30,90" fill="rgba(168, 85, 247, 0.2)" />
                        )}
                        {activeLayers.qgis && (
                          <image href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMDAiIGhlaWdodD0iMTAwIj48cmVjdCB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgZmlsbD0iI2ZmZiIgZmlsbC1vcGFjaXR5PSIwLjA1Ii8+PC9zdmc+" x="0" y="0" width="100" height="100" style={{ mixBlendMode: 'overlay', opacity: 0.5 }} />
                        )}
                      </svg>

                      {/* Small Markers */}
                      {activeLayers.broadband && (
                        <div className="absolute top-10 left-10 w-2 h-2 rounded-full bg-rose-500 animate-pulse shadow-[0_0_10px_rgba(244,63,94,0.8)]" />
                      )}
                    </div>
                  </div>

                  {/* UI Hints on Map */}
                  <div className="absolute bottom-4 right-4 bg-[#0b1220]/80 backdrop-blur-sm border border-[#1e2a3a] px-2 py-1 rounded text-[10px] text-slate-400 font-mono">
                    100ft
                  </div>
                  <div className="absolute top-4 right-4 bg-[#0b1220]/80 backdrop-blur-sm border border-[#1e2a3a] w-8 h-8 rounded flex items-center justify-center text-slate-400 hover:text-white transition-colors cursor-pointer">
                    <Navigation2 size={16} className="transform rotate-45" />
                  </div>
                </div>

                <div className="absolute top-4 left-4 flex gap-2">
                  <div className="bg-[#0b1220]/90 border border-[#1e2a3a] rounded-lg p-1.5 flex gap-1 shadow-lg backdrop-blur-md">
                    <button className="px-3 py-1 bg-[#1e2a3a] text-white text-xs font-medium rounded shadow-sm">Map</button>
                    <button className="px-3 py-1 text-slate-400 hover:text-white text-xs font-medium rounded transition-colors">3D BIM</button>
                  </div>
                </div>

              </div>
            </div>

          </div>

          {/* RIGHT NARRATIVE SIDEBAR (Pinned) */}
          <div className="w-[280px] shrink-0 border-l border-[#1e2a3a] bg-[#0f1729] flex flex-col relative z-10 shadow-[-8px_0_24px_-8px_rgba(0,0,0,0.5)]">
            <div className="p-4 border-b border-[#1e2a3a]">
              <div className="text-[10px] font-bold text-[#5fd0e0] uppercase tracking-widest mb-1 flex items-center gap-1.5">
                <FileText size={12} /> Narrative So Far
              </div>
              <p className="text-xs text-slate-400 leading-relaxed mt-2">
                Auto-generated synthesis based on your active constraints.
              </p>
            </div>
            
            <div className="p-4 flex-1 overflow-y-auto">
              <div className="prose prose-invert prose-sm">
                <p className="text-sm text-slate-300 leading-relaxed">
                  The subject property is a <strong>0.38-acre mixed-use lot</strong> under the jurisdiction of <strong>Grand County, UT</strong>.
                </p>
                {activeLayers.zoning && (
                  <p className="text-sm text-slate-300 leading-relaxed mt-3 border-l-2 border-purple-500 pl-3">
                    Zoned <strong>R-2 Multifamily</strong>, allowing up to 35 feet in height. Front setbacks are 20ft, with 10ft side and 15ft rear.
                  </p>
                )}
                {activeLayers.flood && (
                  <p className="text-sm text-slate-300 leading-relaxed mt-3 border-l-2 border-blue-500 pl-3">
                    Located in <strong>FEMA Zone X</strong> (minimal flood risk), indicating standard drainage requirements apply without elevated base flood elevations.
                  </p>
                )}
                {activeLayers.topo && (
                  <p className="text-sm text-slate-300 leading-relaxed mt-3 border-l-2 border-green-500 pl-3">
                    The site sits at an elevation of <strong>4,025 feet</strong> with a relatively flat <strong>3.2% average slope</strong>, favorable for slab-on-grade construction.
                  </p>
                )}
                {!activeLayers.zoning && !activeLayers.flood && !activeLayers.topo && (
                  <p className="text-sm text-slate-500 italic mt-4">
                    Toggle constraint layers to build the site narrative.
                  </p>
                )}
              </div>
            </div>

            <div className="p-4 border-t border-[#1e2a3a] bg-[#0b1220]">
              <button className="w-full bg-[#1e2a3a] hover:bg-[#2a3b52] text-white border border-[#2a3b52] font-medium text-sm py-2 px-4 rounded transition-colors flex items-center justify-center gap-2">
                <Download size={14} />
                Push to Revit
              </button>
            </div>
          </div>

        </div>
      </div>

      {/* RIGHT VIEWS RAIL (Unified) */}
      <div className="w-[180px] shrink-0 border-l border-[#1e2a3a] bg-[#080d17] flex flex-col z-20 shadow-2xl overflow-y-auto">
        <div className="p-4 py-5 border-b border-[#1e2a3a]">
          <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">Views</div>
        </div>
        <div className="p-2 space-y-1">
          <button className="w-full flex items-center gap-3 px-3 py-2 rounded text-slate-400 hover:text-white hover:bg-[#1e2a3a]/50 transition-all text-sm text-left">
            <RadioReceiver size={16} /> Snapshots
          </button>
          
          {/* Active Combined Entry */}
          <button className="w-full flex items-center gap-3 px-3 py-2.5 rounded bg-[#5fd0e0]/10 text-[#5fd0e0] font-medium text-sm text-left shadow-[inset_2px_0_0_0_#5fd0e0]">
            <MapIcon size={16} /> Site Workspace
          </button>
          
          <button className="w-full flex items-center gap-3 px-3 py-2 rounded text-slate-400 hover:text-white hover:bg-[#1e2a3a]/50 transition-all text-sm text-left">
            <Box size={16} /> BIM Model
          </button>
          <button className="w-full flex items-center justify-between px-3 py-2 rounded text-slate-400 hover:text-white hover:bg-[#1e2a3a]/50 transition-all text-sm text-left">
            <div className="flex items-center gap-3"><FileText size={16} /> Findings</div>
            <span className="bg-[#1e2a3a] text-xs px-1.5 rounded text-white">4</span>
          </button>
          <button className="w-full flex items-center gap-3 px-3 py-2 rounded text-slate-400 hover:text-white hover:bg-[#1e2a3a]/50 transition-all text-sm text-left">
            <Layers size={16} /> Submissions
          </button>
        </div>
        
        {/* BIM Model Context Hint */}
        <div className="mt-auto p-4 m-2 border border-[#1e2a3a] rounded bg-[#0b1220]">
          <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">BIM Sync</div>
          <div className="text-xs text-slate-400 mb-1 flex items-center gap-2">
            <Building2 size={12} /> 101 elements
          </div>
          <div className="text-xs text-slate-500">
            15 sheets · 7 levels<br/>
            Synced 18 hr ago
          </div>
        </div>
      </div>

    </div>
  );
}

function LayerCard({ 
  title, 
  fact, 
  time, 
  active, 
  onClick, 
  color, 
  isManual = false 
}: { 
  title: string, 
  fact: string, 
  time: string, 
  active: boolean, 
  onClick: () => void,
  color: string,
  isManual?: boolean
}) {
  return (
    <div 
      onClick={onClick}
      className={`relative group cursor-pointer border rounded-lg p-3 transition-all duration-200 overflow-hidden flex flex-col min-h-[72px] ${
        active 
          ? 'bg-[#1e2a3a]/40 border-[#5fd0e0]/40 shadow-[0_4px_20px_-4px_rgba(95,208,224,0.1)]' 
          : 'bg-[#0f1729] border-[#1e2a3a] hover:border-[#334155]'
      }`}
    >
      {/* Active Color Bar */}
      {active && <div className={`absolute top-0 left-0 bottom-0 w-1 ${color}`} />}
      
      <div className="flex justify-between items-start mb-1 pl-1">
        <div className="flex items-center gap-2">
          <div className={`w-3 h-3 rounded-[3px] border flex items-center justify-center transition-colors ${
            active ? 'bg-[#5fd0e0] border-[#5fd0e0]' : 'border-slate-500 group-hover:border-slate-400'
          }`}>
            {active && <Check size={10} className="text-[#0b1220]" strokeWidth={3} />}
          </div>
          <span className={`text-xs font-semibold truncate ${active ? 'text-white' : 'text-slate-300'}`}>{title}</span>
        </div>
        <div className="flex items-center gap-2 text-slate-500">
          <span className="text-[10px]">{time}</span>
          {!isManual && (
            <button onClick={(e) => { e.stopPropagation(); }} className="hover:text-[#5fd0e0] transition-colors">
              <RefreshCw size={12} />
            </button>
          )}
        </div>
      </div>
      
      <div className={`text-xs pl-5 line-clamp-2 ${active ? 'text-slate-300' : 'text-slate-500'}`}>
        {fact}
      </div>
    </div>
  );
}
