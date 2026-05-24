import React, { useState } from 'react';
import { 
  Search, Filter, ChevronDown, Sparkles, 
  CheckCircle2, XCircle, Clock, AlertTriangle,
  FileText, Box, Layers, RefreshCw, Send,
  ArrowRight, Image as ImageIcon, MapPin,
  ChevronRight, AlignLeft, Download
} from 'lucide-react';

export function SpecCatalog() {
  const [selectedSpec, setSelectedSpec] = useState('densglass');

  return (
    <div className="h-[900px] w-[1280px] flex bg-[#0b1220] text-slate-300 font-sans overflow-hidden border border-[#1e2a3a]">
      
      {/* VIEWS Navigation Rail (Chrome) */}
      <div className="w-16 bg-[#0f1729] border-r border-[#1e2a3a] flex flex-col items-center py-4 space-y-6 flex-shrink-0 z-20">
        <div className="w-8 h-8 rounded bg-blue-600/20 flex items-center justify-center text-blue-400 mb-4">
          <Box size={18} />
        </div>
        <div className="w-10 h-10 rounded-lg flex items-center justify-center text-slate-500 hover:bg-[#1e2a3a] hover:text-slate-300 cursor-pointer">
          <MapPin size={20} />
        </div>
        <div className="w-10 h-10 rounded-lg flex items-center justify-center text-slate-500 hover:bg-[#1e2a3a] hover:text-slate-300 cursor-pointer">
          <AlignLeft size={20} />
        </div>
        <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-[#1e2a3a] text-cyan-400 cursor-pointer border-l-2 border-[#5fd0e0]">
          <Layers size={20} />
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 relative">
        
        {/* Top Banner: Search & Filters */}
        <div className="h-16 border-b border-[#1e2a3a] bg-[#0f1729]/50 flex items-center px-6 gap-4 flex-shrink-0">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={18} />
            <input 
              type="text" 
              placeholder="Search 5 product specs · 5 callouts · 2 letters..." 
              className="w-full bg-[#0b1220] border border-[#1e2a3a] rounded-md py-1.5 pl-10 pr-4 text-sm text-slate-200 focus:outline-none focus:border-[#5fd0e0]"
            />
          </div>
          
          <div className="flex items-center gap-2">
            <FilterChip label="TYPE" value="All" />
            <FilterChip label="STATUS" value="All" />
            <FilterChip label="USED ON" value="Any" />
            <FilterChip label="SOURCE" value="Any" />
            <FilterChip label="CITED IN" value="Any" />
          </div>

          <div className="w-px h-6 bg-[#1e2a3a] mx-2"></div>

          <button className="flex items-center gap-2 bg-[#a78bfa]/10 text-[#a78bfa] border border-[#a78bfa]/30 px-3 py-1.5 rounded-md text-sm font-medium hover:bg-[#a78bfa]/20 transition-colors">
            <Sparkles size={14} />
            AI Suggestions (2)
          </button>
        </div>

        {/* Main Canvas: Table/Grid View */}
        <div className="flex-1 overflow-y-auto bg-[#0b1220] p-6 pb-24">
          <table className="w-full text-sm text-left border-collapse">
            <thead>
              <tr className="text-slate-500 border-b border-[#1e2a3a]">
                <th className="pb-3 pl-4 font-medium w-8"></th>
                <th className="pb-3 font-medium">NAME</th>
                <th className="pb-3 font-medium">SOURCE / MFG</th>
                <th className="pb-3 font-medium">ID</th>
                <th className="pb-3 font-medium">STATUS</th>
                <th className="pb-3 font-medium">LAST VERIFIED</th>
                <th className="pb-3 font-medium">CITED IN</th>
                <th className="pb-3 font-medium">USED ON</th>
                <th className="pb-3 font-medium text-right pr-4">ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {/* --- PRODUCT SPECS --- */}
              <tr className="border-b border-[#1e2a3a]/50">
                <td colSpan={9} className="py-4 pl-2 font-medium text-slate-300">
                  <div className="flex items-center gap-2">
                    <Box size={16} className="text-slate-500" />
                    Product Specs <span className="text-slate-600 ml-1">· 5</span>
                  </div>
                </td>
              </tr>
              
              <TableRow 
                type="product"
                name="DensGlass Sheathing" 
                source="Georgia-Pacific" 
                id="ESR-1006" 
                status="ACTIVE" 
                verified="2 hr ago" 
                cited={2} 
                used="4 wall types"
                isSelected={selectedSpec === 'densglass'}
                onClick={() => setSelectedSpec('densglass')}
              />
              <TableRow 
                type="product"
                name="Hardie Plank Lap Siding" 
                source="James Hardie" 
                id="ESR-2290" 
                status="ACTIVE" 
                verified="yesterday" 
                cited={1} 
                used="Elev A2.1"
              />
              <TableRow 
                type="product"
                name="TPO Roofing Membrane" 
                source="GAF" 
                id="ESR-1659" 
                status="ACTIVE" 
                verified="3 d ago" 
                cited={0} 
                used="Roof assembly"
              />
              
              {/* Withdrawn product - Red Glow */}
              <tr className="border-b border-[#1e2a3a]/50 bg-[#ef4444]/[0.02] hover:bg-[#1e2a3a]/30 cursor-pointer group transition-colors">
                <td className="py-3 pl-4 relative">
                  <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-[#ef4444]"></div>
                  <Box size={16} className="text-[#ef4444]" />
                </td>
                <td className="py-3 text-slate-200 font-medium">Old Window Sealant XYZ-200</td>
                <td className="py-3 text-slate-400">AcmeCo</td>
                <td className="py-3 text-slate-400 font-mono text-xs">ESR-1432</td>
                <td className="py-3"><StatusPill status="WITHDRAWN" /></td>
                <td className="py-3 text-slate-400">2 mo ago</td>
                <td className="py-3"><span className="bg-[#1e2a3a] text-slate-300 px-2 py-0.5 rounded text-xs">1 letter</span></td>
                <td className="py-3 text-slate-400">D-W-04</td>
                <td className="py-3 text-right pr-4">
                  <button className="text-xs bg-[#ef4444]/10 text-[#ef4444] border border-[#ef4444]/30 px-2 py-1 rounded hover:bg-[#ef4444]/20 flex items-center gap-1 ml-auto">
                    <AlertTriangle size={12} />
                    Find replacement
                  </button>
                </td>
              </tr>

              {/* AI Draft Product - Violet Glow */}
              <tr className="border-b border-[#1e2a3a]/50 bg-[#a78bfa]/[0.02] hover:bg-[#1e2a3a]/30 cursor-pointer group transition-colors">
                <td className="py-3 pl-4 relative">
                  <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-[#a78bfa]"></div>
                  <Sparkles size={16} className="text-[#a78bfa]" />
                </td>
                <td className="py-3 text-slate-200 font-medium flex items-center gap-2">
                  Tyvek HomeWrap
                </td>
                <td className="py-3 text-slate-400">DuPont</td>
                <td className="py-3 text-slate-400 font-mono text-xs">ESR-1993</td>
                <td className="py-3"><StatusPill status="PENDING REVIEW" /></td>
                <td className="py-3 text-slate-500">—</td>
                <td className="py-3"><span className="text-slate-600">—</span></td>
                <td className="py-3 text-slate-500">—</td>
                <td className="py-3 text-right pr-4">
                  <button className="text-xs bg-[#a78bfa]/10 text-[#a78bfa] border border-[#a78bfa]/30 px-2 py-1 rounded hover:bg-[#a78bfa]/20 flex items-center gap-1 ml-auto">
                    Review <ArrowRight size={12} />
                  </button>
                </td>
              </tr>

              {/* --- DETAIL CALLOUTS --- */}
              <tr className="border-b border-[#1e2a3a]/50">
                <td colSpan={9} className="pt-6 pb-2 pl-2 font-medium text-slate-300">
                  <div className="flex items-center gap-2">
                    <Layers size={16} className="text-slate-500" />
                    Detail Callouts <span className="text-slate-600 ml-1">· 5</span>
                  </div>
                </td>
              </tr>
              
              <TableRow 
                type="callout"
                name="Exterior 2x6 stud, R-21 batt..." 
                source="Manual" 
                id="W-A" 
                status="APPLIED" 
                verified="yesterday" 
                cited={1} 
                used="6 layers"
              />
              <TableRow 
                type="callout"
                name="Interior 2x4 stud, 5/8 gyp..." 
                source="Manual" 
                id="W-B" 
                status="APPLIED" 
                verified="2 d ago" 
                cited={0} 
                used="3 layers"
              />
              <TableRow 
                type="callout"
                name="Main entry + corridor doors..." 
                source="Manual" 
                id="DS-1" 
                status="PUSHED" 
                verified="4 hr ago" 
                cited={0} 
                used="12 rows"
              />
              <TableRow 
                type="callout"
                name="Footing to parapet at typical..." 
                source="AI Draft" 
                id="WS-12" 
                status="DRAFT" 
                verified="—" 
                cited={0} 
                used="Sheet A4"
              />
              <TableRow 
                type="callout"
                name="Lobby floor: terrazzo, walls:..." 
                source="Manual" 
                id="RF-LOBBY" 
                status="PENDING" 
                verified="—" 
                cited={0} 
                used="—"
              />

              {/* --- DELIVERABLE LETTERS --- */}
              <tr className="border-b border-[#1e2a3a]/50">
                <td colSpan={9} className="pt-6 pb-2 pl-2 font-medium text-slate-300">
                  <div className="flex items-center gap-2">
                    <FileText size={16} className="text-slate-500" />
                    Deliverable Letters <span className="text-slate-600 ml-1">· 2</span>
                  </div>
                </td>
              </tr>
              
              <TableRow 
                type="letter"
                name="Response to Grand County corrections..." 
                source="Maria" 
                id="Letter #2" 
                status="DRAFT" 
                verified="1 hr ago" 
                cited={14} 
                used="Sub #3"
              />
              <TableRow 
                type="letter"
                name="Response to Submission #2" 
                source="System" 
                id="Letter #1" 
                status="SENT" 
                verified="5 d ago" 
                cited={8} 
                used="Finding F-08"
              />

            </tbody>
          </table>
        </div>

        {/* Bottom Dock: "Letters" mini-bar */}
        <div className="absolute bottom-0 left-0 right-0 h-16 bg-[#0f1729]/95 backdrop-blur-sm border-t border-[#1e2a3a] flex items-center px-6 gap-4 z-10">
          <div className="text-xs font-medium text-slate-500 uppercase tracking-wider mr-2">Letters</div>
          
          <div className="flex gap-3">
            {/* Letter #2 */}
            <div className="flex flex-col justify-center bg-[#1e2a3a]/50 border border-[#1e2a3a] hover:border-[#5fd0e0]/50 rounded-lg px-4 py-2 cursor-pointer transition-colors w-64">
              <div className="flex justify-between items-center mb-1">
                <div className="flex items-center gap-2">
                  <FileText size={14} className="text-amber-500" />
                  <span className="text-sm font-medium text-slate-200 truncate">Letter #2</span>
                </div>
                <span className="text-[10px] text-amber-500 bg-amber-500/10 px-1.5 rounded">DRAFT</span>
              </div>
              <div className="w-full bg-[#0b1220] h-1.5 rounded-full overflow-hidden">
                <div className="bg-amber-500 h-full w-[70%]"></div>
              </div>
            </div>

            {/* Letter #1 */}
            <div className="flex flex-col justify-center bg-[#1e2a3a]/30 border border-[#1e2a3a] rounded-lg px-4 py-2 cursor-pointer w-64 opacity-70 hover:opacity-100 transition-opacity">
              <div className="flex justify-between items-center mb-1">
                <div className="flex items-center gap-2">
                  <FileText size={14} className="text-green-500" />
                  <span className="text-sm font-medium text-slate-300 truncate">Letter #1</span>
                </div>
                <span className="text-[10px] text-green-500 bg-green-500/10 px-1.5 rounded">SENT</span>
              </div>
              <div className="w-full bg-[#0b1220] h-1.5 rounded-full overflow-hidden">
                <div className="bg-green-500 h-full w-full"></div>
              </div>
            </div>

            {/* AI Draft */}
            <div className="flex flex-col justify-center bg-[#a78bfa]/10 border border-[#a78bfa]/30 rounded-lg px-4 py-2 cursor-pointer w-64">
              <div className="flex justify-between items-center mb-1">
                <div className="flex items-center gap-2">
                  <Sparkles size={14} className="text-[#a78bfa]" />
                  <span className="text-sm font-medium text-[#a78bfa] truncate">Cover for Sub #3</span>
                </div>
                <span className="text-[10px] text-[#a78bfa] bg-[#a78bfa]/20 px-1.5 rounded">AI DRAFT</span>
              </div>
              <div className="w-full bg-[#0b1220] h-1.5 rounded-full overflow-hidden">
                <div className="bg-[#a78bfa] h-full w-[20%] opacity-50"></div>
              </div>
            </div>
          </div>
          
          <div className="ml-auto">
             <button className="flex items-center gap-2 bg-[#1e2a3a] hover:bg-[#1e2a3a]/80 border border-[#1e2a3a] px-3 py-1.5 rounded-md text-sm font-medium text-slate-300 transition-colors">
               + New Letter
             </button>
          </div>
        </div>

      </div>

      {/* Right Drawer (Spec Detail) */}
      {selectedSpec === 'densglass' && (
        <div className="w-[360px] bg-[#0f1729] border-l border-[#1e2a3a] flex flex-col flex-shrink-0 z-20 shadow-2xl relative shadow-black/50">
          
          {/* Header */}
          <div className="p-6 border-b border-[#1e2a3a]">
            <div className="flex justify-between items-start mb-4">
              <div className="w-12 h-12 rounded bg-slate-800 flex items-center justify-center border border-[#1e2a3a]">
                <ImageIcon size={20} className="text-slate-500" />
              </div>
              <div className="flex gap-2">
                <span className="flex items-center gap-1 bg-green-500/10 text-green-500 text-xs px-2 py-1 rounded font-medium">
                  <CheckCircle2 size={12} /> Active
                </span>
              </div>
            </div>
            
            <h2 className="text-lg font-semibold text-white mb-1">DensGlass Sheathing</h2>
            <div className="flex items-center gap-2 text-sm text-slate-400 mb-4">
              <span>Georgia-Pacific</span>
              <span>·</span>
              <span className="font-mono text-xs text-slate-300 bg-[#1e2a3a] px-1.5 py-0.5 rounded">ESR-1006</span>
            </div>

            <div className="flex items-center justify-between bg-[#0b1220] border border-[#1e2a3a] rounded-md p-3">
              <div className="flex items-center gap-2 text-xs">
                <Clock size={14} className="text-green-500" />
                <span className="text-slate-300">Verified 2 hr ago</span>
              </div>
              <button className="text-xs text-cyan-400 hover:text-cyan-300 font-medium flex items-center gap-1">
                <RefreshCw size={12} /> Re-verify
              </button>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex px-4 border-b border-[#1e2a3a] gap-6 text-sm">
            <button className="py-3 text-cyan-400 border-b-2 border-cyan-400 font-medium">Overview</button>
            <button className="py-3 text-slate-400 hover:text-slate-300">Used in (4)</button>
            <button className="py-3 text-slate-400 hover:text-slate-300">History</button>
          </div>

          {/* Drawer Content */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            
            {/* Overview sections */}
            <div>
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Cited in letters</h3>
              <div className="space-y-2">
                <div className="flex items-center justify-between bg-[#1e2a3a]/50 p-2.5 rounded border border-[#1e2a3a]">
                  <div className="flex items-center gap-2">
                    <FileText size={14} className="text-amber-500" />
                    <span className="text-sm text-slate-300">Letter #2</span>
                  </div>
                  <button className="text-xs bg-[#0b1220] hover:bg-[#1e2a3a] text-slate-300 px-2 py-1 rounded border border-[#1e2a3a]">
                    Open
                  </button>
                </div>
                <div className="flex items-center justify-between bg-[#1e2a3a]/50 p-2.5 rounded border border-[#1e2a3a]">
                  <div className="flex items-center gap-2">
                    <FileText size={14} className="text-green-500" />
                    <span className="text-sm text-slate-300">Letter #1</span>
                  </div>
                  <button className="text-xs bg-[#0b1220] hover:bg-[#1e2a3a] text-slate-300 px-2 py-1 rounded border border-[#1e2a3a]">
                    Open
                  </button>
                </div>
              </div>
            </div>

            <div>
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Used in callouts</h3>
              <div className="grid grid-cols-2 gap-2">
                {[1,2,3,4].map(i => (
                  <div key={i} className="bg-[#1e2a3a]/30 p-2.5 rounded border border-[#1e2a3a] hover:border-[#5fd0e0]/30 cursor-pointer group">
                    <div className="text-xs font-mono text-slate-400 mb-1">W-A{i}</div>
                    <div className="text-xs text-slate-300 truncate">Ext 2x6 stud...</div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Properties</h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between border-b border-[#1e2a3a]/50 pb-2">
                  <span className="text-slate-500">Fire Rating</span>
                  <span className="text-slate-300">1-hour assembly</span>
                </div>
                <div className="flex justify-between border-b border-[#1e2a3a]/50 pb-2">
                  <span className="text-slate-500">Thickness</span>
                  <span className="text-slate-300">5/8"</span>
                </div>
                <div className="flex justify-between border-b border-[#1e2a3a]/50 pb-2">
                  <span className="text-slate-500">Category</span>
                  <span className="text-slate-300">Gypsum Board</span>
                </div>
              </div>
            </div>

          </div>

          {/* Action Row */}
          <div className="p-4 border-t border-[#1e2a3a] bg-[#0b1220] flex flex-col gap-2">
            <button className="w-full flex items-center justify-center gap-2 bg-[#5fd0e0] hover:bg-[#4bc0d0] text-[#0b1220] py-2 rounded-md font-medium text-sm transition-colors">
              Cite in a letter <ChevronDown size={16} />
            </button>
            <button className="w-full flex items-center justify-center gap-2 bg-[#1e2a3a] hover:bg-[#1e2a3a]/80 text-slate-300 py-2 rounded-md font-medium text-sm transition-colors border border-[#1e2a3a]">
              Push to Revit (W-A)
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Helper Components ---

function FilterChip({ label, value }: { label: string, value: string }) {
  return (
    <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#1e2a3a]/50 border border-[#1e2a3a] hover:border-[#5fd0e0]/50 text-xs text-slate-300 transition-colors">
      <span className="text-slate-500 font-medium">{label}</span>
      <span>{value}</span>
      <ChevronDown size={12} className="text-slate-500" />
    </button>
  );
}

function StatusPill({ status }: { status: string }) {
  let colorClass = "";
  
  switch(status) {
    case "ACTIVE":
    case "APPLIED":
    case "SENT":
      colorClass = "bg-green-500/10 text-green-500 border-green-500/20";
      break;
    case "WITHDRAWN":
    case "REJECTED":
      colorClass = "bg-red-500/10 text-red-500 border-red-500/20";
      break;
    case "PENDING":
    case "DRAFT":
    case "PUSHED":
      colorClass = "bg-amber-500/10 text-amber-500 border-amber-500/20";
      break;
    case "PENDING REVIEW":
      colorClass = "bg-violet-500/10 text-violet-500 border-violet-500/20";
      break;
    default:
      colorClass = "bg-slate-500/10 text-slate-500 border-slate-500/20";
  }

  return (
    <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium uppercase tracking-wider ${colorClass}`}>
      {status}
    </span>
  );
}

interface TableRowProps {
  type: 'product' | 'callout' | 'letter';
  name: string;
  source: string;
  id: string;
  status: string;
  verified: string;
  cited: number;
  used: string;
  isSelected?: boolean;
  onClick?: () => void;
}

function TableRow({ type, name, source, id, status, verified, cited, used, isSelected, onClick }: TableRowProps) {
  const Icon = type === 'product' ? Box : type === 'callout' ? Layers : FileText;
  
  return (
    <tr 
      onClick={onClick}
      className={`
        border-b border-[#1e2a3a]/50 hover:bg-[#1e2a3a]/30 cursor-pointer group transition-colors
        ${isSelected ? 'bg-[#1e2a3a]/40' : ''}
      `}
    >
      <td className="py-3 pl-4 relative">
        {isSelected && <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-[#5fd0e0]"></div>}
        <Icon size={16} className={isSelected ? 'text-[#5fd0e0]' : 'text-slate-500 group-hover:text-slate-400'} />
      </td>
      <td className={`py-3 font-medium truncate max-w-[200px] ${isSelected ? 'text-[#5fd0e0]' : 'text-slate-200'}`}>
        {name}
      </td>
      <td className="py-3 text-slate-400 truncate max-w-[120px]">{source}</td>
      <td className="py-3 text-slate-400 font-mono text-xs">{id}</td>
      <td className="py-3"><StatusPill status={status} /></td>
      <td className="py-3 text-slate-400">{verified}</td>
      <td className="py-3">
        {cited > 0 ? (
          <span className="bg-[#1e2a3a] text-slate-300 px-2 py-0.5 rounded text-xs hover:bg-[#5fd0e0]/20 hover:text-[#5fd0e0] transition-colors">
            {cited} {cited === 1 ? 'atom' : 'atoms'}
          </span>
        ) : (
          <span className="text-slate-600">—</span>
        )}
      </td>
      <td className="py-3 text-slate-400 truncate max-w-[120px]">{used}</td>
      <td className="py-3 text-right pr-4 opacity-0 group-hover:opacity-100 transition-opacity">
        <div className="flex justify-end gap-2">
          {type === 'product' && (
            <>
              <button className="p-1.5 text-slate-400 hover:text-cyan-400 hover:bg-cyan-400/10 rounded" title="Refresh">
                <RefreshCw size={14} />
              </button>
              <button className="p-1.5 text-slate-400 hover:text-cyan-400 hover:bg-cyan-400/10 rounded" title="Cite in Letter">
                <FileText size={14} />
              </button>
            </>
          )}
          {type === 'callout' && (
            <>
              <button className="p-1.5 text-slate-400 hover:text-cyan-400 hover:bg-cyan-400/10 rounded" title="Push to Revit">
                <Download size={14} className="rotate-180" />
              </button>
              <button className="p-1.5 text-slate-400 hover:text-cyan-400 hover:bg-cyan-400/10 rounded" title="Cite in Letter">
                <FileText size={14} />
              </button>
            </>
          )}
          {type === 'letter' && (
            <button className="p-1.5 text-slate-400 hover:text-green-400 hover:bg-green-400/10 rounded" title="Send Letter">
              <Send size={14} />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
