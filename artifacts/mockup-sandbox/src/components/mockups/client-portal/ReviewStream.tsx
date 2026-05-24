import React from "react";
import {
  Search,
  Bell,
  Menu,
  MessageSquare,
  Sparkles,
  ChevronRight,
  Maximize2,
  ExternalLink,
  ThumbsUp,
  Heart,
  Smile,
  MapPin,
  Clock,
  FileText,
  Image as ImageIcon,
  Box,
  Send,
  Paperclip,
  CheckCircle2,
  AlertCircle
} from "lucide-react";

export function ReviewStream() {
  return (
    <div className="w-full h-screen flex flex-col font-sans overflow-hidden" style={{ backgroundColor: "#f5f1eb", color: "#0b1220" }}>
      {/* Top Nav */}
      <header className="flex-shrink-0 h-16 bg-white border-b px-6 flex items-center justify-between z-10" style={{ borderColor: "#d9d2c5" }}>
        <div className="flex items-center gap-4">
          <div className="font-semibold text-lg tracking-tight">Redd Mixed-Use</div>
          <span className="text-xs font-medium px-2 py-1 rounded-full bg-slate-100 text-slate-600">
            Phase: Design Review v3
          </span>
          <div className="h-4 w-px bg-slate-200 mx-2" />
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <img src="/client-portal-avatar-maria.png" alt="Maria" className="w-6 h-6 rounded-full object-cover" />
            <span>Maria posted 3 new updates since your last visit &middot; 5 of your questions are still open</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {['All', 'Unread (3)', 'Needs reply (5)', 'Renders only', 'Sheets only', '3D only'].map((filter, i) => (
            <button
              key={i}
              className={`text-xs px-3 py-1.5 rounded-full transition-colors ${
                i === 0 ? 'bg-slate-800 text-white' : 'bg-transparent text-slate-600 hover:bg-slate-100'
              }`}
            >
              {filter}
            </button>
          ))}
        </div>
      </header>

      {/* Main Layout */}
      <div className="flex-1 flex overflow-hidden">
        
        {/* LEFT timeline / quick-jump rail */}
        <aside className="w-[240px] flex-shrink-0 border-r overflow-y-auto" style={{ borderColor: "#d9d2c5" }}>
          <div className="p-4 space-y-6">
            <div>
              <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Today</h3>
              <ul className="space-y-3">
                <li className="flex items-start gap-2 group cursor-pointer">
                  <div className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0" style={{ backgroundColor: "#c2613d" }} />
                  <div>
                    <div className="text-sm font-medium text-slate-900 group-hover:text-blue-700 transition-colors">Dusk exterior render</div>
                    <div className="text-xs text-slate-500">2 hr ago</div>
                  </div>
                </li>
                <li className="flex items-start gap-2 group cursor-pointer">
                  <div className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0" style={{ backgroundColor: "#c2613d" }} />
                  <div>
                    <div className="text-sm font-medium text-slate-900 group-hover:text-blue-700 transition-colors">Sheet A3.1 updated</div>
                    <div className="text-xs text-slate-500">4 hr ago</div>
                  </div>
                </li>
                <li className="flex items-start gap-2 group cursor-pointer">
                  <div className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 bg-transparent" />
                  <div>
                    <div className="text-sm font-medium text-slate-700 group-hover:text-blue-700 transition-colors">Hero exterior · golden hour</div>
                    <div className="text-xs text-slate-500">18 hr ago</div>
                  </div>
                </li>
              </ul>
            </div>

            <div>
              <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Yesterday</h3>
              <ul className="space-y-3">
                <li className="flex items-start gap-2 group cursor-pointer">
                  <div className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 bg-transparent" />
                  <div>
                    <div className="text-sm font-medium text-slate-700 group-hover:text-blue-700 transition-colors">Entry plaza 3D view</div>
                    <div className="text-xs text-slate-500">1 d ago</div>
                  </div>
                </li>
              </ul>
            </div>

            <div className="pt-6 border-t" style={{ borderColor: "#d9d2c5" }}>
              <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Anchored Conversations</h3>
              <div className="text-xs text-slate-600 mb-2">3 unresolved</div>
              <ul className="space-y-2">
                <li className="text-xs p-2 rounded bg-orange-50 text-orange-800 border border-orange-100 flex items-start gap-2 cursor-pointer hover:bg-orange-100">
                  <AlertCircle className="w-3.5 h-3.5 text-orange-600 mt-0.5 flex-shrink-0" />
                  <span>Entry plaza shift 10ft south? (A1.1)</span>
                </li>
                <li className="text-xs p-2 rounded bg-yellow-50 text-yellow-800 border border-yellow-100 flex items-start gap-2 cursor-pointer hover:bg-yellow-100">
                  <MessageSquare className="w-3.5 h-3.5 text-yellow-600 mt-0.5 flex-shrink-0" />
                  <span>Widen lobby by 4ft? (A2.1)</span>
                </li>
              </ul>
            </div>
          </div>
        </aside>

        {/* MAIN feed */}
        <main className="flex-1 overflow-y-auto flex justify-center py-8 px-4 scroll-smooth">
          <div className="w-full max-w-[720px] space-y-12 pb-24">
            
            {/* 1. Render card */}
            <div className="bg-white rounded-xl shadow-sm border overflow-hidden" style={{ borderColor: "#d9d2c5" }}>
              <div className="p-4 flex gap-3">
                <img src="/client-portal-avatar-maria.png" alt="Maria" className="w-10 h-10 rounded-full object-cover shadow-sm" />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm">Maria Castaneda</span>
                    <span className="text-xs text-slate-400">· 2 hr ago</span>
                    <span className="text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full flex items-center gap-1"><ImageIcon className="w-3 h-3" /> posted a new rendering</span>
                  </div>
                  <p className="text-sm mt-1">Dusk version of the hero exterior — let me know if this feels right.</p>
                </div>
              </div>
              <div className="relative">
                <img src="/client-portal-dusk-render.png" alt="Dusk Render" className="w-full aspect-video object-cover" />
              </div>
              <div className="p-4 border-b" style={{ borderColor: "#f0ece5" }}>
                <div className="flex items-center gap-2">
                  <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-slate-50 hover:bg-slate-100 text-sm border border-slate-200 transition-colors">
                    <ThumbsUp className="w-4 h-4 text-slate-500" /> 
                    <span className="text-slate-600 font-medium">1</span>
                  </button>
                  <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-red-50 hover:bg-red-100 text-sm border border-red-100 transition-colors">
                    <Heart className="w-4 h-4 text-red-500" />
                    <span className="text-red-600 font-medium">1</span>
                  </button>
                  <div className="flex-1" />
                </div>
              </div>
              <div className="p-4 bg-slate-50/50 space-y-4">
                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 font-bold text-xs shadow-sm">J</div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm">James (You)</span>
                      <span className="text-xs text-slate-400">· 1 hr ago</span>
                    </div>
                    <p className="text-sm mt-0.5">Love it — what about a few palm trees on the west side?</p>
                  </div>
                </div>
                <div className="flex gap-3 items-start pt-2">
                  <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 font-bold text-xs shadow-sm mt-1">J</div>
                  <div className="flex-1 relative">
                    <input 
                      type="text" 
                      placeholder="Reply to Maria..." 
                      className="w-full pl-4 pr-24 py-2.5 bg-white border rounded-lg text-sm focus:outline-none focus:ring-2 shadow-sm"
                      style={{ borderColor: "#d9d2c5" }}
                    />
                    <div className="absolute right-2 top-2 flex items-center gap-1">
                      <button className="p-1 text-slate-400 hover:text-slate-600 rounded"><Paperclip className="w-4 h-4" /></button>
                      <button className="p-1 text-slate-400 hover:text-slate-600 rounded"><Smile className="w-4 h-4" /></button>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <button className="flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded text-purple-700 bg-purple-50 hover:bg-purple-100 border border-purple-100 transition-colors">
                        <Sparkles className="w-3 h-3" /> AI Assist
                      </button>
                      <button className="flex items-center gap-1 text-xs px-2.5 py-1 rounded text-slate-600 bg-white border hover:bg-slate-50 transition-colors shadow-sm" style={{ borderColor: "#d9d2c5" }}>
                        Generate variation · 1 credit
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* 2. Sheet card */}
            <div className="bg-white rounded-xl shadow-sm border overflow-hidden" style={{ borderColor: "#d9d2c5" }}>
              <div className="p-4 flex gap-3">
                <img src="/client-portal-avatar-maria.png" alt="Maria" className="w-10 h-10 rounded-full object-cover shadow-sm" />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm">Maria Castaneda</span>
                    <span className="text-xs text-slate-400">· 1 d ago</span>
                    <span className="text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full flex items-center gap-1"><FileText className="w-3 h-3" /> updated Sheet A3.1 Elevations</span>
                  </div>
                  <p className="text-sm mt-1">Added some detail to the north elevation based on our chat.</p>
                </div>
              </div>
              <div className="relative bg-slate-100 p-6 border-y" style={{ borderColor: "#f0ece5" }}>
                <div className="aspect-[4/3] bg-white shadow-md border rounded p-4 relative" style={{ borderColor: "#e2e8f0" }}>
                  {/* Fake sheet linework */}
                  <div className="w-full h-full border-2 border-slate-200 p-2 flex flex-col">
                    <div className="flex-1 border border-slate-200 relative">
                      <div className="absolute top-1/2 left-1/4 w-1/2 h-1/3 border-2 border-slate-300 flex flex-col justify-end p-2">
                        <div className="w-full flex justify-between px-4">
                          <div className="w-8 h-12 border border-slate-300 relative">
                            {/* The markup red circle */}
                            <div className="absolute -inset-2 border-2 border-red-500 rounded-[50%] z-10 animate-pulse opacity-80" />
                          </div>
                          <div className="w-8 h-12 border border-slate-300" />
                          <div className="w-8 h-12 border border-slate-300" />
                        </div>
                      </div>
                      
                      {/* Callout bubble */}
                      <div className="absolute top-1/3 left-1/2 bg-white shadow-lg border rounded-lg p-2 max-w-[200px] z-20 text-xs flex gap-2 items-start" style={{ borderColor: "#d9d2c5" }}>
                        <img src="/client-portal-avatar-maria.png" alt="Maria" className="w-5 h-5 rounded-full mt-0.5" />
                        <div>
                          <div className="font-medium">Maria</div>
                          <div className="text-slate-600">Yes, can do — see render v3</div>
                        </div>
                      </div>
                    </div>
                    <div className="h-8 mt-2 border border-slate-200 flex items-center justify-end px-2 text-[10px] text-slate-400 font-mono">
                      A3.1 ELEVATIONS
                    </div>
                  </div>
                </div>
                <div className="absolute top-4 right-4 flex gap-2">
                  <button className="flex items-center gap-1.5 px-3 py-1.5 bg-white text-sm font-medium rounded-lg shadow-sm border hover:bg-slate-50 transition-colors" style={{ borderColor: "#d9d2c5" }}>
                    <Maximize2 className="w-4 h-4" /> Open in markup view
                  </button>
                </div>
              </div>
              <div className="p-4 bg-slate-50/50 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex -space-x-2">
                    <div className="w-6 h-6 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 font-bold text-[10px] shadow-sm border border-white">J</div>
                    <img src="/client-portal-avatar-maria.png" className="w-6 h-6 rounded-full object-cover shadow-sm border border-white" />
                  </div>
                  <span className="text-sm text-slate-600 font-medium">1 comment · <span className="text-green-600 flex items-center gap-1 inline-flex"><CheckCircle2 className="w-3 h-3" /> Resolved</span></span>
                </div>
                <button className="text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors">View thread</button>
              </div>
            </div>

            {/* 3. 3D Card */}
            <div className="bg-white rounded-xl shadow-sm border overflow-hidden" style={{ borderColor: "#d9d2c5" }}>
              <div className="p-4 flex gap-3">
                <img src="/client-portal-avatar-maria.png" alt="Maria" className="w-10 h-10 rounded-full object-cover shadow-sm" />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm">Maria Castaneda</span>
                    <span className="text-xs text-slate-400">· 1 d ago</span>
                    <span className="text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full flex items-center gap-1"><Box className="w-3 h-3" /> posted a 3D view</span>
                  </div>
                  <p className="text-sm mt-1">View from the entry plaza — does this scale feel right?</p>
                </div>
              </div>
              <div className="relative group">
                <img src="/client-portal-3d-plaza.png" alt="3D Plaza" className="w-full aspect-video object-cover opacity-90 group-hover:opacity-100 transition-opacity" />
                <div className="absolute inset-0 flex items-center justify-center bg-slate-900/10 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button className="flex items-center gap-2 bg-slate-900/80 text-white px-5 py-2.5 rounded-full font-medium backdrop-blur-sm shadow-lg transform hover:scale-105 transition-all">
                    <Maximize2 className="w-4 h-4" /> Tour in 3D
                  </button>
                </div>
                <div className="absolute top-4 left-4">
                  <button className="bg-white/90 backdrop-blur-sm text-slate-800 p-2 rounded shadow-sm border border-white/20 hover:bg-white transition-colors" title="Drop a pin">
                    <MapPin className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <div className="p-4 bg-slate-50/50 space-y-4">
                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-700 font-bold text-xs shadow-sm">S</div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm">Sarah</span>
                      <span className="text-xs text-slate-400">· 6 hr ago</span>
                      <span className="text-[10px] font-bold uppercase tracking-wider text-yellow-600 bg-yellow-100 px-1.5 py-0.5 rounded">Open</span>
                    </div>
                    <p className="text-sm mt-0.5">What's the ceiling material here?</p>
                    <div className="mt-2">
                      <button className="text-xs font-medium text-slate-500 hover:text-slate-800 transition-colors flex items-center gap-1"><MessageSquare className="w-3 h-3" /> Reply</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

          </div>
        </main>

        {/* RIGHT sidebar */}
        <aside className="w-[300px] flex-shrink-0 bg-white border-l overflow-y-auto" style={{ borderColor: "#d9d2c5" }}>
          <div className="p-5 space-y-8">
            
            {/* Waiting on you */}
            <div>
              <h2 className="text-sm font-bold flex items-center gap-2 mb-4">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: "#c2613d" }} />
                What's waiting on you (5)
              </h2>
              <div className="space-y-3">
                {[
                  { title: "Can we shift the entry plaza 10 ft south for better afternoon shade?", meta: "A1.1 · 3d ago", urgent: true },
                  { title: "Lobby feels narrow on plan — possible to widen by 4 ft?", meta: "A2.1 · 2d ago" },
                  { title: "What's the ceiling material here?", meta: "3D View · 6hr ago" },
                  { title: "Can we see a dusk version?", meta: "Render · 4hr ago" }
                ].map((q, i) => (
                  <div key={i} className="group cursor-pointer rounded-lg p-3 bg-slate-50 border border-transparent hover:border-slate-200 hover:bg-slate-100 transition-all">
                    <div className="flex items-start gap-2">
                      {q.urgent ? <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" /> : <MessageSquare className="w-4 h-4 text-yellow-500 mt-0.5 flex-shrink-0" />}
                      <div>
                        <p className="text-sm leading-tight font-medium text-slate-800 line-clamp-2 group-hover:text-blue-700">{q.title}</p>
                        <p className="text-xs text-slate-500 mt-1">{q.meta}</p>
                      </div>
                    </div>
                  </div>
                ))}
                <button className="w-full py-2 text-sm font-medium text-slate-600 hover:text-slate-900 bg-slate-50 rounded border border-dashed border-slate-300 hover:border-slate-400 transition-colors">
                  View all
                </button>
              </div>
            </div>

            {/* AI Render mini-card */}
            <div className="rounded-xl border p-4 shadow-sm bg-gradient-to-br from-slate-50 to-white relative overflow-hidden" style={{ borderColor: "#d9d2c5" }}>
              <div className="absolute top-0 right-0 p-2 opacity-10">
                <Sparkles className="w-16 h-16" />
              </div>
              <h3 className="text-sm font-bold flex items-center gap-2 mb-1">
                <Sparkles className="w-4 h-4 text-purple-500" /> Generate a render
              </h3>
              <p className="text-xs text-slate-500 mb-4">Select an angle to generate a photoreal preview</p>
              
              <div className="space-y-2 mb-4">
                <button className="w-full text-left text-sm px-3 py-2 rounded bg-white border border-slate-200 hover:border-purple-300 hover:text-purple-700 transition-all shadow-sm">Golden hour exterior</button>
                <button className="w-full text-left text-sm px-3 py-2 rounded bg-white border border-slate-200 hover:border-purple-300 hover:text-purple-700 transition-all shadow-sm">Dusk approach</button>
                <button className="w-full text-left text-sm px-3 py-2 rounded bg-white border border-slate-200 hover:border-purple-300 hover:text-purple-700 transition-all shadow-sm">Lobby daylight</button>
              </div>

              <div className="flex items-center justify-between text-xs pt-3 border-t border-slate-200">
                <span className="text-slate-600 font-medium">Credits remaining</span>
                <span className="font-bold text-slate-800">12 / 20</span>
              </div>
              <div className="w-full h-1.5 bg-slate-200 rounded-full mt-1.5 overflow-hidden">
                <div className="h-full bg-purple-500 rounded-full" style={{ width: '60%' }} />
              </div>
            </div>

            {/* Activity timeline */}
            <div>
              <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4">Activity</h3>
              <div className="space-y-4">
                <div className="flex gap-3 text-sm">
                  <div className="w-6 h-6 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0">
                    <FileText className="w-3 h-3 text-slate-500" />
                  </div>
                  <div>
                    <span className="font-medium text-slate-800">Maria</span> uploaded <span className="font-medium text-slate-800">A3.1 v4</span>
                    <div className="text-xs text-slate-400 mt-0.5">2 hr ago</div>
                  </div>
                </div>
                <div className="flex gap-3 text-sm">
                  <div className="w-6 h-6 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0">
                    <MessageSquare className="w-3 h-3 text-slate-500" />
                  </div>
                  <div>
                    <span className="font-medium text-slate-800">Maria</span> responded to your pin
                    <div className="text-xs text-slate-400 mt-0.5">5 hr ago</div>
                  </div>
                </div>
              </div>
            </div>
            
            {/* Architect availability */}
            <div className="pt-6 border-t" style={{ borderColor: "#d9d2c5" }}>
              <div className="flex items-center gap-3">
                <div className="relative">
                  <img src="/client-portal-avatar-maria.png" alt="Maria" className="w-8 h-8 rounded-full object-cover" />
                  <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 rounded-full border-2 border-white" />
                </div>
                <div>
                  <div className="text-xs font-bold text-slate-800">Maria is online</div>
                  <div className="text-xs text-slate-500 flex items-center gap-1 mt-0.5">
                    <Clock className="w-3 h-3" /> Usually replies in 4 hr
                  </div>
                </div>
              </div>
            </div>

          </div>
        </aside>

      </div>
    </div>
  );
}
