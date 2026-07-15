import { describe, it, expect } from "vitest";

// react's `act` needs this flag set for the state-update-in-act path.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
import { render, screen } from "@testing-library/react";
import { CortexShell, useEngagement } from "./index";
import type {
  AdminFunctionStatus,
  InitialSpaceSeed,
  SavedSpacesApi,
  SpaceSnapshot,
} from "./index";
import type { PresetSpace, TileCategory, TileDef } from "./types";

// A probe tile that surfaces the shared active-parcel so we can assert the
// deep-link seed's pinned context was adopted.
function ParcelProbe() {
  const { activeParcel } = useEngagement();
  return (
    <div>
      <span data-testid="probe-apn">{activeParcel.apn ?? "∅"}</span>
      <span data-testid="probe-jur">{activeParcel.jurisdiction ?? "∅"}</span>
      <span data-testid="probe-lat">{activeParcel.lat ?? "∅"}</span>
    </div>
  );
}

const TILES: TileDef[] = [
  {
    id: "map",
    label: "Map",
    category: "Site Analysis",
    status: "live",
    el: () => <div data-testid="tile-map">MAP</div>,
  },
  {
    id: "property-brief",
    label: "Property Brief",
    category: "Property Intel",
    status: "live",
    el: () => <ParcelProbe />,
  },
  {
    id: "intake",
    label: "Intake",
    category: "Compliance",
    status: "live",
    el: () => <div data-testid="tile-intake">INTAKE</div>,
  },
];

const PRESETS: PresetSpace[] = [
  { id: "plan-review", label: "Plan Review", tiles: ["intake"], layoutId: "1" },
];

const CATEGORIES: readonly TileCategory[] = [
  "Compliance",
  "Site Analysis",
  "Property Intel",
];

const noopSpaces: SavedSpacesApi = {
  savedSpaceId: (name) => `saved:${name}`,
  isSavedSpaceId: (id) => id.startsWith("saved:"),
  savedSpaceName: (id) => id.slice("saved:".length),
  loadSavedSpace: async () => null,
  saveCurrentSpace: async () => {},
  listSavedSpaceEntries: async () => [],
  deleteSavedSpace: async () => {},
};

const fetchAdminFunctions = async (): Promise<AdminFunctionStatus[]> => [];

function renderShell(seed?: InitialSpaceSeed | null) {
  return render(
    <CortexShell
      getTile={(id) => TILES.find((t) => t.id === id)}
      allTiles={TILES}
      categories={CATEGORIES}
      presets={PRESETS}
      fetchAdminFunctions={fetchAdminFunctions}
      savedSpaces={noopSpaces}
      initialSpaceSeed={seed ?? null}
    />,
  );
}

describe("CortexShell deep-link seed", () => {
  it("no seed mounts on the default preset (unchanged behavior)", () => {
    renderShell(null);
    // Default preset carries only the intake tile; the seeded map/brief tiles
    // are not part of the active set.
    expect(screen.getByTestId("tile-wrapper-intake")).toBeTruthy();
    expect(screen.queryByTestId("tile-wrapper-map")).toBeNull();
    expect(screen.queryByTestId("tile-wrapper-property-brief")).toBeNull();
  });

  it("a shared-space seed opens on the snapshot's tiles + pinned parcel context", async () => {
    const snapshot: SpaceSnapshot = {
      tileIds: ["map", "property-brief"],
      layoutId: "2h",
      colFr: [1, 1],
      rowFr: [1],
      layoutMode: "grid",
      context: {
        engagementId: null,
        apn: "SHARED-APN",
        jurisdiction: "bastrop-tx",
        address: "9 Shared Way",
        lat: 30.11,
        lng: -97.32,
      },
    };
    renderShell({ label: "Shared Space", snapshot });

    // The seeded tiles are the active set (not the default preset's intake).
    expect(screen.getByTestId("tile-wrapper-map")).toBeTruthy();
    expect(screen.getByTestId("tile-wrapper-property-brief")).toBeTruthy();
    expect(screen.queryByTestId("tile-wrapper-intake")).toBeNull();

    // The snapshot's pinned parcel context was adopted as the active parcel.
    // The probe content portals into its slot after the slot registers, so
    // resolve it async.
    const apn = await screen.findByTestId("probe-apn");
    expect(apn.textContent).toBe("SHARED-APN");
    expect(screen.getByTestId("probe-jur").textContent).toBe("bastrop-tx");
    expect(screen.getByTestId("probe-lat").textContent).toBe("30.11");
  });
});
