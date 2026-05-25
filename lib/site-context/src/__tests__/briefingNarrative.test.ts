import { describe, expect, it } from "vitest";
import { hasBriefingNarrativeContent } from "../client/briefingNarrative";

describe("hasBriefingNarrativeContent", () => {
  it("returns false for null or empty sections", () => {
    expect(hasBriefingNarrativeContent(null)).toBe(false);
    expect(hasBriefingNarrativeContent({})).toBe(false);
    expect(
      hasBriefingNarrativeContent({
        sectionA: "   ",
        sectionB: null,
      }),
    ).toBe(false);
  });

  it("returns true when any A–G section has body text", () => {
    expect(
      hasBriefingNarrativeContent({
        sectionD: "USGS elevation 5,200 ft.",
      }),
    ).toBe(true);
  });
});
