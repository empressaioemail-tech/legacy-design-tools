import React, { useState } from 'react';
import { 
  Activity, AlertCircle, BarChart3, Bell, Box, Building2, 
  CheckCircle2, ChevronRight, ClipboardList, Clock, Code2, 
  FileText, Image as ImageIcon, Inbox, Layers, LayoutGrid, 
  MapPin, MessageSquare, Search, Settings, Bot, Zap, ArrowRight,
  MoreHorizontal, ChevronLeft
} from 'lucide-react';
import './_group.css';

// Seed Data
const ENGAGEMENTS = [
  {
    id: '1',
    name: 'Musgrave Residence',
    address: '1440 Scenic Dr, Grand County, UT',
    jurisdiction: 'Grand County, UT',
    status: 'active',
    stage: 'review',
    health: 'amber',
    snapshotCount: 12,
    updatedAt: '2h ago',
    kpis: { sheetCount: 42, roomCount: 18, levelCount: 3, wallCount: 210 },
    findings: 4,
    progress: 45
  },
  {
    id: '2',
    name: 'Old Town Mixed-Use Block C',
    address: '800 Main St, Park City, UT',
    jurisdiction: 'Park City Municipal',
    status: 'active',
    stage: 'snapshots',
    health: 'green',
    snapshotCount: 3,
    updatedAt: '5h ago',
    kpis: { sheetCount: 156, roomCount: 142, levelCount: 8, wallCount: 1204 },
    findings: 0,
    progress: 15
  },
  {
    id: '3',
    name: 'Lemhi County Cabin Retreat',
    address: 'Salmon River Rd, Lemhi County, ID',
    jurisdiction: 'Lemhi County, ID',
    status: 'active',
    stage: 'submitted',
    health: 'red',
    snapshotCount: 24,
    updatedAt: '1d ago',
    kpis: { sheetCount: 28, roomCount: 8, levelCount: 2, wallCount: 84 },
    findings: 12,
    progress: 85
  },
  {
    id: '4',
    name: 'Highland Park Civic Center',
    address: '100 Civic Ctr, Highland Park, IL',
    jurisdiction: 'Lake County, IL',
    status: 'in-pilot',
    stage: 'approved',
    health: 'green',
    snapshotCount: 45,
    updatedAt: '2d ago',
    kpis: { sheetCount: 310, roomCount: 85, levelCount: 4, wallCount: 890 },
    findings: 1,
    progress: 100
  },
  {
    id: '5',
    name: 'Beacon Hill Retail Plaza',
    address: '450 Beacon St, Boston, MA',
    jurisdiction: 'Boston Zoning Board',
    status: 'active',
    stage: 'review',
    health: 'green',
    snapshotCount: 8,
    updatedAt: '3d ago',
    kpis: { sheetCount: 65, roomCount: 34, levelCount: 1, wallCount: 156 },
    findings: 2,
    progress: 55
  },
  {
    id: '6',
    name: 'Avalon Apartment Towers',
    address: '1200 Avalon Blvd, Austin, TX',
    jurisdiction: 'Austin Planning Dept',
    status: 'active',
    stage: 'snapshots',
    health: 'amber',
    snapshotCount: 2,
    updatedAt: '1w ago',
    kpis: { sheetCount: 420, roomCount: 350, levelCount: 12, wallCount: 4500 },
    findings: 0,
    progress: 10
  },
  {
    id: '7',
    name: 'Westside Elementary',
    address: '3400 West St, Omaha, NE',
    jurisdiction: 'Omaha Public Schools',
    status: 'archived',
    stage: 'approved',
    health: 'green',
    snapshotCount: 88,
    updatedAt: '1m ago',
    kpis: { sheetCount: 195, roomCount: 65, levelCount: 2, wallCount: 640 },
    findings: 0,
    progress: 100
  },
  {
    id: '8',
    name: 'Summit Corporate Campus',
    address: '10 Summit Way, Denver, CO',
    jurisdiction: 'Denver City Planning',
    status: 'active',
    stage: 'submitted',
    health: 'amber',
    snapshotCount: 15,
    updatedAt: '2m ago',
    kpis: { sheetCount: 280, roomCount: 110, levelCount: 6, wallCount: 1800 },
    findings: 5,
    progress: 75
  }
];

