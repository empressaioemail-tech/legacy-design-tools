import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  useGetEngagementBriefing,
  getGetEngagementBriefingQueryKey,
  useGenerateEngagementLayers,
  type EngagementDetail as EngagementDetailType,
  type EngagementBriefing,
  type EngagementBriefingSource,
} from "@workspace/api-client-react";
import {
  SiteMap,
  extractBriefingSourceOverlays,
  extractContoursGeoJsonOverlays,
  extractDrainageGeoJsonOverlays,
  filterOverlaysByLayerVisibility,
  hasContoursGeoJson,
  hasDrainageGeoJson,
  resolveMapPinPosition,
} from "@workspace/site-context/client";
import {
  ParcelZoningCard,
  SiteContextViewer,
  StatusPill,
} from "@workspace/portal-ui";
import type { TabId } from "./urlState";
import {
  coverageStatusLabel,
  requestEngagementCoverage,
  shouldShowRequestCoverage,
} from "../../lib/coverageUi";
import { SiteContextTab } from "./SiteContextTab";
import { EncumbrancesPanel } from "./EncumbrancesPanel";
import { SiteContext3DModelToggle } from "./SiteContext3DModelToggle";
import type { BuildingOverlayState } from "@workspace/portal-ui";
import {
  Eye,
  EyeOff,
  Plus,
  Upload,
  RefreshCw,
  Layers as LayersIcon,
  MapPin,
  Info,
  Building2,
  ChevronRight,
  Waves,
  Mountain,
  AlertTriangle,
  Wifi,
  Expand,
  Minimize2,
  GripHorizontal,
  PanelRightClose,
  PanelRightOpen,
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
  hasDemContours: boolean,
  hasDrainage: boolean,
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

  const baseRows: LayerRowSpec[] = [
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
      ];
  if (hasDemContours) {
    baseRows.push({
      id: "base-dem-contours",
      name: "Elevation Contours (USGS 3DEP)",
      source: "DEM ingest",
      defaultVisible: true,
    });
  }
  if (hasDrainage) {
    baseRows.push(
      {
        id: "base-drainage-zones",
        name: "Drainage zones + flow lines",
        source: "Hydrology engine",
        defaultVisible: true,
      },
      {
        id: "base-rainfall-sim",
        name: "Rainfall simulation",
        source: "NOAA Atlas 14 / manual",
        defaultVisible: true,
        opacity: 50,
      },
    );
  }

  return [
    {
      key: "base",
      title: "Base",
      rows: baseRows,
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

async function fetchSiteTopography(engagementId: string) {
  const res = await fetch(`/api/engagements/${engagementId}/site-topography`);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`site-topography GET failed (${res.status})`);
  }
  return (await res.json()) as {
    status: string;
    propertySet?: { contoursGeoJson?: unknown };
  };
}

async function fetchSiteDrainage(engagementId: string) {
  const res = await fetch(`/api/engagements/${engagementId}/site-drainage`);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`site-drainage GET failed (${res.status})`);
  }
  return (await res.json()) as {
    status: string;
    propertySet?: Record<string, unknown>;
  };
}

async function fetchDesignStorms(engagementId: string) {
  const res = await fetch(
    `/api/engagements/${engagementId}/site-drainage/design-storms`,
  );
  if (!res.ok) return null;
  return (await res.json()) as {
    estimate?: {
      designStorms?: Array<{
        returnPeriodYears: number;
        depthInches: number;
      }>;
    };
  };
}

function formatGenerateLayersError(err: unknown): string {
  const apiErr = err as
    | {
        status?: number;
        data?: { error?: string; message?: string } | null;
      }
    | undefined;
  const data = apiErr?.data;
  return (
    data?.message ??
    (err as { message?: string } | undefined)?.message ??
    data?.error ??
    "Could not refresh site layers. Check that the API server is running."
  );
}

