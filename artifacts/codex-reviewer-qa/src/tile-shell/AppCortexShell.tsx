import { CortexShell, type ActiveParcel } from "@hauska/tile-shell";
import { useCortexClient } from "@hauska/cortex-tiles";
import { getTile, ALL_TILES, TILE_CATEGORIES } from "./tiles";
import { PRESET_SPACES } from "./presets";
import { fetchAdminFunctions, exportEngagementPdf } from "../lib/planReviewBff";
import {
  isSavedSpaceId,
  listSavedSpaceEntries,
  loadSavedSpaces,
  saveCurrentSpace,
  deleteSavedSpace,
  savedSpaceId,
  savedSpaceName,
} from "../lib/workspaceSpaces";

/**
 * App-level wrapper that injects the still-app-resident tile registry,
 * presets, admin-functions client, and saved-space persistence into the
 * package-level CortexShell. Keeps @hauska/tile-shell free of any app-lib
 * dependency (the registry stays in the app per the dispatch).
 */
export default function AppCortexShell({
  initialPresetId = "plan-review",
}: {
  initialPresetId?: string;
}) {
  const client = useCortexClient();
  return (
    <CortexShell
      initialPresetId={initialPresetId}
      getTile={getTile}
      allTiles={ALL_TILES}
      categories={TILE_CATEGORIES}
      presets={PRESET_SPACES}
      fetchAdminFunctions={fetchAdminFunctions}
      onAddressSearch={async (query): Promise<ActiveParcel | null> => {
        // Setter #2: geocode the query and set the shared active-parcel.
        // The app owns the BFF client; @hauska/tile-shell stays client-free.
        // A bare address search scopes the parcel (apn / lat / lng /
        // jurisdiction) WITHOUT auto-creating an engagement — a read gesture
        // should not write. Address-scoped tiles keyed on apn/jurisdiction
        // (setbacks, map, compact property summary) react immediately;
        // engagement-scoped report runs still select/create via intake.
        const g = await client.geocode({ address: query });
        return {
          engagementId: null,
          apn: g.apn,
          jurisdiction: g.jurisdiction,
          address: g.address ?? query,
          lat: g.lat,
          lng: g.lng,
        };
      }}
      onExportEngagement={async (engagementId) => {
        // App owns the BFF client + the browser download; the SpaceBar in
        // @hauska/tile-shell only fires this callback. Trigger a download
        // (not a new tab), matching the DocumentViewerTile export path.
        const { url } = await exportEngagementPdf(engagementId);
        const a = document.createElement("a");
        a.href = url;
        a.download = `review-${engagementId.slice(0, 8)}.pdf`;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }}
      savedSpaces={{
        isSavedSpaceId,
        listSavedSpaceEntries,
        loadSavedSpaces,
        saveCurrentSpace,
        deleteSavedSpace,
        savedSpaceId,
        savedSpaceName,
      }}
    />
  );
}