const STAGE_CONFIG = {
  snapshots: { label: 'Snapshots', icon: Layers, color: 'text-blue-600', bg: 'bg-blue-50' },
  review: { label: 'Review & Context', icon: Activity, color: 'text-amber-600', bg: 'bg-amber-50' },
  submitted: { label: 'Submitted', icon: FileText, color: 'text-purple-600', bg: 'bg-purple-50' },
  approved: { label: 'Approved', icon: CheckCircle2, color: 'text-green-600', bg: 'bg-green-50' }
};

export function Pipeline() {
  const [selectedEngagement, setSelectedEngagement] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');

  const selectedData = ENGAGEMENTS.find(e => e.id === selectedEngagement);

  return (
    <div className="dt-pipeline-theme min-h-screen flex w-full">
      {/* Sidebar Navigation */}
      <nav className="w-16 lg:w-64 border-r border-[hsl(var(--border-subtle))] bg-white flex flex-col items-center lg:items-stretch py-4 shrink-0 transition-all">
        <div className="flex items-center justify-center lg:justify-start lg:px-6 mb-8 gap-3">
          <div className="w-8 h-8 rounded bg-[hsl(var(--text-primary))] text-white flex items-center justify-center font-bold">
            <Building2 size={18} />
          </div>
          <span className="font-semibold text-sm hidden lg:block tracking-tight">SmartCity OS</span>
        </div>

        <div className="flex flex-col gap-2 w-full px-3">
          <NavItem icon={LayoutGrid} label="Projects" active />
          <NavItem icon={Inbox} label="Inbox" badge="3" />
          <NavItem icon={Code2} label="Code Library" />
          <NavItem icon={Zap} label="Style Probe" />
          <NavItem icon={Settings} label="Settings" />
        </div>
        
        <div className="mt-auto px-3 w-full">
          <button 
            onClick={() => setChatOpen(!chatOpen)}
            className="w-full flex items-center justify-center lg:justify-start gap-3 p-3 rounded-lg text-white bg-[hsl(var(--text-primary))] hover:bg-[hsl(var(--text-secondary))] transition-colors shadow-sm"
          >
            <Bot size={20} />
            <span className="hidden lg:block text-sm font-medium">Ask Claude</span>
          </button>
        </div>
      </nav>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col h-screen overflow-hidden bg-[hsl(var(--bg-app))]">
        <header className="h-16 border-b border-[hsl(var(--border-subtle))] bg-white flex items-center px-8 justify-between shrink-0">
          <div className="flex items-center gap-4">
            {selectedEngagement && (
              <button 
                onClick={() => setSelectedEngagement(null)}
                className="p-1 hover:bg-gray-100 rounded-md text-gray-500 mr-2"
              >
                <ChevronLeft size={20} />
              </button>
            )}
            <h1 className="text-lg font-semibold tracking-tight">
              {selectedEngagement ? selectedData?.name : 'Pipeline Overview'}
            </h1>
            {selectedEngagement && (
              <span className={`px-2 py-0.5 text-xs font-medium rounded-full pill-${selectedData?.status}`}>
                {selectedData?.status}
              </span>
            )}
          </div>
          
          <div className="flex items-center gap-4">
            <div className="relative hidden md:block">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
              <input 
                type="text" 
                placeholder="Search engagements, codes..." 
                className="pl-9 pr-4 py-1.5 text-sm rounded-md border border-[hsl(var(--border-subtle))] bg-gray-50 w-64 focus:outline-none focus:ring-2 focus:ring-[hsl(var(--accent-blue))] focus:bg-white transition-all"
              />
            </div>
            <button className="relative p-2 text-gray-500 hover:bg-gray-100 rounded-full">
              <Bell size={20} />
              <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-red-500 rounded-full border border-white"></span>
            </button>
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 to-purple-500 border-2 border-white shadow-sm"></div>
          </div>
        </header>

        <div className="flex-1 overflow-auto p-8">
          {!selectedEngagement ? (
            <PortfolioView onSelect={setSelectedEngagement} />
          ) : (
            <EngagementDetail engagement={selectedData!} activeTab={activeTab} onTabChange={setActiveTab} />
          )}
        </div>
      </main>

      {/* AI Chat Panel */}
      {chatOpen && (
        <aside className="w-80 border-l border-[hsl(var(--border-subtle))] bg-white h-screen flex flex-col shrink-0 shadow-[-4px_0_24px_rgba(0,0,0,0.02)] relative z-10">
          <div className="p-4 border-b border-[hsl(var(--border-subtle))] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Bot size={18} className="text-indigo-600" />
              <span className="font-medium text-sm">Project Assistant</span>
            </div>
            <button onClick={() => setChatOpen(false)} className="text-gray-400 hover:text-gray-600">
              <ChevronRight size={18} />
            </button>
          </div>
          <div className="flex-1 overflow-auto p-4 space-y-4 text-sm">
            <div className="bg-gray-50 p-3 rounded-lg rounded-tl-none border border-gray-100 text-gray-700">
              Hi! I can help you analyze building codes, query project KPIs, or draft response letters. What are you looking for?
            </div>
            <div className="bg-indigo-50 p-3 rounded-lg rounded-tr-none border border-indigo-100 text-indigo-900 ml-6">
              What are the setback requirements for Lemhi County Cabin?
            </div>
            <div className="bg-gray-50 p-3 rounded-lg rounded-tl-none border border-gray-100 text-gray-700">
              Based on the current zoning for <strong>Lemhi County, ID</strong>, the setbacks are:
              <ul className="list-disc pl-4 mt-2 space-y-1">
                <li>Front: 30 ft</li>
                <li>Side: 15 ft</li>
                <li>Rear: 25 ft</li>
              </ul>
              <div className="mt-2 text-xs text-gray-500 flex items-center gap-1 border-t border-gray-200 pt-2">
                <Code2 size={12} /> Source: Lemhi Zoning Code § 4.2.1
              </div>
            </div>
          </div>
          <div className="p-4 border-t border-[hsl(var(--border-subtle))]">
            <div className="relative">
              <input 
                type="text" 
                placeholder="Ask Claude..." 
                className="w-full pl-3 pr-10 py-2 text-sm rounded-lg border border-gray-200 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 shadow-sm"
              />
              <button className="absolute right-2 top-1/2 -translate-y-1/2 text-indigo-600 p-1 hover:bg-indigo-50 rounded">
                <ArrowRight size={16} />
              </button>
            </div>
          </div>
        </aside>
      )}
    </div>
  );
}

