import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  useGetEngagementBriefing,
  getGetEngagementBriefingQueryKey,
  type EngagementDetail as EngagementDetailType,
  type EngagementBriefing,
  type EngagementBriefingSource,
} from "@workspace/api-client-react";
import { SiteMap } from "@workspace/site-context/client";
import { ParcelZoningCard, StatusPill } from "@workspace/portal-ui";
import {
  Eye,
  EyeOff,
  GripVertical,
  Plus,
  Upload,
  RefreshCw,
  Share2,
  Layers as LayersIcon,
  MapPin,
  Compass,
  ZoomIn,
  ZoomOut,
  Info,
  Building2,
  ChevronRight,
  Waves,
  Mountain,
  AlertTriangle,
  Wifi,
} from "lucide-react";
import { relativeTime } from "../../lib/relativeTime";
import { TabHeader } from "../cockpit/TabChrome";

const PROJECT_TYPE_LABEL: Record<string, string> = {
  new_build: "New build",
  renovation: "Renovation",
  addition: "Addition",
  tenant_improvement: "Tenant improvement",
  other: "Other",
};

interface LayerRowSpec {
  id: string;
  name: string;
  source: string;
  defaultVisible: boolean;
  opacity?: number;
}

interface LayerGroupSpec {
  key: string;
  title: string;
  rows: LayerRowSpec[];
}

function buildLayerGroups(
  briefing: EngagementBriefing | null,
  hasGeocode: boolean,
): LayerGroupSpec[] {
  const sources = briefing?.sources ?? [];
  const has = (kindPrefix: string) =>
    sources.some(
      (s) => !s.supersededAt && s.layerKind.startsWith(kindPrefix),
    );

  const localStateRows: LayerRowSpec[] = [];
  for (const s of sources) {
    if (s.supersededAt) continue;
    if (s.sourceKind !== "local-adapter" && s.sourceKind !== "state-adapter") {
      continue;
    }
    localStateRows.push({
      id: `local-${s.id}`,
      name: humanizeLayer(s.layerKind),
      source: s.provider ?? "Adapter",
      defaultVisible: true,
      opacity: 100,
    });
  }
  if (localStateRows.length === 0 && hasGeocode) {
    localStateRows.push({
      id: "local-empty",
      name: "Parcel Boundary",
      source: "Pending",
      defaultVisible: false,
    });
  }

  const manualRows: LayerRowSpec[] = sources
    .filter((s) => !s.supersededAt && s.sourceKind === "manual-upload")
    .map((s) => ({
      id: `manual-${s.id}`,
      name: s.uploadOriginalFilename || humanizeLayer(s.layerKind),
      source: "Manual upload",
      defaultVisible: false,
    }));

  return [
    {
      key: "base",
      title: "Base",
      rows: [
        {
          id: "base-dark",
          name: "Dark Map Base",
          source: "Mapbox",
          defaultVisible: true,
          opacity: 100,
        },
        {
          id: "base-satellite",
          name: "Satellite Imagery",
          source: "Mapbox",
          defaultVisible: false,
        },
        {
          id: "base-topo",
          name: "Topography",
          source: "USGS",
          defaultVisible: has("usgs"),
          opacity: 40,
        },
      ],
    },
    { key: "local-state", title: "Local & State", rows: localStateRows },
    {
      key: "federal",
      title: "Federal",
      rows: [
        {
          id: "fed-fema",
          name: "FEMA Flood",
          source: "FEMA",
          defaultVisible: has("fema"),
        },
        {
          id: "fed-ej",
          name: "EJScreen Burden",
          source: "EPA",
          defaultVisible: has("epa"),
        },
        {
          id: "fed-broadband",
          name: "Broadband Availability",
          source: "FCC",
          defaultVisible: has("fcc"),
        },
      ],
    },
    { key: "manual", title: "Manual Overlays", rows: manualRows },
    {
      key: "proposed",
      title: "Proposed",
      rows: [
        {
          id: "prop-bim",
          name: "BIM Footprint",
          source: "Revit",
          defaultVisible: true,
          opacity: 80,
        },
      ],
    },
  ];
}

