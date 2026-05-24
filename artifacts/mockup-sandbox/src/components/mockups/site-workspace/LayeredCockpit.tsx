import React, { useState } from "react";
import {
  Map,
  Box,
  Layers,
  Eye,
  EyeOff,
  GripVertical,
  Plus,
  Upload,
  RefreshCw,
  Share,
  Info,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Navigation,
  Compass,
  FileBox,
  Building2,
  FolderTree,
  MapPin,
  CheckCircle2,
  AlertCircle
} from "lucide-react";

export function LayeredCockpit() {
  const [activeView, setActiveView] = useState("2D Map");

  return (
    <div className="flex h-[900px] w-[1280px] bg-[#0b1220] text-slate-300 font-sans overflow-hidden border border-[#1e2a3a]">
      {/* LEFT LAYER PALETTE */}
      <div className="w-[280px] flex flex-col border-r border-[#1e2a3a] bg-[#0f1729]">
        {/* Project Header */}
        <div className="p-4 border-b border-[#1e2a3a]">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
            <h1 className="text-slate-100 font-medium text-sm">Redd</h1>
            <span className="text-[10px] uppercase tracking-wider text-slate-500 border border-slate-700 px-1.5 rounded-sm">Active</span>
          </div>
          <p className="text-xs text-slate-400 truncate">143 E 100 N Moab UT 84532</p>
        </div>

        {/* View Mode Segmented Control */}
        <div className="p-3 border-b border-[#1e2a3a]">
          <div className="flex bg-[#0b1220] p-1 rounded-md border border-[#1e2a3a]">
            {["2D Map", "3D World", "BIM Model"].map((mode) => (
              <button
                key={mode}
                onClick={() => setActiveView(mode)}
                className={`flex-1 text-xs py-1.5 rounded-sm transition-colors ${
                  activeView === mode
                    ? "bg-[#1e2a3a] text-slate-100 font-medium shadow-sm"
                    : "text-slate-500 hover:text-slate-300"
                }`}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>

        {/* Layers List */}
        <div className="flex-1 overflow-y-auto p-3 space-y-4 text-sm custom-scrollbar">
          
          {/* BASE */}
          <div>
            <h2 className="text-[10px] uppercase tracking-widest text-slate-500 mb-2 font-semibold">Base</h2>
            <div className="space-y-0.5">
              <LayerRow name="Satellite Imagery" source="Mapbox" visible={false} />
              <LayerRow name="Dark Map Base" source="Mapbox" visible={true} opacity={100} active />
              <LayerRow name="Topography" source="USGS" visible={true} opacity={40} />
            </div>
          </div>

          {/* LOCAL */}
          <div>
            <h2 className="text-[10px] uppercase tracking-widest text-slate-500 mb-2 font-semibold">Local & State</h2>
            <div className="space-y-0.5">
              <LayerRow name="Parcel Boundary" source="UGRC" visible={true} opacity={100} selected />
              <LayerRow name="Zoning Code" source="Grand County" visible={true} opacity={60} />
            </div>
          </div>

          {/* FEDERAL */}
          <div>
            <h2 className="text-[10px] uppercase tracking-widest text-slate-500 mb-2 font-semibold">Federal</h2>
            <div className="space-y-0.5">
              <LayerRow name="FEMA Flood" source="FEMA" visible={false} />
              <LayerRow name="EJScreen Burden" source="EPA" visible={false} />
              <LayerRow name="Broadband Availability" source="FCC" visible={false} />
            </div>
          </div>

          {/* MANUAL */}
          <div>
            <h2 className="text-[10px] uppercase tracking-widest text-slate-500 mb-2 font-semibold">Manual Overlays</h2>
            <div className="space-y-0.5">
              <LayerRow name="1947 historic aerial.geotiff" source="jane@firm.com" visible={false} />
            </div>
          </div>

          {/* PROPOSED */}
          <div>
            <h2 className="text-[10px] uppercase tracking-widest text-slate-500 mb-2 font-semibold">Proposed</h2>
            <div className="space-y-0.5">
              <LayerRow name="BIM Footprint" source="Revit" visible={true} opacity={80} />
            </div>
          </div>

        </div>

        {/* Bottom Actions */}
        <div className="p-3 border-t border-[#1e2a3a] flex flex-col gap-2">
          <button className="flex items-center justify-center gap-2 w-full py-2 bg-[#1e2a3a] hover:bg-[#2a3a4f] text-slate-200 text-xs rounded transition-colors">
            <Plus className="w-3.5 h-3.5" /> Add Layer
          </button>
          <button className="flex items-center justify-center gap-2 w-full py-2 bg-transparent border border-[#1e2a3a] hover:border-slate-600 text-slate-400 text-xs rounded transition-colors">
            <Upload className="w-3.5 h-3.5" /> Upload QGIS
          </button>
        </div>
      </div>

      {/* CENTER CANVAS */}
      <div className="flex-1 relative bg-[#090e17] overflow-hidden flex flex-col">
        {/* Fake Map Elements */}
        <div className="absolute inset-0 z-0">
          {/* Base grid / map texture */}
          <div className="absolute inset-0 opacity-[0.03] bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-slate-400 via-[#090e17] to-[#090e17]" 
               style={{ backgroundSize: '40px 40px', backgroundImage: 'radial-gradient(circle at 2px 2px, rgba(255,255,255,0.4) 1px, transparent 0)' }} />
          
          {/* Road polylines */}
          <svg className="absolute inset-0 w-full h-full" xmlns="http://www.w3.org/2000/svg">
            <path d="M 0 400 Q 300 420 600 380 T 1200 450" fill="none" stroke="#1e2a3a" strokeWidth="4" />
            <path d="M 300 0 L 320 900" fill="none" stroke="#1e2a3a" strokeWidth="6" />
            <path d="M 600 0 L 580 900" fill="none" stroke="#1e2a3a" strokeWidth="2" />
            
            {/* Topo lines (greenish) */}
            <path d="M 0 200 Q 200 250 400 150 T 800 300 T 1200 200" fill="none" stroke="#10b981" strokeWidth="1" opacity="0.3" />
            <path d="M 0 250 Q 250 300 450 200 T 850 350 T 1200 250" fill="none" stroke="#10b981" strokeWidth="1" opacity="0.3" />
            <path d="M 0 300 Q 300 350 500 250 T 900 400 T 1200 300" fill="none" stroke="#10b981" strokeWidth="1" opacity="0.3" />

            {/* Zoning hatch (yellowish) */}
            <polygon points="400,300 700,280 750,500 450,550" fill="url(#zoning-hatch)" opacity="0.1" />
            <defs>
              <pattern id="zoning-hatch" width="8" height="8" patternTransform="rotate(45 0 0)" patternUnits="userSpaceOnUse">
                <line x1="0" y1="0" x2="0" y2="8" stroke="#eab308" strokeWidth="2" />
              </pattern>
            </defs>

            {/* Parcel Polygon (Cyan) */}
            <g transform="translate(500, 350)">
              <polygon points="0,0 120,-10 140,80 30,100" fill="rgba(95, 208, 224, 0.1)" stroke="#5fd0e0" strokeWidth="2" />
              {/* Fake BIM wireframe footprint */}
              <polygon points="20,10 100,5 110,60 30,70" fill="rgba(255, 255, 255, 0.05)" stroke="#94a3b8" strokeWidth="1" strokeDasharray="4 4" />
            </g>

            {/* Map markers */}
            <circle cx="550" cy="340" r="4" fill="#5fd0e0" />
            <circle cx="620" cy="450" r="3" fill="#eab308" opacity="0.6" />
          </svg>
        </div>

        {/* Top Floating Bar */}
        <div className="absolute top-4 left-4 right-4 flex justify-between items-start z-10 pointer-events-none">
          <div className="bg-[#0f1729]/90 backdrop-blur border border-[#1e2a3a] px-3 py-1.5 rounded-full flex items-center gap-2 pointer-events-auto shadow-lg">
            <MapPin className="w-3.5 h-3.5 text-slate-400" />
            <span className="text-xs text-slate-300">Moab, UT <span className="text-slate-600 px-1">&middot;</span> Grand County <span className="text-slate-600 px-1">&middot;</span> Lot 4 of Block 12</span>
          </div>

          <div className="flex gap-2 pointer-events-auto">
            <button className="bg-[#0f1729]/90 backdrop-blur border border-[#1e2a3a] hover:border-slate-500 text-xs px-3 py-1.5 rounded flex items-center gap-1.5 transition-colors text-slate-300">
              <Layers className="w-3.5 h-3.5" /> Generate layers
            </button>
            <button className="bg-[#0f1729]/90 backdrop-blur border border-[#1e2a3a] hover:border-slate-500 text-xs px-3 py-1.5 rounded flex items-center gap-1.5 transition-colors text-slate-300">
              <RefreshCw className="w-3.5 h-3.5" /> Refresh all
            </button>
            <button className="bg-[#5fd0e0]/10 border border-[#5fd0e0]/30 hover:bg-[#5fd0e0]/20 text-[#5fd0e0] text-xs px-3 py-1.5 rounded flex items-center gap-1.5 transition-colors">
              <Share className="w-3.5 h-3.5" /> Push to Revit
            </button>
          </div>
        </div>

        {/* Bottom Floating Controls */}
        <div className="absolute bottom-4 right-4 flex flex-col gap-2 z-10">
          <button className="bg-[#0f1729]/90 backdrop-blur border border-[#1e2a3a] hover:border-slate-500 text-[10px] uppercase tracking-widest px-3 py-1.5 rounded-full transition-colors text-slate-400 font-semibold shadow-lg">
            Reset View
          </button>
          <div className="bg-[#0f1729]/90 backdrop-blur border border-[#1e2a3a] rounded flex flex-col shadow-lg">
            <button className="p-2 text-slate-400 hover:text-slate-200 hover:bg-[#1e2a3a] transition-colors border-b border-[#1e2a3a]">
              <ZoomIn className="w-4 h-4" />
            </button>
            <button className="p-2 text-slate-400 hover:text-slate-200 hover:bg-[#1e2a3a] transition-colors">
              <ZoomOut className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Scale & Compass */}
        <div className="absolute bottom-4 left-4 flex items-center gap-4 z-10 pointer-events-none">
          <div className="bg-[#0f1729]/80 backdrop-blur border border-[#1e2a3a] rounded-full p-1.5 shadow-lg">
            <Compass className="w-4 h-4 text-slate-400" />
          </div>
          <div className="flex flex-col gap-1">
            <div className="w-24 border-b-2 border-l-2 border-r-2 border-slate-500 h-2 opacity-50" />
            <span className="text-[10px] text-slate-500 font-mono">100 ft</span>
          </div>
        </div>
      </div>

      {/* RIGHT INSPECTOR */}
      <div className="w-[320px] bg-[#0f1729] border-l border-[#1e2a3a] flex flex-col">
        <div className="p-4 border-b border-[#1e2a3a] flex items-center justify-between bg-[#0b1220]">
          <h2 className="text-sm font-medium text-slate-200 flex items-center gap-2">
            <Info className="w-4 h-4 text-[#5fd0e0]" /> Inspecting: Parcel
          </h2>
        </div>

        <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
          {/* Identity Block */}
          <div className="mb-6">
            <h3 className="text-xl font-light text-slate-100 mb-1">APN 01-0123-4567</h3>
            <p className="text-xs text-[#5fd0e0] font-mono">Redd Holdings LLC</p>
          </div>

          <div className="space-y-5">
            {/* Stats Grid */}
            <div className="grid grid-cols-2 gap-3">
              <Stat label="Lot Area" value="0.38 acres" sub="16,553 sq ft" />
              <div className="p-3 bg-[#0b1220] rounded border border-[#1e2a3a]">
                <div className="text-[10px] uppercase text-slate-500 mb-1">Type</div>
                <div className="text-sm text-slate-200">Mixed-use res</div>
              </div>
            </div>

            {/* Zoning Card */}
            <div className="border border-[#1e2a3a] rounded-md bg-[#0b1220] overflow-hidden">
              <div className="px-3 py-2 border-b border-[#1e2a3a] bg-[#151f32] flex items-center justify-between">
                <span className="text-xs font-medium text-slate-300">Zoning Constraints</span>
                <span className="text-[10px] text-slate-500 bg-[#0b1220] px-1.5 rounded border border-[#1e2a3a]">Grand County</span>
              </div>
              <div className="p-3 space-y-3">
                <div className="flex justify-between items-end">
                  <div>
                    <div className="text-[10px] uppercase text-slate-500">Zone Code</div>
                    <div className="text-sm text-slate-200">R-2 Multifamily</div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] uppercase text-slate-500">Max Height</div>
                    <div className="text-sm text-[#eab308]">35 ft</div>
                  </div>
                </div>
                <div className="border-t border-[#1e2a3a] pt-3">
                  <div className="text-[10px] uppercase text-slate-500 mb-2">Required Setbacks</div>
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-400">Front: <span className="text-slate-200 font-mono">20'</span></span>
                    <span className="text-slate-400">Side: <span className="text-slate-200 font-mono">10'</span></span>
                    <span className="text-slate-400">Rear: <span className="text-slate-200 font-mono">15'</span></span>
                  </div>
                </div>
              </div>
            </div>

            {/* Context Summary */}
            <div>
              <div className="text-[10px] uppercase text-slate-500 mb-2 tracking-widest font-semibold">Active Context</div>
              <div className="space-y-2">
                <ContextItem icon={<Navigation className="w-3.5 h-3.5 text-blue-400" />} label="FEMA Flood" value="Zone X (minimal risk)" />
                <ContextItem icon={<Map className="w-3.5 h-3.5 text-green-400" />} label="USGS Topo" value="4,025 ft el, 3.2% slope" />
                <ContextItem icon={<AlertCircle className="w-3.5 h-3.5 text-orange-400" />} label="EPA EJScreen" value="42nd %ile burden" />
                <ContextItem icon={<CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />} label="FCC Broadband" value="1 Gbps fiber" />
              </div>
            </div>

            {/* BIM Hook */}
            <div className="mt-8 pt-6 border-t border-[#1e2a3a]">
              <div className="text-[10px] uppercase text-slate-500 mb-3 tracking-widest font-semibold">Building on this site &rarr;</div>
              <div className="group border border-[#1e2a3a] hover:border-[#5fd0e0]/50 rounded-md bg-[#0b1220] p-3 transition-colors cursor-pointer relative overflow-hidden">
                <div className="absolute top-0 right-0 p-2 opacity-10">
                  <Building2 className="w-16 h-16" />
                </div>
                <div className="relative z-10">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="p-1.5 bg-[#1e2a3a] rounded text-slate-300 group-hover:text-[#5fd0e0] transition-colors">
                      <Building2 className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="text-sm font-medium text-slate-200">Revit Model</div>
                      <div className="text-[10px] text-slate-500">Synced 18 hr ago</div>
                    </div>
                  </div>
                  <div className="flex gap-3 text-xs text-slate-400 mt-3">
                    <span>101 Elements</span>
                    <span>15 Sheets</span>
                    <span>7 Levels</span>
                  </div>
                  <div className="mt-3 text-[#5fd0e0] text-xs font-medium flex items-center gap-1 opacity-0 group-hover:opacity-100 transform translate-x-[-10px] group-hover:translate-x-0 transition-all">
                    Switch to BIM view <ChevronRight className="w-3.5 h-3.5" />
                  </div>
                </div>
              </div>
            </div>

          </div>
        </div>
      </div>

      {/* RIGHT VIEWS RAIL */}
      <div className="w-[64px] bg-[#0b1220] border-l border-[#1e2a3a] flex flex-col items-center py-4 gap-6 shrink-0 z-20">
        <div className="w-8 h-8 rounded bg-[#1e2a3a] flex items-center justify-center mb-4">
          <FolderTree className="w-4 h-4 text-slate-300" />
        </div>
        
        <RailItem icon={<Box />} label="Workspace" active />
        <RailItem icon={<Layers />} label="Snapshots" />
        <RailItem icon={<FileBox />} label="Sheets" />
        <RailItem icon={<AlertCircle />} label="Findings" badge="4" />
        <RailItem icon={<CheckCircle2 />} label="Submits" />
      </div>

      <style dangerouslySetInnerHTML={{__html: `
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #1e2a3a;
          border-radius: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #334155;
        }
      `}} />
    </div>
  );
}

function LayerRow({ name, source, visible, opacity, active, selected }: any) {
  return (
    <div className={`group flex items-center gap-2 py-1.5 px-2 rounded cursor-pointer transition-colors ${selected ? 'bg-[#1e2a3a]' : 'hover:bg-[#1e2a3a]/50'}`}>
      <div className="cursor-grab opacity-30 hover:opacity-100 transition-opacity flex-shrink-0">
        <GripVertical className="w-3.5 h-3.5 text-slate-400" />
      </div>
      <button className={`flex-shrink-0 transition-colors ${visible ? 'text-slate-300' : 'text-slate-600'}`}>
        {visible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
      </button>
      <div className="flex-1 min-w-0 flex items-center justify-between gap-2">
        <span className={`text-xs truncate ${visible ? 'text-slate-200' : 'text-slate-500'} ${active ? 'font-medium text-[#5fd0e0]' : ''}`}>
          {name}
        </span>
        <span className="text-[9px] uppercase tracking-wider text-slate-500 bg-[#0b1220] px-1 rounded flex-shrink-0 border border-[#1e2a3a]">{source}</span>
      </div>
      {visible && opacity !== undefined && (
        <div className="w-12 h-1 bg-[#0b1220] rounded-full overflow-hidden flex-shrink-0 hidden group-hover:block border border-[#1e2a3a]">
          <div className="h-full bg-slate-500" style={{ width: `${opacity}%` }} />
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: any) {
  return (
    <div className="p-3 bg-[#0b1220] rounded border border-[#1e2a3a]">
      <div className="text-[10px] uppercase text-slate-500 mb-1">{label}</div>
      <div className="text-sm text-slate-200">{value}</div>
      {sub && <div className="text-[10px] text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function ContextItem({ icon, label, value }: any) {
  return (
    <div className="flex items-start gap-2.5 p-2 hover:bg-[#1e2a3a]/30 rounded transition-colors border border-transparent hover:border-[#1e2a3a]">
      <div className="mt-0.5">{icon}</div>
      <div>
        <div className="text-xs font-medium text-slate-300">{label}</div>
        <div className="text-xs text-slate-500">{value}</div>
      </div>
    </div>
  );
}

function RailItem({ icon, label, active, badge }: any) {
  return (
    <button className={`relative flex flex-col items-center gap-1.5 group w-full`}>
      <div className={`p-2 rounded-xl transition-all ${
        active 
          ? 'bg-[#1e2a3a] text-[#5fd0e0] shadow-sm' 
          : 'text-slate-500 hover:text-slate-300 hover:bg-[#1e2a3a]/50'
      }`}>
        {React.cloneElement(icon, { className: 'w-5 h-5' })}
      </div>
      <span className={`text-[9px] uppercase tracking-widest transition-colors ${
        active ? 'text-[#5fd0e0]' : 'text-slate-600 group-hover:text-slate-400'
      }`}>
        {label}
      </span>
      {badge && (
        <div className="absolute top-0 right-2 bg-red-500/20 border border-red-500/50 text-red-400 text-[9px] font-bold px-1.5 rounded-full">
          {badge}
        </div>
      )}
    </button>
  );
}
