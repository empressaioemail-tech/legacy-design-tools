import { describe, it, expect } from "vitest";
import { mergeSiteDrainageIntoBriefingSections } from "../lib/siteDrainageBriefing";

describe("mergeSiteDrainageIntoBriefingSections", () => {
  it("appends site-drainage citations to sections B and E", () => {
    const sections = {
      a: "Summary.",
      b: "FEMA baseline.",
      c: "Zoning.",
      d: "Utilities.",
      e: "Parcel envelope.",
      f: "Neighbors.",
      g: "Next steps.",
    };
    const merged = mergeSiteDrainageIntoBriefingSections(sections, {
      engagementId: "eng-1",
      rainfallDepthInches: 4,
      forcingSource: "manual",
      flowLineCount: 3,
      drainageZoneCount: 2,
      hydrologyLibrary: "native-d8",
    });
    expect(merged.b).toContain("{{atom|site-drainage|eng-1|");
    expect(merged.e).toContain("4 in");
    expect(merged.b).toContain("3 primary flow path");
  });
});
