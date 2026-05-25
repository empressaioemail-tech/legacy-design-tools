import { describe, it, expect } from "vitest";
import {
  DEFAULT_WORKSPACE_PREFERENCES,
  FEDERAL_ADAPTER_KEYS,
  filterAdaptersByPreferences,
  mergeWorkspacePreferences,
  pdfWatermarkText,
} from "../lib/workspacePreferences";

describe("workspacePreferences", () => {
  it("mergeWorkspacePreferences applies defaults for empty object", () => {
    const merged = mergeWorkspacePreferences({});
    expect(merged).toEqual(DEFAULT_WORKSPACE_PREFERENCES);
  });

  it("filterAdaptersByPreferences drops disabled federal keys", () => {
    const adapters = [
      { tier: "federal", adapterKey: FEDERAL_ADAPTER_KEYS.fema },
      { tier: "federal", adapterKey: FEDERAL_ADAPTER_KEYS.usgs },
      { tier: "local", adapterKey: "grand-county-ut:zoning" },
    ];
    const prefs = mergeWorkspacePreferences({
      federalLayers: { fema: false, usgs: true, epa: true, fcc: false },
      includeSiteLayers: false,
    });
    const filtered = filterAdaptersByPreferences(adapters, prefs);
    expect(filtered.map((a) => a.adapterKey)).toEqual([
      FEDERAL_ADAPTER_KEYS.usgs,
    ]);
  });

  it("pdfWatermarkText resolves draft preset", () => {
    expect(pdfWatermarkText("draft")).toContain("DRAFT");
  });
});
