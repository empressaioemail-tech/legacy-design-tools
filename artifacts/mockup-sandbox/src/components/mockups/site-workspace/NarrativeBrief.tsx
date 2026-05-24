import React from "react";
import { 
  MapPin, 
  Pencil, 
  Map as MapIcon, 
  ExternalLink, 
  Layers, 
  RefreshCw, 
  Upload, 
  ArrowUp,
  MapPinned,
  Waves,
  Mountain,
  Leaf,
  Wifi,
  FileText,
  FileBox,
  Box,
  HardHat,
  History,
  Info,
  CheckCircle2,
  AlertTriangle,
  Building2
} from "lucide-react";

export function NarrativeBrief() {
  return (
    <div className="flex h-[900px] w-[1280px] bg-[#0b1220] text-slate-300 font-sans overflow-hidden">
      
      {/* LEFT RAIL - Document Outline */}
      <div className="w-48 flex-shrink-0 border-r border-[#1e2a3a] bg-[#0f1729] p-6 flex flex-col gap-6">
        <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-2">Outline</div>
        <nav className="flex flex-col gap-4 text-sm font-medium">
          <a href="#identity" className="text-[#5fd0e0] flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-[#5fd0e0]"></div>
            Identity
          </a>
          <a href="#location" className="text-slate-400 hover:text-slate-200 transition-colors flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-transparent border border-slate-500"></div>
            Location
          </a>
          <a href="#constraints" className="text-slate-400 hover:text-slate-200 transition-colors flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-transparent border border-slate-500"></div>
            Constraints
          </a>
          <a href="#proposed" className="text-slate-400 hover:text-slate-200 transition-colors flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-transparent border border-slate-500"></div>
            Proposed
          </a>
        </nav>
      </div>

      {/* MAIN SCROLLABLE CONTENT */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden scroll-smooth" id="scroll-container">
        <div className="max-w-3xl mx-auto py-12 px-8 flex flex-col gap-16">
          
          {/* 1. IDENTITY */}
          <section id="identity" className="flex flex-col gap-6">
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-3 mb-2">
                  <h1 className="text-4xl font-bold text-white tracking-tight">Redd</h1>
                  <span className="px-2 py-0.5 rounded text-[10px] uppercase font-bold tracking-wider bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Active</span>
                </div>
                <div className="flex items-center gap-2 text-slate-400">
                  <MapPin className="w-4 h-4" />
                  <span>143 E 100 N Moab UT 84532 · Moab, UT</span>
                  <button className="p-1 hover:bg-slate-800 rounded text-slate-500 hover:text-white transition-colors">
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-6 p-6 rounded-lg bg-[#0f1729] border border-[#1e2a3a]">
              <div className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-widest text-slate-500">Jurisdiction</span>
                <span className="text-sm font-medium text-slate-200">Grand County, UT</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-widest text-slate-500">Project Type</span>
                <span className="text-sm font-medium text-slate-200">Mixed-use residential</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-widest text-slate-500">Lot Area</span>
                <span className="text-sm font-medium text-slate-200">0.38 acres / 16,553 sq ft</span>
              </div>
            </div>
            
            <p className="text-slate-400 text-sm leading-relaxed border-l-2 border-[#5fd0e0] pl-4">
              <span className="text-slate-200 font-medium">What we're looking at:</span> A 0.38-acre mixed-use development site situated in downtown Moab. 
              The parcel is under R-2 Multifamily zoning, presenting minor environmental constraints with high utility accessibility.
            </p>
          </section>

          {/* 2. LOCATION */}
          <section id="location" className="flex flex-col gap-4 pt-4 border-t border-[#1e2a3a]">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold text-white flex items-center gap-2">
                <MapIcon className="w-5 h-5 text-[#5fd0e0]" />
                Location
              </h2>
              <a href="#" className="text-xs text-[#5fd0e0] hover:text-white flex items-center gap-1 transition-colors">
                Open in Google Maps
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>

            {/* Map Fake */}
            <div className="w-full h-[600px] rounded-lg border border-[#1e2a3a] bg-[#0a0f18] relative overflow-hidden flex items-center justify-center">
              {/* Fake road lines */}
              <div className="absolute inset-0 opacity-20" style={{
                backgroundImage: 'linear-gradient(45deg, transparent 48%, #1e2a3a 48%, #1e2a3a 52%, transparent 52%), linear-gradient(-45deg, transparent 48%, #1e2a3a 48%, #1e2a3a 52%, transparent 52%)',
                backgroundSize: '100px 100px'
              }}></div>
              
              {/* Fake parcel polygon */}
              <div className="relative z-10 w-64 h-48 border-2 border-[#5fd0e0] bg-[#5fd0e0]/10 rounded shadow-[0_0_15px_rgba(95,208,224,0.2)] transform rotate-3 flex items-center justify-center group cursor-pointer hover:bg-[#5fd0e0]/20 transition-all">
                <div className="absolute -top-3 -right-3 w-6 h-6 rounded-full bg-[#0f1729] border border-[#5fd0e0] flex items-center justify-center text-[#5fd0e0]">
                  <MapPin className="w-3 h-3" />
                </div>
              </div>

              {/* Map chrome */}
              <div className="absolute bottom-4 left-4 bg-[#0f1729]/80 backdrop-blur border border-[#1e2a3a] px-3 py-1.5 rounded text-xs text-slate-400 font-mono">
                38.5746° N, -109.5498° W
              </div>
              <div className="absolute bottom-4 right-4 flex items-center gap-2">
                <div className="w-8 h-8 rounded bg-[#0f1729]/80 backdrop-blur border border-[#1e2a3a] flex items-center justify-center text-xs font-bold text-slate-400">N</div>
                <div className="bg-[#0f1729]/80 backdrop-blur border border-[#1e2a3a] px-3 py-1.5 rounded flex items-center gap-2">
                  <div className="w-12 h-1 bg-slate-600"></div>
                  <span className="text-[10px] text-slate-400">100ft</span>
                </div>
              </div>
            </div>
          </section>

          {/* 3. CONSTRAINTS */}
          <section id="constraints" className="flex flex-col gap-6 pt-4 border-t border-[#1e2a3a]">
            <div className="flex flex-col gap-4">
              <div className="flex items-end justify-between">
                <div>
                  <h2 className="text-xl font-semibold text-white flex items-center gap-2 mb-1">
                    <Layers className="w-5 h-5 text-[#5fd0e0]" />
                    Constraints & Context
                  </h2>
                  <p className="text-sm text-slate-400">Environmental, zoning, and physical parameters.</p>
                </div>
                <div className="flex items-center gap-2">
                  <button className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#1e2a3a] hover:bg-[#2a3a4f] text-xs font-medium text-white transition-colors">
                    <Layers className="w-3.5 h-3.5" />
                    Generate layers
                  </button>
                  <button className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-[#1e2a3a] hover:bg-[#1e2a3a] text-xs font-medium text-slate-300 transition-colors">
                    <RefreshCw className="w-3.5 h-3.5" />
                    Refresh
                  </button>
                  <button className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-[#1e2a3a] hover:bg-[#1e2a3a] text-xs font-medium text-slate-300 transition-colors">
                    <Upload className="w-3.5 h-3.5" />
                    Upload QGIS
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                {/* Zoning */}
                <div className="bg-[#0f1729] border border-[#1e2a3a] rounded-lg p-4 flex flex-col gap-3 group">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <div className="p-1.5 bg-[#5fd0e0]/10 rounded text-[#5fd0e0]">
                        <MapPinned className="w-4 h-4" />
                      </div>
                      <span className="text-sm font-semibold text-slate-200">Zoning (Grand County)</span>
                    </div>
                    <span className="text-[10px] text-slate-500">Auto-synced</span>
                  </div>
                  <div className="text-sm text-white">
                    <div className="font-medium mb-1">R-2 Multifamily</div>
                    <div className="text-slate-400 text-xs">35 ft max height · 20/10/15 ft front/side/rear setbacks</div>
                  </div>
                  <a href="#location" className="text-[10px] uppercase tracking-wider text-[#5fd0e0] opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 mt-1 w-fit">
                    View on map <ArrowUp className="w-3 h-3" />
                  </a>
                </div>

                {/* FEMA Flood */}
                <div className="bg-[#0f1729] border border-[#1e2a3a] rounded-lg p-4 flex flex-col gap-3 group">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <div className="p-1.5 bg-blue-500/10 rounded text-blue-400">
                        <Waves className="w-4 h-4" />
                      </div>
                      <span className="text-sm font-semibold text-slate-200">FEMA Flood</span>
                    </div>
                    <span className="text-[10px] text-slate-500">FEMA · Oct 2023</span>
                  </div>
                  <div className="text-sm text-white">
                    <div className="font-medium mb-1 text-emerald-400 flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5"/> Zone X (minimal risk)</div>
                    <div className="text-slate-400 text-xs">Panel 49019C0455D</div>
                  </div>
                  <a href="#location" className="text-[10px] uppercase tracking-wider text-[#5fd0e0] opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 mt-1 w-fit">
                    View on map <ArrowUp className="w-3 h-3" />
                  </a>
                </div>

                {/* USGS Topo */}
                <div className="bg-[#0f1729] border border-[#1e2a3a] rounded-lg p-4 flex flex-col gap-3 group">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <div className="p-1.5 bg-emerald-500/10 rounded text-emerald-400">
                        <Mountain className="w-4 h-4" />
                      </div>
                      <span className="text-sm font-semibold text-slate-200">USGS Topography</span>
                    </div>
                    <span className="text-[10px] text-slate-500">USGS · 10m DEM</span>
                  </div>
                  <div className="text-sm text-white">
                    <div className="font-medium mb-1">4,025 ft elevation</div>
                    <div className="text-slate-400 text-xs">3.2% avg slope (gentle)</div>
                  </div>
                  <a href="#location" className="text-[10px] uppercase tracking-wider text-[#5fd0e0] opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 mt-1 w-fit">
                    View on map <ArrowUp className="w-3 h-3" />
                  </a>
                </div>

                {/* EPA EJScreen */}
                <div className="bg-[#0f1729] border border-[#1e2a3a] rounded-lg p-4 flex flex-col gap-3 group">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <div className="p-1.5 bg-orange-500/10 rounded text-orange-400">
                        <Leaf className="w-4 h-4" />
                      </div>
                      <span className="text-sm font-semibold text-slate-200">EPA EJScreen</span>
                    </div>
                    <span className="text-[10px] text-slate-500">EPA · 2023</span>
                  </div>
                  <div className="text-sm text-white">
                    <div className="font-medium mb-1 text-amber-400 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5"/> 42nd %ile burden</div>
                    <div className="text-slate-400 text-xs">Moderate environmental justice indicators</div>
                  </div>
                  <a href="#location" className="text-[10px] uppercase tracking-wider text-[#5fd0e0] opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 mt-1 w-fit">
                    View on map <ArrowUp className="w-3 h-3" />
                  </a>
                </div>

                {/* FCC Broadband */}
                <div className="bg-[#0f1729] border border-[#1e2a3a] rounded-lg p-4 flex flex-col gap-3 group">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <div className="p-1.5 bg-purple-500/10 rounded text-purple-400">
                        <Wifi className="w-4 h-4" />
                      </div>
                      <span className="text-sm font-semibold text-slate-200">FCC Broadband</span>
                    </div>
                    <span className="text-[10px] text-slate-500">FCC · Dec 2023</span>
                  </div>
                  <div className="text-sm text-white">
                    <div className="font-medium mb-1">1 Gbps fiber available</div>
                    <div className="text-slate-400 text-xs">Multiple high-speed providers</div>
                  </div>
                </div>

                {/* Utah/UGRC Parcel */}
                <div className="bg-[#0f1729] border border-[#1e2a3a] rounded-lg p-4 flex flex-col gap-3 group">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <div className="p-1.5 bg-slate-500/10 rounded text-slate-400">
                        <FileText className="w-4 h-4" />
                      </div>
                      <span className="text-sm font-semibold text-slate-200">Utah UGRC Parcel</span>
                    </div>
                    <span className="text-[10px] text-slate-500">State DB</span>
                  </div>
                  <div className="text-sm text-white">
                    <div className="font-medium mb-1">Owner: Redd Holdings LLC</div>
                    <div className="text-slate-400 text-xs text-mono">APN 01-0123-4567</div>
                  </div>
                </div>

                {/* Manual QGIS */}
                <div className="bg-[#0f1729] border border-[#1e2a3a] rounded-lg p-4 flex flex-col gap-3 group col-span-2">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <div className="p-1.5 bg-pink-500/10 rounded text-pink-400">
                        <FileBox className="w-4 h-4" />
                      </div>
                      <span className="text-sm font-semibold text-slate-200">Manual QGIS Uploads</span>
                    </div>
                    <span className="text-[10px] text-slate-500">jane@firm.com · 2d ago</span>
                  </div>
                  <div className="text-sm flex items-center justify-between">
                    <div className="flex items-center gap-2 text-slate-300">
                      <Info className="w-4 h-4 text-slate-500" />
                      <span>1947 historic aerial.geotiff</span>
                    </div>
                    <a href="#location" className="text-[10px] uppercase tracking-wider text-[#5fd0e0] opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 w-fit">
                      View on map <ArrowUp className="w-3 h-3" />
                    </a>
                  </div>
                </div>

              </div>
            </div>
          </section>

          {/* 4. PROPOSED */}
          <section id="proposed" className="flex flex-col gap-4 pt-4 border-t border-[#1e2a3a] pb-24">
            <div className="flex items-end justify-between">
              <h2 className="text-xl font-semibold text-white flex items-center gap-2">
                <Box className="w-5 h-5 text-[#5fd0e0]" />
                Proposed Building
              </h2>
              <div className="flex items-center gap-3">
                <a href="#" className="text-xs text-slate-400 hover:text-white flex items-center gap-1.5 transition-colors">
                  <History className="w-3.5 h-3.5" />
                  View previous snapshot
                </a>
                <button className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#5fd0e0] hover:bg-[#4bc0d0] text-xs font-bold text-[#0b1220] transition-colors shadow-[0_0_10px_rgba(95,208,224,0.3)]">
                  <HardHat className="w-3.5 h-3.5" />
                  Push to Revit
                </button>
              </div>
            </div>

            {/* BIM Fake Viewer */}
            <div className="w-full h-[520px] rounded-lg border border-[#1e2a3a] bg-[#080d14] relative overflow-hidden group">
              {/* 3D Grid */}
              <div className="absolute inset-0" style={{
                backgroundImage: 'linear-gradient(rgba(30,42,58,0.3) 1px, transparent 1px), linear-gradient(90deg, rgba(30,42,58,0.3) 1px, transparent 1px)',
                backgroundSize: '40px 40px',
                transform: 'perspective(500px) rotateX(60deg) translateY(-100px) translateZ(-200px)',
                transformOrigin: 'top center'
              }}></div>

              {/* Fake BIM Masses */}
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex items-end gap-1 pb-12">
                <div className="w-24 h-48 bg-slate-700/80 border border-slate-500/50 shadow-2xl relative transform -skew-x-12">
                  <div className="absolute inset-x-0 top-0 h-4 bg-slate-600 border-b border-slate-500/50 transform -skew-x-12 -translate-y-4 translate-x-1"></div>
                  <div className="absolute inset-y-0 right-0 w-4 bg-slate-800 border-l border-slate-500/50 transform skew-y-12 translate-x-4 translate-y-1"></div>
                </div>
                <div className="w-32 h-32 bg-slate-700/80 border border-slate-500/50 shadow-2xl relative transform -skew-x-12">
                  <div className="absolute inset-x-0 top-0 h-4 bg-slate-600 border-b border-slate-500/50 transform -skew-x-12 -translate-y-4 translate-x-1"></div>
                  <div className="absolute inset-y-0 right-0 w-4 bg-slate-800 border-l border-slate-500/50 transform skew-y-12 translate-x-4 translate-y-1"></div>
                </div>
                <div className="w-16 h-64 bg-slate-700/80 border border-slate-500/50 shadow-2xl relative transform -skew-x-12">
                  <div className="absolute inset-x-0 top-0 h-4 bg-slate-600 border-b border-slate-500/50 transform -skew-x-12 -translate-y-4 translate-x-1"></div>
                  <div className="absolute inset-y-0 right-0 w-4 bg-slate-800 border-l border-slate-500/50 transform skew-y-12 translate-x-4 translate-y-1"></div>
                </div>
              </div>

              {/* Viewport Hints */}
              <div className="absolute top-4 left-0 right-0 text-center opacity-0 group-hover:opacity-100 transition-opacity">
                <span className="bg-[#0b1220]/80 backdrop-blur px-3 py-1.5 rounded-full text-[10px] text-slate-400 font-medium border border-[#1e2a3a]">
                  Drag to pan · Scroll to zoom · Right-drag to rotate
                </span>
              </div>

              {/* Stats overlay */}
              <div className="absolute bottom-4 left-4 right-4 flex items-center justify-between">
                <div className="bg-[#0f1729]/90 backdrop-blur border border-[#1e2a3a] px-4 py-2 rounded-lg flex items-center gap-6">
                  <div className="flex flex-col">
                    <span className="text-[10px] uppercase tracking-widest text-slate-500">Elements</span>
                    <span className="text-sm font-bold text-white">101</span>
                  </div>
                  <div className="w-px h-6 bg-[#1e2a3a]"></div>
                  <div className="flex flex-col">
                    <span className="text-[10px] uppercase tracking-widest text-slate-500">Composition</span>
                    <span className="text-sm font-medium text-slate-300">15sh / 7lv / 45w</span>
                  </div>
                </div>
                <div className="text-xs text-slate-500 flex items-center gap-1.5">
                  <RefreshCw className="w-3 h-3" />
                  Synced 18 hr ago
                </div>
              </div>
            </div>

          </section>

        </div>
      </div>

      {/* RIGHT RAIL - Views Chrome */}
      <div className="w-16 flex-shrink-0 border-l border-[#1e2a3a] bg-[#0a0f18] flex flex-col items-center py-4 gap-6">
        <div className="flex flex-col gap-4">
          <button className="w-10 h-10 rounded-lg flex items-center justify-center text-slate-500 hover:text-slate-300 hover:bg-[#1e2a3a] transition-all">
            <History className="w-5 h-5" />
          </button>
          <button className="w-10 h-10 rounded-lg flex items-center justify-center text-slate-500 hover:text-slate-300 hover:bg-[#1e2a3a] transition-all relative">
            <FileBox className="w-5 h-5" />
          </button>
          {/* Active merged workspace tab */}
          <div className="relative group">
            <button className="w-10 h-10 rounded-lg flex items-center justify-center bg-[#5fd0e0]/10 text-[#5fd0e0] border border-[#5fd0e0]/30 shadow-[0_0_10px_rgba(95,208,224,0.1)]">
              <Building2 className="w-5 h-5" />
            </button>
            <div className="absolute right-full mr-4 top-1/2 -translate-y-1/2 bg-[#1e2a3a] text-white text-xs px-2 py-1 rounded whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity">
              Site Workspace
            </div>
          </div>
          <button className="w-10 h-10 rounded-lg flex items-center justify-center text-slate-500 hover:text-slate-300 hover:bg-[#1e2a3a] transition-all">
            <HardHat className="w-5 h-5" />
          </button>
          <button className="w-10 h-10 rounded-lg flex items-center justify-center text-slate-500 hover:text-slate-300 hover:bg-[#1e2a3a] transition-all relative">
            <AlertTriangle className="w-5 h-5" />
            <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">4</div>
          </button>
        </div>
      </div>

    </div>
  );
}