// Subcomponents

function NavItem({ icon: Icon, label, active, badge }: { icon: any, label: string, active?: boolean, badge?: string }) {
  return (
    <button className={`flex items-center gap-3 p-2.5 rounded-md w-full transition-colors ${
      active 
        ? 'bg-gray-100 text-gray-900 font-medium' 
        : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900'
    }`}>
      <Icon size={18} className={active ? 'text-indigo-600' : ''} />
      <span className="hidden lg:block text-sm">{label}</span>
      {badge && (
        <span className="hidden lg:flex ml-auto bg-indigo-100 text-indigo-700 text-xs font-bold px-2 py-0.5 rounded-full items-center justify-center">
          {badge}
        </span>
      )}
    </button>
  );
}

function PortfolioView({ onSelect }: { onSelect: (id: string) => void }) {
  return (
    <div className="max-w-6xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Scorecard Header */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard title="Total Pipeline" value="8" subtitle="Active engagements" trend="+2 this month" />
        <KpiCard title="At Risk" value="1" subtitle="Lemhi County Retreat" trend="Requires attention" alert />
        <KpiCard title="Pending Review" value="3" subtitle="Waiting on jurisdiction" />
        <KpiCard title="Total Sheets" value="1.4k" subtitle="Across all projects" sparkline />
      </div>

      {/* Pipeline Board */}
      <div className="bg-white rounded-xl border border-[hsl(var(--border-subtle))] shadow-sm overflow-hidden">
        <div className="p-5 border-b border-[hsl(var(--border-subtle))] flex justify-between items-center bg-gray-50/50">
          <h2 className="text-base font-semibold">Active Engagements</h2>
          <div className="flex gap-2">
            <button className="text-sm px-3 py-1.5 border border-gray-200 rounded-md bg-white hover:bg-gray-50 font-medium shadow-sm transition-all">Filter</button>
            <button className="text-sm px-3 py-1.5 bg-black text-white rounded-md hover:bg-gray-800 font-medium shadow-sm transition-all">New Project</button>
          </div>
        </div>
        
        <table className="w-full text-sm text-left border-collapse">
          <thead>
            <tr className="border-b border-[hsl(var(--border-subtle))] text-gray-500 bg-white">
              <th className="font-medium py-3 px-5 w-1/3">Project</th>
              <th className="font-medium py-3 px-5">Stage</th>
              <th className="font-medium py-3 px-5">Progress</th>
              <th className="font-medium py-3 px-5 text-right">Last Update</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[hsl(var(--border-subtle))]">
            {ENGAGEMENTS.map(eng => (
              <tr 
                key={eng.id} 
                onClick={() => onSelect(eng.id)}
                className="hover:bg-gray-50 cursor-pointer transition-colors group"
              >
                <td className="py-4 px-5">
                  <div className="flex items-start gap-3">
                    <div className="mt-1 flex-shrink-0">
                      <div className={`traffic-dot traffic-${eng.health}`}></div>
                    </div>
                    <div>
                      <div className="font-medium text-gray-900 group-hover:text-indigo-600 transition-colors flex items-center gap-2">
                        {eng.name}
                        {eng.findings > 0 && (
                          <span className="flex items-center gap-1 text-[10px] bg-red-50 text-red-600 px-1.5 py-0.5 rounded font-bold">
                            <AlertCircle size={10} /> {eng.findings}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-1">
                        <MapPin size={10} /> {eng.jurisdiction}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="py-4 px-5">
                  <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${STAGE_CONFIG[eng.stage as keyof typeof STAGE_CONFIG].bg} ${STAGE_CONFIG[eng.stage as keyof typeof STAGE_CONFIG].color}`}>
                    {React.createElement(STAGE_CONFIG[eng.stage as keyof typeof STAGE_CONFIG].icon, { size: 12 })}
                    {STAGE_CONFIG[eng.stage as keyof typeof STAGE_CONFIG].label}
                  </div>
                </td>
                <td className="py-4 px-5">
                  <div className="w-32">
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-gray-500 font-medium">{eng.progress}%</span>
                    </div>
                    <div className="h-1.5 w-full bg-gray-100 rounded-full overflow-hidden">
                      <div 
                        className={`h-full rounded-full transition-all duration-1000 ease-out ${eng.health === 'green' ? 'bg-green-500' : eng.health === 'amber' ? 'bg-amber-500' : 'bg-red-500'}`}
                        style={{ width: `${eng.progress}%` }}
                      ></div>
                    </div>
                  </div>
                </td>
                <td className="py-4 px-5 text-right text-gray-500 text-xs font-medium">
                  {eng.updatedAt}
                  <ChevronRight size={14} className="inline-block ml-2 text-gray-300 group-hover:text-indigo-500 transition-colors" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function KpiCard({ title, value, subtitle, alert, trend, sparkline }: any) {
  return (
    <div className={`p-5 rounded-xl border shadow-sm relative overflow-hidden bg-white ${alert ? 'border-red-200' : 'border-[hsl(var(--border-subtle))]'}`}>
      <div className="text-sm font-medium text-gray-500 mb-1">{title}</div>
      <div className={`text-3xl font-bold tracking-tight mb-2 ${alert ? 'text-red-600' : 'text-gray-900'}`}>
        {value}
      </div>
      <div className="text-xs text-gray-500 flex justify-between items-end">
        <span>{subtitle}</span>
        {trend && <span className={`font-medium ${alert ? 'text-red-500' : 'text-green-600'}`}>{trend}</span>}
      </div>
      {sparkline && (
        <svg className="absolute bottom-0 right-0 w-24 h-12 opacity-20 text-indigo-500" viewBox="0 0 100 30" preserveAspectRatio="none">
          <path d="M0,30 Q20,10 40,20 T80,5 T100,15 L100,30 Z" fill="currentColor" />
          <path d="M0,30 Q20,10 40,20 T80,5 T100,15" fill="none" stroke="currentColor" strokeWidth="2" className="sparkline" />
        </svg>
      )}
    </div>
  );
}

function EngagementDetail({ engagement, activeTab, onTabChange }: { engagement: any, activeTab: string, onTabChange: (v: string) => void }) {
  
  // Progressive disclosure: determine available tabs based on stage
  const stages = ['snapshots', 'review', 'submitted', 'approved'];
  const currentStageIdx = stages.indexOf(engagement.stage);
  
  const tabs = [
    { id: 'overview', label: 'Overview', icon: LayoutGrid },
    { id: 'snapshots', label: 'Snapshots', icon: Layers },
    { id: 'bim', label: '3D Model', icon: Box },
    { id: 'sheets', label: 'Sheets', icon: FileText },
  ];

  if (currentStageIdx >= 1) {
    tabs.push({ id: 'site', label: 'Site Context', icon: MapPin });
    tabs.push({ id: 'findings', label: 'Findings', icon: AlertCircle, badge: engagement.findings });
  }

  if (currentStageIdx >= 2) {
    tabs.push({ id: 'submissions', label: 'Submissions', icon: Inbox });
    tabs.push({ id: 'tasks', label: 'Response Tasks', icon: ClipboardList });
  }

  if (currentStageIdx >= 3) {
    tabs.push({ id: 'letters', label: 'Deliverable Letters', icon: MessageSquare });
  }

  tabs.push({ id: 'settings', label: 'Settings', icon: Settings });

  return (
    <div className="max-w-6xl mx-auto flex flex-col h-full animate-in fade-in slide-in-from-right-8 duration-300">
      
      {/* Project Hero Header */}
      <div className="bg-white border border-[hsl(var(--border-subtle))] rounded-xl p-6 mb-6 shadow-sm flex flex-col md:flex-row gap-6 justify-between shrink-0">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h2 className="text-2xl font-bold tracking-tight">{engagement.name}</h2>
            <div className={`px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wide ${STAGE_CONFIG[engagement.stage as keyof typeof STAGE_CONFIG].bg} ${STAGE_CONFIG[engagement.stage as keyof typeof STAGE_CONFIG].color}`}>
              {STAGE_CONFIG[engagement.stage as keyof typeof STAGE_CONFIG].label}
            </div>
          </div>
          <div className="text-sm text-gray-500 flex items-center gap-4">
            <span className="flex items-center gap-1.5"><MapPin size={14}/> {engagement.address}</span>
            <span className="flex items-center gap-1.5"><Building2 size={14}/> {engagement.jurisdiction}</span>
          </div>
        </div>

        <div className="flex gap-6 items-center">
          <div className="text-right">
            <div className="text-xs text-gray-500 font-medium uppercase tracking-wider mb-1">Sheet Count</div>
            <div className="text-xl font-bold">{engagement.kpis.sheetCount}</div>
          </div>
          <div className="w-px h-10 bg-gray-200"></div>
          <div className="text-right">
            <div className="text-xs text-gray-500 font-medium uppercase tracking-wider mb-1">Room Count</div>
            <div className="text-xl font-bold">{engagement.kpis.roomCount}</div>
          </div>
          <div className="w-px h-10 bg-gray-200"></div>
          <div className="text-right">
            <div className="text-xs text-gray-500 font-medium uppercase tracking-wider mb-1">Health</div>
            <div className="flex items-center gap-1.5 justify-end">
              <div className={`traffic-dot traffic-${engagement.health}`}></div>
              <span className="font-semibold capitalize text-sm">{engagement.health}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="flex gap-6 flex-1 min-h-0">
        {/* Vertical Tabs */}
        <div className="w-56 shrink-0 flex flex-col gap-1 overflow-y-auto pr-2 pb-8">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                activeTab === tab.id 
                  ? 'bg-white border border-[hsl(var(--border-subtle))] shadow-sm text-indigo-700' 
                  : 'text-gray-600 hover:bg-gray-100/50 hover:text-gray-900 border border-transparent'
              }`}
            >
              <tab.icon size={16} className={activeTab === tab.id ? 'text-indigo-600' : 'text-gray-400'} />
              {tab.label}
              {tab.badge !== undefined && tab.badge > 0 && (
                <span className={`ml-auto px-1.5 py-0.5 rounded text-[10px] font-bold ${activeTab === tab.id ? 'bg-indigo-100 text-indigo-700' : 'bg-red-100 text-red-600'}`}>
                  {tab.badge}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="flex-1 bg-white border border-[hsl(var(--border-subtle))] rounded-xl shadow-sm overflow-hidden flex flex-col relative">
           <TabRenderer activeTab={activeTab} engagement={engagement} />
        </div>
      </div>
    </div>
  );
}

function TabRenderer({ activeTab, engagement }: { activeTab: string, engagement: any }) {
  // Simple renderer for the mockup
  switch(activeTab) {
    case 'overview':
      return (
        <div className="p-8 h-full overflow-auto">
          <h3 className="text-lg font-bold mb-6">Stage Progress</h3>
          
          <div className="relative mb-12">
            <div className="absolute top-1/2 left-0 w-full h-1 bg-gray-100 -translate-y-1/2 z-0 rounded-full"></div>
            <div className="absolute top-1/2 left-0 h-1 bg-indigo-500 -translate-y-1/2 z-0 rounded-full transition-all duration-1000" style={{ width: `${engagement.progress}%` }}></div>
            
            <div className="relative z-10 flex justify-between">
              {['Snapshots', 'Review', 'Submitted', 'Approved'].map((step, i) => {
                const stages = ['snapshots', 'review', 'submitted', 'approved'];
                const currentIdx = stages.indexOf(engagement.stage);
                const isCompleted = i <= currentIdx;
                const isCurrent = i === currentIdx;
                
                return (
                  <div key={step} className="flex flex-col items-center">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm border-2 transition-colors ${
                      isCompleted 
                        ? 'bg-indigo-600 border-indigo-600 text-white' 
                        : 'bg-white border-gray-300 text-gray-400'
                    } ${isCurrent ? 'ring-4 ring-indigo-100' : ''}`}>
                      {isCompleted ? <CheckCircle2 size={16} /> : i + 1}
                    </div>
                    <div className={`mt-3 text-sm font-medium ${isCurrent ? 'text-indigo-700' : isCompleted ? 'text-gray-900' : 'text-gray-400'}`}>
                      {step}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-6">
            <div className="border border-gray-100 rounded-lg p-5">
              <h4 className="font-semibold text-sm text-gray-500 uppercase tracking-wider mb-4 flex items-center gap-2">
                <AlertCircle size={16} /> Key Findings Risk
              </h4>
              {engagement.findings > 0 ? (
                <div className="space-y-3">
                  {[...Array(Math.min(3, engagement.findings))].map((_, i) => (
                    <div key={i} className="flex gap-3 text-sm p-3 bg-red-50/50 text-red-900 rounded-md border border-red-100">
                      <div className="w-1.5 h-1.5 rounded-full bg-red-500 mt-1.5 shrink-0" />
                      <div>
                        <div className="font-medium mb-1">Setback violation on North facade</div>
                        <div className="text-red-700/80 text-xs">Required 15ft, measured 12.5ft (Zoning Code 4.2)</div>
                      </div>
                    </div>
                  ))}
                  {engagement.findings > 3 && (
                    <div className="text-xs text-center text-gray-500 font-medium pt-2 cursor-pointer hover:text-indigo-600">
                      + {engagement.findings - 3} more findings in Review tab
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-6 text-gray-400">
                  <CheckCircle2 size={32} className="text-green-500 mb-2 opacity-50" />
                  <p className="text-sm">No blocking findings detected</p>
                </div>
              )}
            </div>

            <div className="border border-gray-100 rounded-lg p-5">
              <h4 className="font-semibold text-sm text-gray-500 uppercase tracking-wider mb-4 flex items-center gap-2">
                <Layers size={16} /> Model Composition
              </h4>
              <div className="flex h-32 items-end gap-2 pb-2">
                {/* Mock Chart */}
                <div className="flex-1 bg-indigo-100 rounded-t-sm h-[80%] relative group">
                  <div className="absolute -top-6 left-1/2 -translate-x-1/2 text-xs font-bold text-indigo-700 opacity-0 group-hover:opacity-100">Walls</div>
                </div>
                <div className="flex-1 bg-purple-100 rounded-t-sm h-[40%] relative group">
                   <div className="absolute -top-6 left-1/2 -translate-x-1/2 text-xs font-bold text-purple-700 opacity-0 group-hover:opacity-100">Slabs</div>
                </div>
                <div className="flex-1 bg-blue-100 rounded-t-sm h-[60%] relative group">
                   <div className="absolute -top-6 left-1/2 -translate-x-1/2 text-xs font-bold text-blue-700 opacity-0 group-hover:opacity-100">Doors</div>
                </div>
                <div className="flex-1 bg-amber-100 rounded-t-sm h-[30%] relative group">
                   <div className="absolute -top-6 left-1/2 -translate-x-1/2 text-xs font-bold text-amber-700 opacity-0 group-hover:opacity-100">Windows</div>
                </div>
                <div className="flex-1 bg-emerald-100 rounded-t-sm h-[20%] relative group">
                   <div className="absolute -top-6 left-1/2 -translate-x-1/2 text-xs font-bold text-emerald-700 opacity-0 group-hover:opacity-100">Rooms</div>
                </div>
              </div>
              <div className="flex justify-between text-xs text-gray-400 border-t border-gray-100 pt-2 font-medium">
                <span>Wall</span><span>Slb</span><span>Dor</span><span>Win</span><span>Rms</span>
              </div>
            </div>
          </div>
        </div>
      );
    
    case 'bim':
      return (
        <div className="absolute inset-0 bg-gray-900 flex items-center justify-center flex-col text-white">
          <Box size={48} className="text-gray-600 mb-4 opacity-50" />
          <h3 className="font-medium text-lg text-gray-300">3D Viewer</h3>
          <p className="text-sm text-gray-500">Interactive model loads here</p>
        </div>
      );

    case 'sheets':
      return (
        <div className="p-6 h-full flex flex-col">
          <div className="flex justify-between items-center mb-6 shrink-0">
            <h3 className="font-bold">Drawing Set ({engagement.kpis.sheetCount})</h3>
            <div className="flex gap-2">
              <input type="text" placeholder="Search sheets..." className="border border-gray-200 rounded px-3 py-1 text-sm outline-none focus:border-indigo-500" />
            </div>
          </div>
          <div className="flex-1 overflow-auto">
            <div className="grid grid-cols-3 xl:grid-cols-4 gap-4">
              {[...Array(12)].map((_, i) => (
                <div key={i} className="border border-gray-200 rounded-lg bg-gray-50 aspect-[3/4] flex flex-col group cursor-pointer hover:border-indigo-400 transition-colors">
                  <div className="flex-1 bg-white m-1 mb-0 rounded shadow-sm flex items-center justify-center text-gray-300 group-hover:bg-indigo-50/30 transition-colors">
                    <FileText size={24} />
                  </div>
                  <div className="p-3 text-xs">
                    <div className="font-bold text-gray-900 truncate">A{100 + i} - Floor Plan</div>
                    <div className="text-gray-500">Rev {i % 3 === 0 ? '2' : '1'}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      );

    default:
      return (
        <div className="flex-1 flex flex-col items-center justify-center text-gray-400 p-8 text-center">
          <div className="w-16 h-16 rounded-full bg-gray-50 flex items-center justify-center mb-4">
            <AlertCircle size={24} className="text-gray-300" />
          </div>
          <h3 className="font-medium text-gray-900 mb-2">View Data Selected</h3>
          <p className="text-sm max-w-sm">The {activeTab} view is contextually exposed for the {engagement.stage} stage in this mockup.</p>
        </div>
      );
  }
}
