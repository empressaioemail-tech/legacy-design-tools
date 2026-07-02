import { CortexShell } from "@hauska/tile-shell";
import { getTile, ALL_TILES, TILE_CATEGORIES } from "./tiles";
import { PRESET_SPACES } from "./presets";
import { fetchAdminFunctions } from "../lib/planReviewBff";
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
  return (
    <CortexShell
      initialPresetId={initialPresetId}
      getTile={getTile}
      allTiles={ALL_TILES}
      categories={TILE_CATEGORIES}
      presets={PRESET_SPACES}
      fetchAdminFunctions={fetchAdminFunctions}
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
