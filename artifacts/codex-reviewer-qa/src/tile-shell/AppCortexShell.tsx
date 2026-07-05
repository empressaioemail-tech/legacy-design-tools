import { useMemo } from "react";
import { CortexShell, type ActiveParcel } from "@empressaio/tile-shell";
import { useCortexClient } from "@empressaio/cortex-tiles";
import { getTile, ALL_TILES, TILE_CATEGORIES } from "./tiles";
import { PRESET_SPACES } from "./presets";
import { fetchAdminFunctions, exportEngagementPdf } from "../lib/planReviewBff";
import { createSavedSpacesApi } from "../lib/workspaceSpaces";

/**
 * App-level wrapper that injects the still-app-resident tile registry,
 * presets, admin-functions client, saved-space persistence (server-backed via
 * the BFF, localStorage fast-path), and the header address search into the
 * package-level CortexShell. Keeps @empressaio/tile-shell free of any app-lib
 * dependency (the registry + BFF client stay in the app per the dispatch).
 */
export default function AppCortexShell({
  initialPresetId = "plan-review",
}: {
  initialPresetId?: string;
}) {
  const client = useCortexClient();
  const savedSpaces = useMemo(() => createSavedSpacesApi(client), [client]);

  // Geocode a free-text query to a parcel for the shared active-parcel context.
  // A bare address search scopes the parcel (apn / lat / lng / jurisdiction)
  // WITHOUT auto-creating an engagement — a read gesture should not write.
  const geocodeToParcel = async (
    query: string,
  ): Promise<ActiveParcel | null> => {
    const g = await client.geocode({ address: query });
    return {
      engagementId: null,
      apn: g.apn,
      jurisdiction: g.jurisdiction,
      address: g.address ?? query,
      lat: g.lat,
      lng: g.lng,
    };
  };

  return (
    <CortexShell
      initialPresetId={initialPresetId}
      getTile={getTile}
      allTiles={ALL_TILES}
      categories={TILE_CATEGORIES}
      presets={PRESET_SPACES}
      fetchAdminFunctions={fetchAdminFunctions}
      savedSpaces={savedSpaces}
      onAddressSearch={geocodeToParcel}
      onAddressPreview={geocodeToParcel}
      onExportEngagement={async (engagementId) => {
        const { url } = await exportEngagementPdf(engagementId);
        const a = document.createElement("a");
        a.href = url;
        a.download = `review-${engagementId.slice(0, 8)}.pdf`;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }}
    />
  );
}
