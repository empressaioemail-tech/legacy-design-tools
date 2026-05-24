import React, { useState } from "react";
import { 
  Camera, 
  MessageSquare, 
  Image as ImageIcon, 
  Layers, 
  Map, 
  ChevronRight, 
  Clock, 
  Sparkles, 
  RotateCcw, 
  Heart,
  FileText,
  PanelRightClose,
  PanelRightOpen,
  ArrowRight,
  MoreHorizontal
} from "lucide-react";

export function Showroom() {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="flex flex-col h-[900px] w-[1280px] bg-[#f5f1eb] text-[#0b1220] overflow-hidden font-sans relative">
      {/* TOP NAV */}
      <header className="flex-none h-14 bg-white/80 backdrop-blur-md border-b border-[#d9d2c5] flex items-center justify-between px-6 z-20">
        <div className="flex items-center gap-4">
          <div className="font-semibold text-lg tracking-tight">Redd Mixed-Use</div>
          <div className="text-xs text-muted-foreground">•</div>
          <div className="text-sm text-muted-foreground">Moab, UT</div>
          <div className="px-2 py-0.5 bg-[#f5f1eb] border border-[#d9d2c5] rounded-full text-xs font-medium text-muted-foreground">
            Phase: Design Review v3
          </div>
        </div>

        <nav className="flex items-center gap-1 bg-[#f5f1eb] p-1 rounded-full border border-[#d9d2c5]">
          <button className="px-4 py-1.5 rounded-full bg-white shadow-sm text-sm font-medium text-[#0a6a78] flex items-center gap-2">
            Tour
            <span className="bg-[#c2613d] text-white text-[10px] px-1.5 py-0.5 rounded-full leading-none font-bold">3 new</span>
          </button>
          <button className="px-4 py-1.5 rounded-full text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
            Sheets
          </button>
          <button className="px-4 py-1.5 rounded-full text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
            Renderings
          </button>
        </nav>

        <div className="flex items-center gap-4">
          <div className="flex flex-col items-end">
            <span className="text-xs font-medium">Maria Castaneda, AIA</span>
            <span className="text-[10px] text-muted-foreground">Cardinal Studio • Last update: 2 hr ago</span>
          </div>
          <div className="h-8 w-8 rounded-full bg-[#0a6a78] text-white flex items-center justify-center text-sm font-bold shadow-sm">
            MC
          </div>
        </div>
      </header>

      {/* MAIN CONTENT */}
      <main className="flex-1 flex flex-col min-h-0 relative">
        {/* HERO 3D AREA */}
        <section className="h-[55%] relative flex-none border-b border-[#d9d2c5] bg-gradient-to-b from-[#ffecd2] to-[#fcb69f] overflow-hidden">
          {/* Faux 3D Environment */}
          <div className="absolute inset-0 opacity-80 mix-blend-multiply">
             <svg width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 1280 500">
               {/* Desert floor */}
               <path d="M0,400 Q300,380 600,410 T1280,390 L1280,500 L0,500 Z" fill="#8a6c5b" opacity="0.4"/>
               <path d="M0,430 Q400,410 800,450 T1280,420 L1280,500 L0,500 Z" fill="#6d5345" opacity="0.6"/>
               
               {/* Building Silhouette */}
               <g transform="translate(400, 150)">
                 {/* Main volume */}
                 <rect x="0" y="50" width="450" height="250" fill="#1c2331" />
                 {/* Setbacks */}
                 <rect x="50" y="0" width="350" height="50" fill="#2a3441" />
                 <rect x="-20" y="150" width="100" height="150" fill="#2a3441" />
                 {/* Windows/Lobby glow */}
                 <rect x="20" y="200" width="410" height="100" fill="#ffecd2" opacity="0.1" />
                 <rect x="50" y="220" width="120" height="80" fill="#ffecd2" opacity="0.3" />
                 <rect x="200" y="70" width="40" height="100" fill="#ffecd2" opacity="0.2" />
                 <rect x="260" y="70" width="40" height="100" fill="#ffecd2" opacity="0.2" />
                 <rect x="320" y="70" width="40" height="100" fill="#ffecd2" opacity="0.2" />
               </g>
               
               {/* Trees */}
               <circle cx="300" cy="400" r="40" fill="#2a3441" opacity="0.8"/>
               <circle cx="340" cy="420" r="30" fill="#1c2331" opacity="0.9"/>
               <circle cx="950" cy="380" r="60" fill="#2a3441" opacity="0.8"/>
             </svg>
          </div>

          {/* Floating UI */}
          <div className="absolute top-4 left-6 bg-white/70 backdrop-blur-md px-3 py-1.5 rounded-md text-sm font-medium shadow-sm border border-white/50 text-[#0b1220]">
            Tour · Exterior approach
          </div>

          <div className="absolute top-4 right-6">
            <button className="bg-white/90 backdrop-blur-md hover:bg-white border border-white/50 px-4 py-2 rounded-full text-sm font-medium shadow-sm flex items-center gap-2 transition-all text-[#0b1220]">
              <Sparkles className="w-4 h-4 text-[#0a6a78]" />
              Render this view with AI
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider ml-1">1 credit</span>
            </button>
          </div>

          <div className="absolute bottom-6 left-6 flex items-center gap-3">
            <div className="bg-white/70 backdrop-blur-md p-1 rounded-full flex items-center shadow-sm border border-white/50">
              <button className="px-4 py-1.5 rounded-full bg-white shadow-sm text-sm font-medium text-[#0b1220]">Exterior</button>
              <button className="px-4 py-1.5 rounded-full text-sm font-medium text-[#0b1220]/70 hover:text-[#0b1220]">Lobby</button>
              <button className="px-4 py-1.5 rounded-full text-sm font-medium text-[#0b1220]/70 hover:text-[#0b1220] flex items-center gap-1.5">
                Aerial
                <span className="bg-[#0a6a78] text-white text-[9px] px-1.5 py-0.5 rounded-sm uppercase tracking-wider leading-none">New</span>
              </button>
              <button className="px-4 py-1.5 rounded-full text-sm font-medium text-[#0b1220]/70 hover:text-[#0b1220]">3D Walk</button>
            </div>
            <button className="h-9 w-9 rounded-full bg-white/70 backdrop-blur-md border border-white/50 flex items-center justify-center text-[#0b1220]/70 hover:text-[#0b1220] shadow-sm" title="Reset view">
              <RotateCcw className="w-4 h-4" />
            </button>
          </div>

          <div className="absolute bottom-6 right-6">
            <button className="bg-[#c2613d] hover:bg-[#b05837] text-white px-5 py-3 rounded-full text-sm font-bold shadow-lg flex items-center gap-2 transition-all transform hover:scale-105">
              <Camera className="w-4 h-4" />
              Capture this view & leave a note
            </button>
          </div>
        </section>

        {/* SCROLLING RAILS */}
        <section className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col gap-6 p-6 pb-20">
          
          {/* Sheets Rail */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold flex items-center gap-2">
                <FileText className="w-4 h-4 text-[#0a6a78]" />
                Sheets
              </h3>
            </div>
            <div className="flex gap-4 overflow-x-auto pb-4 -mb-4 snap-x">
              {[
                { num: "A0.0", name: "Cover sheet", count: 0 },
                { num: "A1.1", name: "Site plan", count: 1, active: true },
                { num: "A2.1", name: "Level 1 (lobby)", count: 1 },
                { num: "A3.1", name: "Elevations N+S", count: 1 },
                { num: "A4.1", name: "Building sections", count: 0 },
              ].map((sheet) => (
                <div key={sheet.num} className={`snap-start flex-none w-48 h-64 bg-white rounded-lg shadow-sm border ${sheet.active ? 'border-[#0a6a78] ring-1 ring-[#0a6a78]' : 'border-[#d9d2c5]'} p-3 flex flex-col cursor-pointer hover:border-[#0a6a78] transition-colors relative group`}>
                  <div className="flex-1 border border-[#d9d2c5]/50 bg-[#faf9f7] rounded flex items-center justify-center mb-3 relative overflow-hidden group-hover:bg-[#f5f1eb] transition-colors">
                    {/* Faux drawing lines */}
                    <svg className="w-full h-full opacity-20" viewBox="0 0 100 100" preserveAspectRatio="none">
                      <rect x="10" y="10" width="80" height="80" fill="none" stroke="currentColor" strokeWidth="2" />
                      <line x1="10" y1="30" x2="90" y2="30" stroke="currentColor" strokeWidth="1" />
                      <line x1="50" y1="30" x2="50" y2="90" stroke="currentColor" strokeWidth="1" />
                      <circle cx="30" cy="60" r="10" fill="none" stroke="currentColor" strokeWidth="1" />
                    </svg>
                  </div>
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="font-bold text-sm text-[#0a6a78]">{sheet.num}</div>
                      <div className="text-xs text-muted-foreground truncate w-32">{sheet.name}</div>
                    </div>
                  </div>
                  {sheet.count > 0 && (
                    <div className="absolute -top-2 -right-2 bg-[#c2613d] text-white text-[10px] font-bold px-2 py-0.5 rounded-full shadow-sm border border-white">
                      {sheet.count} {sheet.count === 1 ? 'pin' : 'pins'}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Renderings Rail */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold flex items-center gap-2">
                <ImageIcon className="w-4 h-4 text-[#0a6a78]" />
                Renderings
                <span className="text-muted-foreground font-normal text-xs ml-2">4 in gallery · 12 credits left this month</span>
              </h3>
            </div>
            <div className="flex gap-4 overflow-x-auto pb-4 -mb-4 snap-x">
              
              {/* Render 1 */}
              <div className="snap-start flex-none w-[340px] h-[220px] rounded-lg shadow-sm border border-[#d9d2c5] overflow-hidden relative group cursor-pointer">
                <div className="absolute inset-0 bg-gradient-to-tr from-[#ffecd2] to-[#fcb69f]"></div>
                <div className="absolute inset-0 bg-black/10 group-hover:bg-transparent transition-colors"></div>
                <div className="absolute top-3 right-3">
                  <Heart className="w-5 h-5 text-[#c2613d] fill-[#c2613d]" />
                </div>
                <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent p-4 pt-12">
                  <div className="text-white font-bold text-sm">Hero exterior · golden hour</div>
                  <div className="text-white/80 text-xs">4K · 18 hr ago</div>
                </div>
              </div>

              {/* Render 2 */}
              <div className="snap-start flex-none w-64 h-[220px] rounded-lg shadow-sm border border-[#d9d2c5] overflow-hidden relative group cursor-pointer bg-[#e0e8f5]">
                <div className="absolute inset-0 bg-black/10 group-hover:bg-transparent transition-colors"></div>
                <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent p-4 pt-12">
                  <div className="text-white font-bold text-sm">Lobby interior · daylight</div>
                  <div className="text-white/80 text-xs">4K · 14 hr ago</div>
                </div>
              </div>

              {/* Render 3 */}
              <div className="snap-start flex-none w-64 h-[220px] rounded-lg shadow-sm border border-[#d9d2c5] overflow-hidden relative group cursor-pointer bg-[#d5e8d4]">
                <div className="absolute inset-0 bg-black/10 group-hover:bg-transparent transition-colors"></div>
                <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent p-4 pt-12">
                  <div className="text-white font-bold text-sm">Aerial site context</div>
                  <div className="text-white/80 text-xs">1080p · 12 hr ago</div>
                </div>
              </div>

              {/* Render 4 - In Progress */}
              <div className="snap-start flex-none w-64 h-[220px] rounded-lg shadow-sm border border-[#d9d2c5] overflow-hidden relative bg-[#1c2331]">
                <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center">
                  <ImageIcon className="w-8 h-8 text-white/20 mb-4 animate-pulse" />
                  <div className="w-full bg-white/10 rounded-full h-1.5 mb-3 overflow-hidden">
                    <div className="bg-[#0a6a78] h-1.5 rounded-full w-[60%] animate-pulse"></div>
                  </div>
                  <div className="text-white font-bold text-sm">Street view · sunset</div>
                  <div className="text-[#0a6a78] text-xs font-medium mt-1">IN PROGRESS 60%</div>
                  <div className="text-white/50 text-[10px] mt-1">ETA 4 min</div>
                </div>
              </div>

              {/* Generate New */}
              <div className="snap-start flex-none w-64 h-[220px] rounded-lg border-2 border-dashed border-[#d9d2c5] bg-[#f5f1eb]/50 hover:bg-white hover:border-[#0a6a78]/50 transition-colors flex flex-col items-center justify-center p-6 text-center cursor-pointer group">
                <div className="w-12 h-12 rounded-full bg-white shadow-sm flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                  <Sparkles className="w-5 h-5 text-[#0a6a78]" />
                </div>
                <div className="font-bold text-sm text-[#0a6a78] mb-1">Generate new rendering</div>
                <div className="text-xs text-muted-foreground">Pick an angle · pick a mood · we'll create it</div>
              </div>

            </div>
          </div>
        </section>
      </main>

      {/* AI ASSIST PILL */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30">
        <button className="bg-[#0b1220] text-white px-5 py-3 rounded-full text-sm font-medium shadow-xl flex items-center gap-3 hover:bg-[#1a2b4c] transition-colors border border-white/10">
          <div className="w-6 h-6 rounded-full bg-white/20 flex items-center justify-center text-[10px] font-bold">MC</div>
          Maria just posted a new render based on your last note
          <ArrowRight className="w-4 h-4 ml-1 text-[#0a6a78]" />
        </button>
      </div>

      {/* RIGHT SIDE DRAWER */}
      <div className={`absolute top-14 right-0 bottom-0 bg-white border-l border-[#d9d2c5] shadow-2xl transition-all duration-300 ease-in-out z-40 flex flex-col ${drawerOpen ? 'w-80' : 'w-14'}`}>
        {/* Toggle Tab */}
        <button 
          onClick={() => setDrawerOpen(!drawerOpen)}
          className="absolute top-6 -left-4 w-8 h-12 bg-white border border-[#d9d2c5] border-r-0 rounded-l-md shadow-[-2px_2px_5px_rgba(0,0,0,0.02)] flex items-center justify-center text-muted-foreground hover:text-[#0b1220] z-50"
        >
          {drawerOpen ? <ChevronRight className="w-4 h-4" /> : <PanelRightOpen className="w-4 h-4" />}
          {!drawerOpen && (
            <div className="absolute -top-2 -right-1 bg-[#c2613d] text-white text-[10px] w-4 h-4 rounded-full flex items-center justify-center font-bold">
              5
            </div>
          )}
        </button>

        {drawerOpen ? (
          <>
            <div className="p-5 border-b border-[#d9d2c5]">
              <h2 className="font-bold text-lg flex items-center gap-2">
                <MessageSquare className="w-5 h-5 text-[#0a6a78]" />
                Conversation
              </h2>
              <p className="text-xs text-muted-foreground mt-1">5 active threads with Maria</p>
            </div>
            
            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-6">
              
              {/* Group 1 */}
              <div>
                <div className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-3 px-1 flex justify-between">
                  Waiting on you (3)
                  <div className="w-2 h-2 rounded-full bg-[#c2613d]"></div>
                </div>
                
                <div className="flex flex-col gap-3">
                  <div className="bg-[#f5f1eb] p-3 rounded-md border border-[#c2613d]/20 cursor-pointer hover:border-[#c2613d]/50 transition-colors">
                    <div className="flex items-start gap-2 mb-2">
                      <div className="w-2 h-2 rounded-full bg-[#c2613d] mt-1.5 flex-none"></div>
                      <div className="text-xs font-medium text-[#0b1220]">Can we shift the entry plaza 10 ft south for better afternoon shade?</div>
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground pl-4">
                      <span className="flex items-center gap-1"><FileText className="w-3 h-3"/> A1.1 Site plan</span>
                      <span>3d ago</span>
                    </div>
                    <div className="mt-3 pl-4 border-l-2 border-[#d9d2c5] ml-1.5">
                      <div className="text-xs text-muted-foreground"><span className="font-medium text-[#0a6a78]">Maria:</span> Studying — render coming</div>
                    </div>
                  </div>

                  <div className="bg-white p-3 rounded-md border border-[#d9d2c5] cursor-pointer hover:border-[#0a6a78]/50 transition-colors">
                    <div className="flex items-start gap-2 mb-2">
                      <div className="w-2 h-2 rounded-full bg-[#eab308] mt-1.5 flex-none"></div>
                      <div className="text-xs font-medium text-[#0b1220]">Lobby feels narrow on plan — possible to widen by 4 ft?</div>
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground pl-4">
                      <span className="flex items-center gap-1"><FileText className="w-3 h-3"/> A2.1 L1</span>
                      <span>2d ago</span>
                    </div>
                  </div>

                  <div className="bg-white p-3 rounded-md border border-[#d9d2c5] cursor-pointer hover:border-[#0a6a78]/50 transition-colors">
                    <div className="flex items-start gap-2 mb-2">
                      <div className="w-2 h-2 rounded-full bg-[#eab308] mt-1.5 flex-none"></div>
                      <div className="text-xs font-medium text-[#0b1220]">What's the ceiling material here?</div>
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground pl-4">
                      <span className="flex items-center gap-1"><Camera className="w-3 h-3"/> Lobby 3D</span>
                      <span>6h ago</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Group 2 */}
              <div>
                <div className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-3 px-1">
                  Waiting on Maria (2)
                </div>
                
                <div className="flex flex-col gap-3">
                  <div className="bg-white p-3 rounded-md border border-[#d9d2c5] opacity-70">
                    <div className="flex items-start gap-2 mb-2">
                      <div className="mt-0.5 text-[#0a6a78]"><Layers className="w-3.5 h-3.5"/></div>
                      <div className="text-xs font-medium text-[#0b1220]">Love these proportions! Make these bigger?</div>
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground pl-5 mb-2">
                      <span className="flex items-center gap-1"><FileText className="w-3 h-3"/> A3.1 Elev</span>
                      <span>1d ago</span>
                    </div>
                    <div className="pl-5 border-l-2 border-[#d9d2c5] ml-1.5">
                      <div className="text-xs text-muted-foreground"><span className="font-medium text-[#0a6a78]">Maria:</span> Yes, can do — see render v3</div>
                    </div>
                  </div>

                  <div className="bg-white p-3 rounded-md border border-[#d9d2c5] opacity-70">
                    <div className="flex items-start gap-2 mb-2">
                      <div className="w-2 h-2 rounded-full bg-[#eab308] mt-1.5 flex-none"></div>
                      <div className="text-xs font-medium text-[#0b1220]">This is gorgeous. Can we see a dusk version?</div>
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground pl-4">
                      <span className="flex items-center gap-1"><ImageIcon className="w-3 h-3"/> Render</span>
                      <span>4h ago</span>
                    </div>
                  </div>
                </div>
              </div>

            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center py-6 gap-6">
            <div className="relative">
              <MessageSquare className="w-5 h-5 text-muted-foreground" />
              <div className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-[#c2613d] rounded-full border border-white"></div>
            </div>
            <div className="w-6 h-px bg-[#d9d2c5]"></div>
            <div className="flex flex-col gap-4">
              <div className="w-8 h-8 rounded-full bg-[#f5f1eb] flex items-center justify-center text-muted-foreground relative">
                <span className="text-xs font-bold">1</span>
                <div className="absolute top-0 right-0 w-2 h-2 bg-[#c2613d] rounded-full border border-white"></div>
              </div>
              <div className="w-8 h-8 rounded-full bg-[#f5f1eb] flex items-center justify-center text-muted-foreground">
                <span className="text-xs font-bold">2</span>
              </div>
              <div className="w-8 h-8 rounded-full bg-[#f5f1eb] flex items-center justify-center text-muted-foreground relative">
                <span className="text-xs font-bold">3</span>
                <div className="absolute top-0 right-0 w-2 h-2 bg-[#eab308] rounded-full border border-white"></div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
