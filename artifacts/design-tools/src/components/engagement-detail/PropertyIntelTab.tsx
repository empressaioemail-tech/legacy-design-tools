import type { EngagementDetail as EngagementDetailType } from "@workspace/api-client-react";
import { TabHeader } from "../cockpit/TabChrome";
import { ClientBriefCard } from "./ClientBriefCard";
import { SiteContextTab } from "./SiteContextTab";
import type { TabId } from "./urlState";
import { MapPin } from "lucide-react";

export function PropertyIntelTab({
  engagement,
  onNavigate,
  onNavigateToMapWithSource,
  selectedElementRef,
  onClearSelectedElement,
  buildingGlbUrl,
  showBuilding,
  onToggleShowBuilding,
}: {
  engagement: EngagementDetailType;
  onNavigate: (tab: TabId) => void;
  onNavigateToMapWithSource: (sourceId: string) => void;
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
        subtitle="Generate layers and the cited A–G briefing. Map visibility and adapters live on the Map tab."
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
        <ClientBriefCard engagement={engagement} />

        <p className="property-intel-scope-lead sc-meta sc-card p-4" data-testid="property-intel-scope">
          Adapter-backed regulatory context (FEMA flood, elevation, local overlays)
          with citation tokens that drill into the{" "}
          <button
            type="button"
            className="property-intel-inline-link"
            onClick={() => onNavigate("site")}
          >
            Map
          </button>
          .
        </p>

        <section
          className="property-intel-workbench"
          aria-label="Sources and briefing"
        >
          <SiteContextTab
            engagement={engagement}
            embedded
            hideMapAnd3d
            panelFocus="briefing"
            onNavigateToMap={onNavigateToMapWithSource}
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