function summarizeGenerateLayersOutcomes(
  outcomes: ReadonlyArray<{ status: string; fromCache?: boolean }>,
): string {
  if (outcomes.length === 0) {
    return "Layer refresh finished.";
  }
  const ok = outcomes.filter((o) => o.status === "ok");
  const failed = outcomes.filter((o) => o.status === "failed");
  if (failed.length > 0 && ok.length === 0) {
    return `Layer refresh failed (${failed.length} adapter${failed.length === 1 ? "" : "s"}). See Site layers for details.`;
  }
  const allCached =
    ok.length > 0 && ok.every((o) => o.fromCache === true);
  if (allCached) {
    return "Layers are up to date (served from cache).";
  }
  const live = ok.filter((o) => o.fromCache !== true).length;
  if (live > 0) {
    return `Refreshed ${live} layer source${live === 1 ? "" : "s"}.`;
  }
  return "Layer refresh finished.";
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

function LayerChip({
  row,
  visible,
  onToggle,
}: {
  row: LayerRowSpec;
  visible: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="site-layer-chip"
      data-active={visible ? "true" : "false"}
      onClick={onToggle}
      aria-pressed={visible}
      title={`${row.name} (${row.source})`}
    >
      {visible ? <Eye size={12} aria-hidden /> : <EyeOff size={12} aria-hidden />}
      <span className="site-layer-chip-name">{row.name}</span>
      <span className="site-layer-chip-src">{row.source}</span>
    </button>
  );
}

function useMapCanvasHeight(min = 320) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(min);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      setHeight(Math.max(min, Math.floor(el.getBoundingClientRect().height)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [min]);

  return { ref, height };
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

const MAP_PANE_MIN_PX = 200;
const MAP_DETAILS_MIN_PX = 120;
const MAP_PANE_DEFAULT_RATIO = 0.45;

function SiteParcelInspector({
  engagement,
  site,
  geocode,
  briefing,
  contextItems,
  latest,
  onOpenPropertyIntel,
  onOpenSnapshots,
}: {
  engagement: EngagementDetailType;
  site: EngagementDetailType["site"];
  geocode: NonNullable<EngagementDetailType["site"]>["geocode"] | null;
  briefing: EngagementBriefing | null;
  contextItems: ContextItemSpec[];
  latest: EngagementDetailType["latestSnapshot"];
  onOpenPropertyIntel: () => void;
  onOpenSnapshots: () => void;
}) {
  return (
    <div className="site-workbench-inspector-body">
      <div>
        <h4 className="site-details-address-heading">
          {site?.address ?? engagement.name}
        </h4>
        <p className="site-details-applicant sc-mono-sm sc-accent-cyan">
          {engagement.applicantFirm ?? "Applicant not recorded"}
        </p>
      </div>
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
      <ParcelZoningCard
        hasGeocode={!!geocode}
        zoningCodeFromSite={site?.zoningCode ?? null}
        lotAreaSqftFromSite={site?.lotAreaSqft ?? null}
        briefing={briefing}
        siteContextHref={`/engagements/${engagement.id}?view=site&segment=property-intel`}
        onOpenSiteContext={onOpenPropertyIntel}
      />
      <EncumbrancesPanel
        engagementId={engagement.id}
        privateRestrictions={briefing?.privateRestrictions ?? null}
      />
      <div>
        <h4 className="site-details-subheading">Active context</h4>
        <div className="space-y-1">
          {contextItems.map((item) => (
            <ContextRow key={item.key} item={item} />
          ))}
        </div>
      </div>
      <div className="site-details-revit-block">
        <h4 className="site-details-subheading">Building on this site</h4>
        <button
          type="button"
          className="group w-full rounded-md p-3 text-left relative overflow-hidden site-details-revit-card"
          disabled={!latest}
          onClick={onOpenSnapshots}
        >
          <div className="absolute top-0 right-0 p-2 opacity-10">
            <Building2 size={56} aria-hidden />
          </div>
          <div className="relative z-10">
            <div className="flex items-center gap-2 mb-2">
              <div className="site-details-revit-icon">
                <Building2 size={14} aria-hidden />
              </div>
              <div>
                <div className="text-sm font-medium">Revit Model</div>
                <div className="text-[10px] sc-meta">
                  {latest
                    ? `Synced ${relativeTime(latest.receivedAt)}`
                    : "No snapshot yet"}
                </div>
              </div>
            </div>
            {latest && (
              <div className="flex gap-3 text-xs sc-meta">
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
              <div className="mt-3 text-xs font-medium flex items-center gap-1 sc-accent-cyan opacity-0 group-hover:opacity-100 transition-opacity">
                Open snapshots <ChevronRight size={14} aria-hidden />
              </div>
            )}
          </div>
        </button>
      </div>
    </div>
  );
}

export function SiteTab({
  engagement,
  onAddAddress,
  onOpenPropertyIntel,
  selectedElementRef,
  onClearSelectedElement,
  buildingGlbUrl,
  showBuilding,
  onToggleShowBuilding,
  bimModelLoading = false,
  initialCanvasMode,
  pendingBriefingSourceHighlight,
  onPendingBriefingSourceHighlightConsumed,
}: {
  engagement: EngagementDetailType;
  onAddAddress: () => void;
  onOpenPropertyIntel: (tab?: TabId) => void;
  selectedElementRef?: string | null;
  onClearSelectedElement?: () => void;
  buildingGlbUrl?: string | null;
  showBuilding?: boolean;
  onToggleShowBuilding?: (next: boolean) => void;
  bimModelLoading?: boolean;
  /** Deep-link: open the map canvas in 3D (e.g. finding element ref). */
  initialCanvasMode?: "map" | "3d";
  pendingBriefingSourceHighlight?: string | null;
  onPendingBriefingSourceHighlightConsumed?: () => void;
}) {
  const [, setLocation] = useLocation();
  const site = engagement.site;
  const geocode = site?.geocode ?? null;
  const coverageStatus = (
    engagement as EngagementDetailType & { coverageStatus?: string }
  ).coverageStatus;
  const coverageRequestedAt = (
    engagement as EngagementDetailType & { coverageRequestedAt?: string | null }
  ).coverageRequestedAt;
  const [coverageBusy, setCoverageBusy] = useState(false);
  const [coverageNotice, setCoverageNotice] = useState<string | null>(null);

  const briefingQuery = useGetEngagementBriefing(engagement.id, {
    query: {
      queryKey: getGetEngagementBriefingQueryKey(engagement.id),
      enabled: !!engagement.id,
    },
  });
  const briefing = briefingQuery.data?.briefing ?? null;
  const queryClient = useQueryClient();
  const [mapRenderEpoch, setMapRenderEpoch] = useState(0);
  const [layerRefreshNotice, setLayerRefreshNotice] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);
  const layerRefreshNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const showLayerRefreshNotice = useCallback(
    (tone: "success" | "error", message: string) => {
      if (layerRefreshNoticeTimerRef.current) {
        clearTimeout(layerRefreshNoticeTimerRef.current);
      }
      setLayerRefreshNotice({ tone, message });
      layerRefreshNoticeTimerRef.current = setTimeout(() => {
        setLayerRefreshNotice(null);
        layerRefreshNoticeTimerRef.current = null;
      }, 6000);
    },
    [],
  );

  useEffect(
    () => () => {
      if (layerRefreshNoticeTimerRef.current) {
        clearTimeout(layerRefreshNoticeTimerRef.current);
      }
    },
    [],
  );

  const generateLayersMutation = useGenerateEngagementLayers({
    mutation: {
      onSuccess: async (data) => {
        if (data.briefing) {
          queryClient.setQueryData(
            getGetEngagementBriefingQueryKey(engagement.id),
            { briefing: data.briefing },
          );
        }
        await queryClient.invalidateQueries({
          queryKey: getGetEngagementBriefingQueryKey(engagement.id),
        });
        await queryClient.invalidateQueries({
          queryKey: ["siteTopography", engagement.id],
        });
        setMapRenderEpoch((epoch) => epoch + 1);
        showLayerRefreshNotice(
          "success",
          summarizeGenerateLayersOutcomes(data.outcomes),
        );
      },
      onError: (err) => {
        showLayerRefreshNotice("error", formatGenerateLayersError(err));
      },
    },
  });

  const handleForceRefreshLayers = useCallback(() => {
    if (!geocode) {
      showLayerRefreshNotice(
        "error",
        "Add a site address before refreshing map layers.",
      );
      return;
    }
    generateLayersMutation.mutate({
      id: engagement.id,
      params: { forceRefresh: true },
    });
  }, [
    engagement.id,
    generateLayersMutation,
    geocode,
    showLayerRefreshNotice,
  ]);

  const topoQuery = useQuery({
    queryKey: ["siteTopography", engagement.id],
    queryFn: () => fetchSiteTopography(engagement.id),
    enabled: !!engagement.id && !!geocode,
    staleTime: 60_000,
    retry: false,
  });

  const drainageQuery = useQuery({
    queryKey: ["siteDrainage", engagement.id],
    queryFn: () => fetchSiteDrainage(engagement.id),
    enabled: !!engagement.id && !!geocode,
    staleTime: 60_000,
    retry: false,
  });

  const designStormsQuery = useQuery({
    queryKey: ["siteDrainageDesignStorms", engagement.id],
    queryFn: () => fetchDesignStorms(engagement.id),
    enabled: !!engagement.id && !!geocode,
    staleTime: 300_000,
    retry: false,
  });

  const hasDemContours = hasContoursGeoJson(topoQuery.data?.propertySet);
  const hasDrainage = hasDrainageGeoJson(drainageQuery.data?.propertySet);

  const [rainfallDepthInches, setRainfallDepthInches] = useState("4");
  const [drainageBusy, setDrainageBusy] = useState(false);

  const runDrainageRefresh = useCallback(async () => {
    if (!engagement.id) return;
    setDrainageBusy(true);
    try {
      const depth = Number.parseFloat(rainfallDepthInches);
      const res = await fetch(
        `/api/engagements/${engagement.id}/site-drainage/refresh`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            manualDepthInches: Number.isFinite(depth) ? depth : 4,
          }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          reason?: string;
        } | null;
        throw new Error(body?.reason ?? `Drainage refresh failed (${res.status})`);
      }
      await queryClient.invalidateQueries({
        queryKey: ["siteDrainage", engagement.id],
      });
      setMapRenderEpoch((epoch) => epoch + 1);
    } finally {
      setDrainageBusy(false);
    }
  }, [engagement.id, queryClient, rainfallDepthInches]);

  const layerGroups = useMemo(
    () => buildLayerGroups(briefing, !!geocode, hasDemContours, hasDrainage),
    [briefing, geocode, hasDemContours, hasDrainage],
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

  useEffect(() => {
    setVisibility((prev) => {
      const next = { ...prev };
      for (const g of layerGroups) {
        for (const r of g.rows) {
          if (!(r.id in next)) next[r.id] = r.defaultVisible;
        }
      }
      return next;
    });
  }, [layerGroups]);

  const toggleLayer = (id: string) =>
    setVisibility((prev) => ({
      ...prev,
      [id]: !(prev[id] ?? initialVisibility[id] ?? false),
    }));

  const isVisible = (id: string) =>
    visibility[id] ?? initialVisibility[id] ?? false;

  const [canvasMode, setCanvasMode] = useState<"map" | "3d">(
    initialCanvasMode ?? "map",
  );
  const [buildingOverlayState, setBuildingOverlayState] =
    useState<BuildingOverlayState>("idle");

  useEffect(() => {
    if (showBuilding && canvasMode === "map") {
      setCanvasMode("3d");
    }
  }, [showBuilding, canvasMode]);
  useEffect(() => {
    if (selectedElementRef) setCanvasMode("3d");
  }, [selectedElementRef]);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [mapExpanded, setMapExpanded] = useState(false);
  const [mapPaneHeight, setMapPaneHeight] = useState<number | null>(null);
  const layersPanelRef = useRef<HTMLDivElement>(null);
  const workbenchRef = useRef<HTMLDivElement>(null);
  const savedMapHeightRef = useRef<number | null>(null);
  const mapResizeDragRef = useRef<{ startY: number; startH: number } | null>(
    null,
  );

  const openSnapshots = useCallback(() => {
    setLocation(`/engagements/${engagement.id}`);
  }, [engagement.id, setLocation]);

  const scrollToLayersPanel = useCallback(() => {
    layersPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  useLayoutEffect(() => {
    const wb = workbenchRef.current;
    if (!wb || mapPaneHeight != null) return;
    const next = Math.round(
      Math.min(520, Math.max(280, wb.clientHeight * MAP_PANE_DEFAULT_RATIO)),
    );
    setMapPaneHeight(next);
  }, [mapPaneHeight]);

  const clampMapPaneHeight = useCallback((height: number) => {
    const wb = workbenchRef.current;
    const max = wb
      ? Math.max(MAP_PANE_MIN_PX, wb.clientHeight - MAP_DETAILS_MIN_PX)
      : 520;
    return Math.min(max, Math.max(MAP_PANE_MIN_PX, height));
  }, []);

  const onMapResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (mapExpanded) return;
      e.preventDefault();
      const base = mapPaneHeight ?? MAP_PANE_MIN_PX;
      mapResizeDragRef.current = { startY: e.clientY, startH: base };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [mapExpanded, mapPaneHeight],
  );

  const onMapResizePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = mapResizeDragRef.current;
      if (!drag) return;
      const next = drag.startH + (e.clientY - drag.startY);
      setMapPaneHeight(clampMapPaneHeight(next));
    },
    [clampMapPaneHeight],
  );

  const onMapResizePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!mapResizeDragRef.current) return;
      mapResizeDragRef.current = null;
      e.currentTarget.releasePointerCapture(e.pointerId);
    },
    [],
  );

  const { ref: mapHeroRef, height: mapHeight } = useMapCanvasHeight(280);
  const effectiveMapPaneHeight = mapPaneHeight ?? 280;

  const toggleMapExpanded = useCallback(() => {
    setMapExpanded((expanded) => {
      if (!expanded) {
        savedMapHeightRef.current = mapPaneHeight;
        return true;
      }
      if (savedMapHeightRef.current != null) {
        setMapPaneHeight(savedMapHeightRef.current);
      }
      return false;
    });
  }, [mapPaneHeight]);

  const toggleMapFullscreen = useCallback(() => {
    const el = mapHeroRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void el.requestFullscreen();
    }
  }, [mapHeroRef]);

  const briefingSources = briefing?.sources ?? [];
  const mapOverlaysRaw = useMemo(() => {
    const fromBriefing = extractBriefingSourceOverlays(briefingSources);
    const fromDem =
      hasDemContours && topoQuery.data?.propertySet?.contoursGeoJson
        ? extractContoursGeoJsonOverlays(
            topoQuery.data.propertySet.contoursGeoJson,
          )
        : [];
    const fromDrainage =
      hasDrainage && drainageQuery.data?.propertySet
        ? extractDrainageGeoJsonOverlays(drainageQuery.data.propertySet)
        : [];
    return [...fromBriefing, ...fromDem, ...fromDrainage];
  }, [
    briefingSources,
    hasDemContours,
    topoQuery.data,
    hasDrainage,
    drainageQuery.data,
  ]);

  const mapOverlays = useMemo(
    () =>
      filterOverlaysByLayerVisibility(
        mapOverlaysRaw,
        briefingSources,
        visibility,
        initialVisibility,
      ),
    [mapOverlaysRaw, briefingSources, visibility, initialVisibility],
  );

  const mapPin = useMemo(() => {
    if (!geocode) return null;
    return resolveMapPinPosition(
      { latitude: geocode.latitude, longitude: geocode.longitude },
      briefingSources,
    );
  }, [geocode, briefingSources]);

  const jurisdictionLabel = geocode
    ? [geocode.jurisdictionCity, geocode.jurisdictionState]
        .filter(Boolean)
        .join(", ") || engagement.jurisdiction || "—"
    : engagement.jurisdiction || "—";

  const latest = engagement.latestSnapshot;

  return (
    <div
      className="cockpit-tab site-tab-shell flex flex-col flex-1 min-h-0"
      data-testid="site-tab"
    >
      <TabHeader
        overline="Site · workspace"
        title="Site"
        subtitle="Drag the map edge to resize; parcel details float on the map."
        actions={
          <button className="sc-btn-ghost sc-btn-sm" onClick={onAddAddress}>
            Edit address
          </button>
        }
      />

      {coverageStatus && coverageStatus !== "ready" && (
        <div
          className="alert-block warning rounded-md mb-3 flex flex-wrap items-center gap-3"
          data-testid="site-coverage-banner"
          style={{ fontSize: 12, padding: "10px 12px" }}
        >
          <span>
            <strong>Code coverage:</strong> {coverageStatusLabel(coverageStatus)}
            {coverageStatus === "not_in_catalog" && (
              <> — No ingested code corpus for this location yet.</>
            )}
          </span>
          {shouldShowRequestCoverage(coverageStatus) && (
            <button
              type="button"
              className="sc-btn-secondary sc-btn-sm"
              data-testid="site-request-coverage"
              disabled={coverageBusy || !!coverageRequestedAt}
              onClick={() => {
                setCoverageBusy(true);
                setCoverageNotice(null);
                void requestEngagementCoverage(engagement.id)
                  .then(() =>
                    setCoverageNotice(
                      "Coverage request queued. We will notify you when code is available.",
                    ),
                  )
                  .catch((err: unknown) =>
                    setCoverageNotice(
                      err instanceof Error ? err.message : "Request failed",
                    ),
                  )
                  .finally(() => setCoverageBusy(false));
              }}
            >
              {coverageRequestedAt
                ? "Coverage requested"
                : coverageBusy
                  ? "Requesting…"
                  : "Request coverage"}
            </button>
          )}
          {coverageNotice && (
            <span className="sc-meta">{coverageNotice}</span>
          )}
        </div>
      )}

      <div
        ref={workbenchRef}
        className="site-workbench flex flex-col flex-1 min-h-0"
        data-map-expanded={mapExpanded ? "true" : "false"}
      >
        <div
          ref={mapHeroRef}
          className="site-hero-map"
          data-testid="site-tab-hero-map"
          style={
            mapExpanded
              ? undefined
              : { flex: `0 0 ${effectiveMapPaneHeight}px` }
          }
        >
          <div className="site-hero-map-float" aria-label="Map view controls">
            <div className="site-hero-map-float-tools">
            <button
              type="button"
              className="site-hero-float-btn"
              data-active={inspectorOpen ? "true" : "false"}
              onClick={() => setInspectorOpen((v) => !v)}
              data-testid="site-tab-toggle-inspector"
              title={inspectorOpen ? "Hide parcel details" : "Show parcel details"}
            >
              {inspectorOpen ? (
                <PanelRightClose size={14} aria-hidden />
              ) : (
                <PanelRightOpen size={14} aria-hidden />
              )}
              <span>Parcel</span>
            </button>
            <button
              type="button"
              className="site-hero-float-btn"
              data-active={canvasMode === "3d" ? "true" : "false"}
              onClick={() => setCanvasMode((m) => (m === "map" ? "3d" : "map"))}
              data-testid="site-tab-canvas-3d"
            >
              <Building2 size={14} aria-hidden />
              {canvasMode === "3d" ? "Map" : "3D"}
            </button>
            {canvasMode === "3d" ? (
              <SiteContext3DModelToggle
                buildingGlbUrl={buildingGlbUrl}
                showBuilding={showBuilding}
                onToggleShowBuilding={onToggleShowBuilding}
                buildingState={buildingOverlayState}
                bimModelLoading={bimModelLoading}
              />
            ) : null}
            <button
              type="button"
              className={`site-hero-float-btn${generateLayersMutation.isPending ? " site-hero-float-btn--pending" : ""}`}
              onClick={() => {
                scrollToLayersPanel();
                handleForceRefreshLayers();
              }}
              disabled={!geocode || generateLayersMutation.isPending}
              data-testid="site-tab-refresh"
              title={
                geocode
                  ? "Force refresh site layers and map overlays"
                  : "Add a site address to refresh layers"
              }
              aria-busy={generateLayersMutation.isPending}
            >
              <RefreshCw size={14} aria-hidden />
            </button>
            <button
              type="button"
              className="site-hero-float-btn"
              onClick={toggleMapExpanded}
              data-testid="site-tab-expand-map"
              title={mapExpanded ? "Restore split view" : "Expand map"}
            >
              {mapExpanded ? (
                <Minimize2 size={14} aria-hidden />
              ) : (
                <Expand size={14} aria-hidden />
              )}
              <span>{mapExpanded ? "Restore" : "Expand"}</span>
            </button>
            <button
              type="button"
              className="site-hero-float-btn"
              onClick={toggleMapFullscreen}
              data-testid="site-tab-fullscreen"
              title="Full screen"
            >
              <Expand size={14} aria-hidden />
            </button>
            </div>
            {layerRefreshNotice ? (
              <div
                className={`site-hero-map-float-notice site-hero-map-float-notice--${layerRefreshNotice.tone}`}
                role="status"
                aria-live="polite"
                data-testid="site-tab-layer-refresh-notice"
              >
                {layerRefreshNotice.message}
              </div>
            ) : null}
          </div>

          {geocode && (
            <aside
              className="site-workbench-inspector sc-scroll"
              data-open={inspectorOpen ? "true" : "false"}
              data-testid="site-tab-inspector"
              aria-label="Parcel and site context"
            >
              <div className="site-workbench-inspector-head">
                <Info size={14} className="sc-accent-cyan" aria-hidden />
                <span>Parcel &amp; context</span>
              </div>
              <SiteParcelInspector
                engagement={engagement}
                site={site}
                geocode={geocode}
                briefing={briefing ?? null}
                contextItems={contextItems}
                latest={latest}
                onOpenPropertyIntel={() => onOpenPropertyIntel("property-intel")}
                onOpenSnapshots={openSnapshots}
              />
            </aside>
          )}

          {geocode ? (
            <div className="site-hero-map-canvas">
              {canvasMode === "map" ? (
                <SiteMap
                  key={`site-map-${mapRenderEpoch}`}
                  latitude={mapPin!.latitude}
                  longitude={mapPin!.longitude}
                  addressLabel={site?.address ?? undefined}
                  overlays={mapOverlays}
                  height={mapHeight}
                />
              ) : (
                <div
                  className="site-workbench-3d-canvas"
                  data-testid="site-tab-3d-canvas"
                  style={{ height: mapHeight, minHeight: 280 }}
                >
                  <SiteContextViewer
                    sources={briefingSources}
                    selectedElementRef={selectedElementRef}
                    onClearSelectedElement={onClearSelectedElement}
                    buildingGlbUrl={buildingGlbUrl}
                    showBuilding={showBuilding}
                    onToggleShowBuilding={onToggleShowBuilding}
                    hideShowBuildingCheckbox
                    onBuildingStateChange={setBuildingOverlayState}
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="site-workbench-map-empty">
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
        </div>

        {!mapExpanded && (
          <div
            className="site-map-resize-handle"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize map"
            data-testid="site-tab-map-resize"
            onPointerDown={onMapResizePointerDown}
            onPointerMove={onMapResizePointerMove}
            onPointerUp={onMapResizePointerUp}
            onPointerCancel={onMapResizePointerUp}
          >
            <GripHorizontal size={14} aria-hidden />
          </div>
        )}

        <div
          className="site-details-panel sc-scroll"
          data-testid="site-details-panel"
          hidden={mapExpanded}
        >
          <section className="site-details-block site-details-block--header">
            <div className="site-workbench-toolbar-meta">
              <div className="site-workbench-project">
                <h2 className="site-workbench-project-name">{engagement.name}</h2>
                <StatusPill status={engagement.status} />
              </div>
              <p className="site-workbench-address">
                {site?.address ?? "Address not set"}
              </p>
              <div className="site-workbench-jurisdiction">
                <MapPin size={12} aria-hidden />
                <span>{jurisdictionLabel}</span>
              </div>
            </div>
            <div className="site-workbench-toolbar-actions">
              <button
                type="button"
                className="sc-btn-ghost sc-btn-sm"
                onClick={() => {
                  scrollToLayersPanel();
                  setUploadOpen(true);
                }}
                data-testid="site-tab-add-layer"
              >
                <Plus size={14} aria-hidden /> Add layer
              </button>
              <button
                type="button"
                className="sc-btn-ghost sc-btn-sm"
                onClick={() => {
                  scrollToLayersPanel();
                  setUploadOpen(true);
                }}
                data-testid="site-tab-upload-qgis"
              >
                <Upload size={14} aria-hidden /> Upload QGIS
              </button>
              <button
                type="button"
                className="sc-btn-ghost sc-btn-sm"
                onClick={() => {
                  scrollToLayersPanel();
                  handleForceRefreshLayers();
                }}
                disabled={!geocode || generateLayersMutation.isPending}
                data-testid="site-tab-generate-layers"
              >
                <LayersIcon size={14} aria-hidden /> Generate layers
              </button>
              <button
                type="button"
                className="sc-btn-secondary sc-btn-sm sc-accent-cyan"
                onClick={() => onOpenPropertyIntel("property-intel")}
                data-testid="site-tab-open-property-intel"
              >
                Property Intel
              </button>
            </div>
          </section>

          <section
            className="site-details-block site-details-block--layers-unified"
            aria-label="Site layers and adapters"
            data-testid="site-tab-layers-panel"
            id="site-layers-panel"
            ref={layersPanelRef}
          >
            <h3 className="site-details-block-title">Site layers</h3>
            <div
              className="site-workbench-layers sc-scroll"
              data-testid="site-tab-layer-palette"
            >
              {layerGroups.map((group) => (
                <div key={group.key} className="site-workbench-layer-group">
                  <span className="site-workbench-layer-group-label">
                    {group.title}
                  </span>
                  {group.rows.length === 0 ? (
                    <span className="site-workbench-layer-empty">None</span>
                  ) : (
                    group.rows.map((row) => (
                      <LayerChip
                        key={row.id}
                        row={row}
                        visible={isVisible(row.id)}
                        onToggle={() => toggleLayer(row.id)}
                      />
                    ))
                  )}
                </div>
              ))}
            </div>
            <div
              className="site-rainfall-panel"
              data-testid="site-rainfall-panel"
              aria-label="Rainfall simulation"
            >
              <h4 className="site-details-block-title">Rainfall simulation</h4>
              <p className="sc-meta">
                Enter a storm depth (e.g. 4 inches) or pick a NOAA Atlas 14
                design-storm preset, then run the hydrology pass on the
                catchment DEM.
              </p>
              <div className="site-rainfall-controls">
                <label className="sc-meta">
                  Depth (in)
                  <input
                    type="number"
                    min={0.1}
                    max={50}
                    step={0.5}
                    value={rainfallDepthInches}
                    onChange={(e) => setRainfallDepthInches(e.target.value)}
                    data-testid="site-rainfall-depth-input"
                  />
                </label>
                <div className="site-rainfall-presets">
                  {(designStormsQuery.data?.estimate?.designStorms ?? []).map(
                    (storm) => (
                      <button
                        key={storm.returnPeriodYears}
                        type="button"
                        className="sc-btn-ghost sc-btn-sm"
                        onClick={() =>
                          setRainfallDepthInches(String(storm.depthInches))
                        }
                        data-testid={`site-rainfall-preset-${storm.returnPeriodYears}yr`}
                      >
                        {storm.returnPeriodYears}-yr · {storm.depthInches.toFixed(1)} in
                      </button>
                    ),
                  )}
                </div>
                <button
                  type="button"
                  className="sc-btn-secondary sc-btn-sm"
                  disabled={!geocode || drainageBusy}
                  onClick={() => void runDrainageRefresh()}
                  data-testid="site-rainfall-run"
                >
                  {drainageBusy ? "Running…" : "Run drainage + rainfall sim"}
                </button>
              </div>
              {drainageQuery.data?.propertySet && (
                <p className="sc-meta" data-testid="site-rainfall-result-summary">
                  Last run:{" "}
                  {typeof drainageQuery.data.propertySet.rainfallDepthInches ===
                  "number"
                    ? `${drainageQuery.data.propertySet.rainfallDepthInches} in`
                    : "—"}{" "}
                  ({String(drainageQuery.data.propertySet.rainfallForcingSource ?? "—")})
                  · {String(drainageQuery.data.propertySet.flowLineCount ?? 0)} flow
                  lines
                </p>
              )}
            </div>
            <SiteContextTab
              engagement={engagement}
              embedded
              hideMapAnd3d
              panelFocus="layers"
              uploadOpen={uploadOpen}
              onUploadOpenChange={setUploadOpen}
              pendingBriefingSourceHighlight={pendingBriefingSourceHighlight}
              onPendingBriefingSourceHighlightConsumed={
                onPendingBriefingSourceHighlightConsumed
              }
            />
          </section>
        </div>
      </div>
    </div>
  );
}
