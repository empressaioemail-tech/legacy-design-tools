import { describe, expect, it } from "vitest";
import { buildDriverUrls } from "../webCodeFetch/drivers";

describe("buildDriverUrls national/texas profiles", () => {
  it("G-309 A15: builds no up.codes URL for ICC titles (IRC, IECC, A117.1; 2021 and 2024)", () => {
    const cases: Array<[string, string, string, string]> = [
      ["IRC-R301.1", "IRC 2021", "irc-2021", "austin_tx"],
      ["IECC-C402.4", "IECC 2021", "iecc-c-2021", "austin_tx"],
      ["A117.1-302", "A117.1 2017", "a1171-2017", "austin_tx"],
      ["IRC-R301.1", "IRC 2024", "irc-2024", "austin_tx"],
      ["IECC-R-R401.2", "IECC 2024", "iecc-r-2024", "austin_tx"],
    ];
    for (const [codeRef, edition, editionSlug, jurisdictionKey] of cases) {
      const urls = buildDriverUrls({
        codeRef,
        edition,
        editionSlug,
        jurisdictionKey,
        drivers: ["upcodes", "icc"],
      });
      expect(urls).toEqual([]);
    }
  });

  it("keeps Florida FBC 2023 paths for miami jurisdiction", () => {
    const urls = buildDriverUrls({
      codeRef: "FBC-M601.6",
      edition: "FBC 2023",
      editionSlug: "fbc-2023",
      jurisdictionKey: "miami_beach_fl",
      drivers: ["icc", "upcodes", "florida"],
    });
    expect(urls.some((u) => u.url.includes("iccsafe"))).toBe(false);
    expect(urls.some((u) => u.url.includes("florida-building-code-2023"))).toBe(
      true,
    );
  });
});