function humanizeLayer(layerKind: string): string {
  return layerKind
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

interface ContextItemSpec {
  key: string;
  icon: React.ReactNode;
  label: string;
  value: string;
}

function buildActiveContext(
  briefing: EngagementBriefing | null,
): ContextItemSpec[] {
  const sources = briefing?.sources ?? [];
  const findLatest = (
    predicate: (s: EngagementBriefingSource) => boolean,
  ): EngagementBriefingSource | null => {
    const matches = sources.filter((s) => !s.supersededAt && predicate(s));
    return matches[0] ?? null;
  };

  const fema = findLatest((s) => s.layerKind.startsWith("fema"));
  const usgs = findLatest((s) => s.layerKind.startsWith("usgs"));
  const epa = findLatest((s) => s.layerKind.startsWith("epa"));
  const fcc = findLatest((s) => s.layerKind.startsWith("fcc"));

  const summarizeFema = (s: EngagementBriefingSource | null) => {
    if (!s) return "Not yet generated";
    const p = s.payload as Record<string, unknown> | null;
    if (p && typeof p["inMappedFloodplain"] === "boolean") {
      return p["inMappedFloodplain"]
        ? "In mapped floodplain"
        : "Zone X (minimal risk)";
    }
    return relativeTime(s.snapshotDate);
  };
  const summarizeUsgs = (s: EngagementBriefingSource | null) => {
    if (!s) return "Not yet generated";
    const p = s.payload as Record<string, unknown> | null;
    const el = p?.["elevationFt"] ?? p?.["elevation"];
    if (typeof el === "number") return `${el.toFixed(0)} ft elevation`;
    return relativeTime(s.snapshotDate);
  };
  const summarizeEpa = (s: EngagementBriefingSource | null) => {
    if (!s) return "Not yet generated";
    return `Synced ${relativeTime(s.snapshotDate)}`;
  };
  const summarizeFcc = (s: EngagementBriefingSource | null) => {
    if (!s) return "Not yet generated";
    return `Synced ${relativeTime(s.snapshotDate)}`;
  };

  return [
    {
      key: "fema",
      icon: <Waves size={14} className="sc-accent-blue" />,
      label: "FEMA Flood",
      value: summarizeFema(fema),
    },
    {
      key: "usgs",
      icon: <Mountain size={14} className="sc-accent-green" />,
      label: "USGS Topo",
      value: summarizeUsgs(usgs),
    },
    {
      key: "epa",
      icon: <AlertTriangle size={14} className="sc-accent-amber" />,
      label: "EPA EJScreen",
      value: summarizeEpa(epa),
    },
    {
      key: "fcc",
      icon: <Wifi size={14} className="sc-accent-cyan" />,
      label: "FCC Broadband",
      value: summarizeFcc(fcc),
    },
  ];
}

function LayerRow({
  row,
  visible,
  onToggle,
}: {
  row: LayerRowSpec;
  visible: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className="group flex items-center gap-2 py-1.5 px-2 rounded cursor-pointer"
      style={{
        background: "transparent",
      }}
      onMouseEnter={(e) =>
        (e.currentTarget.style.background = "var(--bg-highlight)")
      }
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <span
        className="flex-shrink-0 opacity-30 group-hover:opacity-100"
        style={{ color: "var(--text-secondary)" }}
      >
        <GripVertical size={14} />
      </span>
      <button
        type="button"
        onClick={onToggle}
        className="flex-shrink-0"
        style={{
          color: visible ? "var(--text-primary)" : "var(--text-muted)",
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
        }}
        aria-label={visible ? `Hide ${row.name}` : `Show ${row.name}`}
      >
        {visible ? <Eye size={14} /> : <EyeOff size={14} />}
      </button>
      <div className="flex-1 min-w-0 flex items-center justify-between gap-2">
        <span
          className="text-xs truncate"
          style={{
            color: visible ? "var(--text-primary)" : "var(--text-muted)",
          }}
        >
          {row.name}
        </span>
        <span
          className="text-[9px] uppercase tracking-wider flex-shrink-0 px-1 rounded"
          style={{
            color: "var(--text-muted)",
            background: "var(--bg-base)",
            border: "1px solid var(--border-default)",
          }}
        >
          {row.source}
        </span>
      </div>
      {visible && row.opacity !== undefined && (
        <div
          className="w-12 h-1 rounded-full overflow-hidden flex-shrink-0 hidden group-hover:block"
          style={{
            background: "var(--bg-base)",
            border: "1px solid var(--border-default)",
          }}
        >
          <div
            className="h-full"
            style={{
              width: `${row.opacity}%`,
              background: "var(--text-secondary)",
            }}
          />
        </div>
      )}
    </div>
  );
}

function InspectorStat({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <div
      className="p-3 rounded"
      style={{
        background: "var(--bg-base)",
        border: "1px solid var(--border-default)",
      }}
    >
      <div
        className="text-[10px] uppercase mb-1 tracking-wider"
        style={{ color: "var(--text-muted)" }}
      >
        {label}
      </div>
      <div className="text-sm" style={{ color: "var(--text-primary)" }}>
        {value}
      </div>
      {sub && (
        <div
          className="text-[10px] mt-0.5"
          style={{ color: "var(--text-muted)" }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

function ContextRow({ item }: { item: ContextItemSpec }) {
  return (
    <div
      className="flex items-start gap-2.5 p-2 rounded"
      style={{ border: "1px solid transparent" }}
    >
      <div className="mt-0.5">{item.icon}</div>
      <div className="min-w-0">
        <div
          className="text-xs font-medium"
          style={{ color: "var(--text-primary)" }}
        >
          {item.label}
        </div>
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>
          {item.value}
        </div>
      </div>
    </div>
  );
}

export function SiteTab({
  engagement,
  onAddAddress,
}: {
  engagement: EngagementDetailType;
  onAddAddress: () => void;
}) {
  const [, setLocation] = useLocation();
  const site = engagement.site;
  const geocode = site?.geocode ?? null;

  const briefingQuery = useGetEngagementBriefing(engagement.id, {
    query: {
      queryKey: getGetEngagementBriefingQueryKey(engagement.id),
      enabled: !!engagement.id,
    },
  });
  const briefing = briefingQuery.data?.briefing ?? null;

  const layerGroups = useMemo(
    () => buildLayerGroups(briefing, !!geocode),
    [briefing, geocode],
  );
  const contextItems = useMemo(() => buildActiveContext(briefing), [briefing]);

  const initialVisibility = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const g of layerGroups) {
      for (const r of g.rows) map[r.id] = r.defaultVisible;
    }
    return map;
  }, [layerGroups]);
  const [visibility, setVisibility] =
    useState<Record<string, boolean>>(initialVisibility);

  const toggleLayer = (id: string) =>
    setVisibility((prev) => ({
      ...prev,
      [id]: !(prev[id] ?? initialVisibility[id] ?? false),
    }));

  const isVisible = (id: string) =>
    visibility[id] ?? initialVisibility[id] ?? false;

  const goSiteContext = () =>
    setLocation(`/engagements/${engagement.id}?tab=site-context`);

  const jurisdictionLabel = geocode
    ? [geocode.jurisdictionCity, geocode.jurisdictionState]
        .filter(Boolean)
        .join(", ") || engagement.jurisdiction || "—"
    : engagement.jurisdiction || "—";

  const latest = engagement.latestSnapshot;

  return (
    <div className="cockpit-tab" data-testid="site-tab">
      <TabHeader
        overline="Site · workspace"
        title="Site"
        subtitle="Layered map cockpit. Toggle base, jurisdictional, federal, and proposed overlays; inspect parcel, zoning, and federal context on the right; jump to Site Context to run adapters."
        actions={
          <button className="sc-btn-ghost sc-btn-sm" onClick={onAddAddress}>
            Edit address
          </button>
        }
      />

      <div
        className="flex overflow-hidden rounded-md"
        style={{
          height: 720,
          background: "var(--bg-chrome)",
          border: "1px solid var(--border-default)",
        }}
      >
        {/* LEFT — LAYER PALETTE */}
        <div
          className="flex flex-col"
          style={{
            width: 280,
            borderRight: "1px solid var(--border-default)",
            background: "var(--bg-surface)",
          }}
          data-testid="site-tab-layer-palette"
        >
          <div
            className="p-4"
            style={{ borderBottom: "1px solid var(--border-default)" }}
          >
            <div className="flex items-center gap-2 mb-1">
              <h1
                className="text-sm font-medium truncate"
                style={{ color: "var(--text-primary)" }}
              >
                {engagement.name}
              </h1>
              <StatusPill status={engagement.status} />
            </div>
            <p
              className="text-xs truncate"
              style={{ color: "var(--text-secondary)" }}
            >
              {site?.address ?? "Address not set"}
            </p>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-4 text-sm">
            {layerGroups.map((group) => (
              <div key={group.key}>
                <h2
                  className="text-[10px] uppercase tracking-widest mb-2 font-semibold"
                  style={{ color: "var(--text-muted)" }}
                >
                  {group.title}
                </h2>
                {group.rows.length === 0 ? (
                  <div
                    className="text-xs italic px-2 py-1"
                    style={{ color: "var(--text-muted)" }}
                  >
                    None yet
                  </div>
                ) : (
                  <div className="space-y-0.5">
                    {group.rows.map((row) => (
                      <LayerRow
                        key={row.id}
                        row={row}
                        visible={isVisible(row.id)}
                        onToggle={() => toggleLayer(row.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div
            className="p-3 flex flex-col gap-2"
            style={{ borderTop: "1px solid var(--border-default)" }}
          >
            <button
              type="button"
              className="sc-btn-secondary sc-btn-sm flex items-center justify-center gap-2"
              onClick={goSiteContext}
              data-testid="site-tab-add-layer"
            >
              <Plus size={14} /> Add Layer
            </button>
            <button
              type="button"
              className="sc-btn-ghost sc-btn-sm flex items-center justify-center gap-2"
              onClick={goSiteContext}
              data-testid="site-tab-upload-qgis"
            >
              <Upload size={14} /> Upload QGIS
            </button>
          </div>
        </div>

        {/* CENTER — MAP CANVAS */}
        <div
          className="flex-1 relative overflow-hidden"
          style={{ background: "var(--bg-base)" }}
        >
          {geocode ? (
            <div className="absolute inset-0">
              <SiteMap
                latitude={geocode.latitude}
                longitude={geocode.longitude}
                addressLabel={site?.address ?? undefined}
                height={720}
              />
            </div>
          ) : (
            <div
              className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center"
              style={{ color: "var(--text-secondary)" }}
            >
              <MapPin
                size={28}
                style={{ color: "var(--text-muted)" }}
                aria-hidden
              />
              <div className="sc-body">
                Add an address to plot this project on the map.
              </div>
              <button className="sc-btn-primary" onClick={onAddAddress}>
                Add address
              </button>
            </div>
          )}

          {/* Floating top bar */}
          <div className="absolute top-3 left-3 right-3 flex justify-between items-start gap-2 z-10 pointer-events-none">
            <div
              className="px-3 py-1.5 rounded-full flex items-center gap-2 pointer-events-auto"
              style={{
                background: "var(--bg-surface)",
                border: "1px solid var(--border-default)",
                color: "var(--text-primary)",
              }}
            >
              <MapPin size={14} style={{ color: "var(--text-secondary)" }} />
              <span className="text-xs">{jurisdictionLabel}</span>
            </div>

            <div className="flex gap-2 pointer-events-auto">
              <button
                type="button"
                className="sc-btn-ghost sc-btn-sm flex items-center gap-1.5"
                onClick={goSiteContext}
                data-testid="site-tab-generate-layers"
              >
                <LayersIcon size={14} /> Generate layers
              </button>
              <button
                type="button"
                className="sc-btn-ghost sc-btn-sm flex items-center gap-1.5"
                onClick={() => briefingQuery.refetch()}
                data-testid="site-tab-refresh"
              >
                <RefreshCw size={14} /> Refresh
              </button>
              <button
                type="button"
                className="sc-btn-secondary sc-btn-sm flex items-center gap-1.5 sc-accent-cyan"
                onClick={goSiteContext}
                data-testid="site-tab-push-revit"
              >
                <Share2 size={14} /> Push to Revit
              </button>
            </div>
          </div>

          {/* Bottom-right: zoom controls (decorative — real map controls live inside SiteMap) */}
          <div className="absolute bottom-4 right-4 flex flex-col gap-2 z-[5] pointer-events-none">
            <div
              className="rounded flex flex-col"
              style={{
                background: "var(--bg-surface)",
                border: "1px solid var(--border-default)",
                opacity: 0.8,
              }}
            >
              <span
                className="p-2"
                style={{
                  color: "var(--text-secondary)",
                  borderBottom: "1px solid var(--border-default)",
                }}
              >
                <ZoomIn size={14} />
              </span>
              <span className="p-2" style={{ color: "var(--text-secondary)" }}>
                <ZoomOut size={14} />
              </span>
            </div>
          </div>

          {/* Bottom-left: compass + scale */}
          <div className="absolute bottom-4 left-4 flex items-center gap-3 z-[5] pointer-events-none">
            <div
              className="rounded-full p-1.5"
              style={{
                background: "var(--bg-surface)",
                border: "1px solid var(--border-default)",
                opacity: 0.85,
              }}
            >
              <Compass
                size={14}
                style={{ color: "var(--text-secondary)" }}
              />
            </div>
          </div>
        </div>

        {/* RIGHT — INSPECTOR */}
        <div
          className="flex flex-col"
          style={{
            width: 340,
            borderLeft: "1px solid var(--border-default)",
            background: "var(--bg-surface)",
          }}
          data-testid="site-tab-inspector"
        >
          <div
            className="p-4 flex items-center justify-between"
            style={{
              borderBottom: "1px solid var(--border-default)",
              background: "var(--bg-base)",
            }}
          >
            <h2
              className="text-sm font-medium flex items-center gap-2"
              style={{ color: "var(--text-primary)" }}
            >
              <Info size={14} className="sc-accent-cyan" /> Inspecting: Parcel
            </h2>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-5">
            {/* Identity */}
            <div>
              <h3
                className="text-lg font-light mb-1"
                style={{ color: "var(--text-primary)" }}
              >
                {site?.address ?? engagement.name}
              </h3>
              <p
                className="text-xs sc-mono-sm sc-accent-cyan"
                style={{ wordBreak: "break-all" }}
              >
                {engagement.applicantFirm ?? "Applicant not recorded"}
              </p>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-2 gap-3">
              <InspectorStat
                label="Lot Area"
                value={
                  site?.lotAreaSqft != null
                    ? `${(site.lotAreaSqft / 43560).toFixed(2)} acres`
                    : "—"
                }
                sub={
                  site?.lotAreaSqft != null
                    ? `${site.lotAreaSqft.toLocaleString()} sq ft`
                    : undefined
                }
              />
              <InspectorStat
                label="Type"
                value={
                  site?.projectType
                    ? (PROJECT_TYPE_LABEL[site.projectType] ?? site.projectType)
                    : "—"
                }
              />
            </div>

            {/* Zoning Constraints — real ParcelZoningCard (preserves tests) */}
            <ParcelZoningCard
              hasGeocode={!!geocode}
              zoningCodeFromSite={site?.zoningCode ?? null}
              lotAreaSqftFromSite={site?.lotAreaSqft ?? null}
              briefing={briefing}
              siteContextHref={`/engagements/${engagement.id}?tab=site-context`}
            />

            {/* Active Context */}
            <div>
              <div
                className="text-[10px] uppercase mb-2 tracking-widest font-semibold"
                style={{ color: "var(--text-muted)" }}
              >
                Active Context
              </div>
              <div className="space-y-1">
                {contextItems.map((item) => (
                  <ContextRow key={item.key} item={item} />
                ))}
              </div>
            </div>

            {/* Building on this site — Revit Model */}
            <div
              className="mt-6 pt-5"
              style={{ borderTop: "1px solid var(--border-default)" }}
            >
              <div
                className="text-[10px] uppercase mb-3 tracking-widest font-semibold"
                style={{ color: "var(--text-muted)" }}
              >
                Building on this site →
              </div>
              <button
                type="button"
                className="group w-full rounded-md p-3 text-left relative overflow-hidden transition-colors"
                style={{
                  background: "var(--bg-base)",
                  border: "1px solid var(--border-default)",
                  cursor: latest ? "pointer" : "default",
                }}
                disabled={!latest}
                onClick={() =>
                  setLocation(
                    `/engagements/${engagement.id}?tab=snapshots`,
                  )
                }
              >
                <div className="absolute top-0 right-0 p-2 opacity-10">
                  <Building2 size={56} />
                </div>
                <div className="relative z-10">
                  <div className="flex items-center gap-2 mb-2">
                    <div
                      className="p-1.5 rounded"
                      style={{
                        background: "var(--bg-elevated)",
                        color: "var(--text-secondary)",
                      }}
                    >
                      <Building2 size={14} />
                    </div>
                    <div>
                      <div
                        className="text-sm font-medium"
                        style={{ color: "var(--text-primary)" }}
                      >
                        Revit Model
                      </div>
                      <div
                        className="text-[10px]"
                        style={{ color: "var(--text-muted)" }}
                      >
                        {latest
                          ? `Synced ${relativeTime(latest.receivedAt)}`
                          : "No snapshot yet"}
                      </div>
                    </div>
                  </div>
                  {latest && (
                    <div
                      className="flex gap-3 text-xs mt-3"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {latest.wallCount != null && (
                        <span>{latest.wallCount} Walls</span>
                      )}
                      {latest.sheetCount != null && (
                        <span>{latest.sheetCount} Sheets</span>
                      )}
                      {latest.levelCount != null && (
                        <span>{latest.levelCount} Levels</span>
                      )}
                    </div>
                  )}
                  {latest && (
                    <div
                      className="mt-3 text-xs font-medium flex items-center gap-1 sc-accent-cyan opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      Open snapshots <ChevronRight size={14} />
                    </div>
                  )}
                </div>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
