import type { PresetSpace } from "./types";

export const PRESET_SPACES: PresetSpace[] = [
  {
    id: "plan-review",
    label: "Plan Review",
    tiles: ["intake", "intake-queue", "document-viewer", "compliance-run", "letter", "map"],
    layoutId: "6",
  },
  {
    id: "site-analysis",
    label: "Site Analysis",
    tiles: ["topography", "drainage", "hydrology", "map"],
    layoutId: "3r",
  },
  {
    id: "property-intel",
    label: "Property Intel",
    tiles: ["property-brief", "hazard", "encumbrances", "map"],
    layoutId: "3l",
  },
  {
    id: "design-accelerator",
    label: "Design Accelerator",
    tiles: ["sheet-extraction", "document-viewer", "response-tasks", "map"],
    layoutId: "3r",
  },
  {
    // Print View — a lean layout for printing/exporting: findings + the review
    // letter only, no map. Pair with the SpaceBar Export action.
    id: "print",
    label: "Print View",
    tiles: ["compliance-run", "letter"],
    layoutId: "2h",
  },
];
