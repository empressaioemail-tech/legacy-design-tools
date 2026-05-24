import type { ReactNode } from "react";
import type { EngagementDetail as EngagementDetailType } from "@workspace/api-client-react";
import { TabHeader } from "../cockpit/TabChrome";
import { SiteContextTab } from "./SiteContextTab";
import type { TabId } from "./urlState";
import {
  AlertTriangle,
  CloudRain,
  Droplet,
  MapPin,
  Mountain,
  Scale,
} from "lucide-react";

export function PropertyIntelTab({
  engagement,
  onNavigate,
  selectedElementRef,
  onClearSelectedElement,
  buildingGlbUrl,
  showBuilding,
  onToggleShowBuilding,
}: {
  engagement: EngagementDetailType;
  onNavigate: (tab: TabId) => void;
  selectedElementRef?: string | null;
  onClearSelectedElement?: () => void;
  buildingGlbUrl?: string | null;
  showBuilding?: boolean;
  onToggleShowBuilding?: (next: boolean) => void;
}) {
  return (
    <div
      className="cockpit-tab property-intel-tab flex flex-col flex-1 min-h-0"
      data-testid="property-intel-tab"
    >
      <TabHeader
        overline="Site · intelligence"
        title="Property Intel"
        subtitle="Generate federal, state, and local layers, then produce the Spec 51 briefing with cited sources — regulatory flood context today; dynamic runoff when hydrology ships."
        actions={
          <button
            type="button"
            className="sc-btn-ghost sc-btn-sm"
            data-testid="property-intel-open-map"
            onClick={() => onNavigate("site")}
          >
            <MapPin size={14} aria-hidden />
            Open map
          </button>
        }
      />

      <div className="property-intel-scroll sc-scroll flex flex-col flex-1 min-h-0 gap-4">
        <section
          className="property-intel-scope sc-card"
          data-testid="property-intel-scope"
          aria-labelledby="property-intel-scope-title"
        >
          <h2 id="property-intel-scope-title" className="property-intel-scope-title">
            What Property Intel covers
          </h2>
          <p className="property-intel-scope-lead">
            Understand parcel constraints before design starts: adapter-backed
            layers (FEMA flood, USGS elevation, zoning, utilities), a cited
            A–G briefing, and chat grounded via{" "}
            <code className="sc-mono-sm">read_site_context</code>. Section B
            (Threshold Issues) is where rain and flood facts belong — every claim
            ties to a briefing-source token.
          </p>
          <div className="property-intel-scope-grid">
            <ScopeCard
              icon={<Scale size={16} aria-hidden />}
              title="Regulatory (today)"
              testId="property-intel-scope-regulatory"
              body="FEMA flood zone, SFHA status, Base Flood Elevation vs ground elevation from USGS NED, plus local floodplain layers when adapters apply."
            />
            <ScopeCard
              icon={<CloudRain size={16} aria-hidden />}
              title="Storm scenarios (planned)"
              testId="property-intel-scope-scenario"
              body={
                <>
                  Questions like &ldquo;if it rains 4 inches&rdquo; need terrain
                  mesh, flow accumulation, and runoff visualization on the map.
                  Those hydrology passes are not shipped yet.
                </>
              }
            />
            <ScopeCard
              icon={<AlertTriangle size={16} aria-hidden />}
              title="Actionable next steps"
              testId="property-intel-scope-actionable"
              body="Today: cite zone vs elevation, flag civil/stormwater review, and checklist items in Section G. Later: pooling overlays and detention sizing cues on the map."
            />
          </div>
          <aside
            className="property-intel-rainfall-callout"
            data-testid="property-intel-rainfall-callout"
          >
            <CloudRain size={18} className="property-intel-rainfall-icon" aria-hidden />
            <div>
              <strong>Example: &ldquo;What if it rains 4 inches?&rdquo;</strong>
              <p>
                The platform answers the <em>regulatory</em> flood context (zone,
                BFE, parcel elevation, mapped floodplain status) in Section B and
                chat — not a runoff map or pooling simulation. Expect qualitative,
                citation-backed guidance until DEM ingest, scene assembly, and
                hydrology adapters land.
              </p>
            </div>
          </aside>
        </section>

        <section
          className="forty-d-overlays property-intel-roadmap"
          data-testid="property-intel-roadmap"
          aria-label="Planned map overlays"
        >
          <div className="forty-d-head">
            <h2 className="forty-d-title">Map overlays (roadmap)</h2>
            <span className="forty-d-sub">
              These completeness-lane overlays will dock on the{" "}
              <button
                type="button"
                className="property-intel-inline-link"
                onClick={() => onNavigate("site")}
              >
                Map
              </button>{" "}
              tab when adapters are wired.
            </span>
          </div>
          <ul className="forty-d-list">
            <RoadmapRow
              id="topo-contours"
              icon={<Mountain size={14} />}
              title="Topo contours"
              body="USGS NED-derived elevation contour overlay on the parcel map."
              requires="USGS NED adapter"
            />
            <RoadmapRow
              id="drainage-zones"
              icon={<Droplet size={14} />}
              title="Drainage zones"
              body="On-parcel drainage polygons and downstream flow lines."
              requires="Federal / state hydrography adapters"
            />
            <RoadmapRow
              id="rainfall-sim"
              icon={<CloudRain size={14} />}
              title="Rainfall simulation"
              body="Design-storm depth and predicted pooling for events such as a 4-inch rainfall."
              requires="Terrain mesh + hydrology pass"
            />
          </ul>
        </section>

        <section
          className="property-intel-workbench"
          aria-label="Layers, sources, and briefing"
        >
          <SiteContextTab
            engagement={engagement}
            embedded
            hideMapAnd3d
            panelFocus="briefing"
            onNavigateToMap={() => onNavigate("site")}
            selectedElementRef={selectedElementRef}
            onClearSelectedElement={onClearSelectedElement}
            buildingGlbUrl={buildingGlbUrl}
            showBuilding={showBuilding}
            onToggleShowBuilding={onToggleShowBuilding}
          />
        </section>
      </div>
    </div>
  );
}

function ScopeCard({
  icon,
  title,
  body,
  testId,
}: {
  icon: ReactNode;
  title: string;
  body: ReactNode;
  testId: string;
}) {
  return (
    <div className="property-intel-scope-card" data-testid={testId}>
      <div className="property-intel-scope-card-icon">{icon}</div>
      <h3 className="property-intel-scope-card-title">{title}</h3>
      <p className="property-intel-scope-card-body">{body}</p>
    </div>
  );
}

function RoadmapRow({
  id,
  icon,
  title,
  body,
  requires,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  body: string;
  requires: string;
}) {
  return (
    <li className="forty-d-row" data-testid={`forty-d-overlay-${id}`}>
      <span className="forty-d-icon" aria-hidden="true">
        {icon}
      </span>
      <div className="forty-d-text">
        <div className="forty-d-row-head">
          <span className="forty-d-row-title">{title}</span>
          <span className="forty-d-not-configured">Not configured</span>
        </div>
        <div className="forty-d-row-body">{body}</div>
        <div className="forty-d-row-meta">Requires: {requires}</div>
      </div>
      <label className="forty-d-toggle" title="Coming soon — adapter not configured">
        <input
          type="checkbox"
          disabled
          aria-label={`Enable ${title} overlay (coming soon)`}
        />
        <span className="forty-d-toggle-track" aria-hidden="true">
          <span className="forty-d-toggle-thumb" />
        </span>
      </label>
    </li>
  );
}
