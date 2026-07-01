import type { PresetSpace } from "./types";

export const PRESET_SPACES: PresetSpace[] = [
  {
    id: "plan-review",
    label: "Plan Review",
    tiles: ["intake-queue", "compliance-run", "letter", "map"],
    layoutId: "4",
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
    tiles: ["sheet-extraction", "response-tasks", "map"],
    layoutId: "3r",
  },
];
