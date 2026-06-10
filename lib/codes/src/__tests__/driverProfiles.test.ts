import { describe, expect, it } from "vitest";
import { buildDriverUrls } from "../webCodeFetch/drivers";

describe("buildDriverUrls national/texas profiles", () => {
  it("builds Texas UpCodes + ICC URLs for IRC 2021", () => {
    const urls = buildDriverUrls({
      codeRef: "IRC-R301.1",
      edition: "IRC 2021",
      editionSlug: "irc-2021",
      jurisdictionKey: "austin_tx",
      drivers: ["icc", "upcodes"],
    });
    expect(urls.some((u) => u.url.includes("up.codes/viewer/texas/irc-2021"))).toBe(
      true,
    );
    expect(urls.some((u) => u.url.includes("IRC2021P1"))).toBe(true);
  });

  it("uses municipality slug for IECC (no statewide texas/iecc-2021)", () => {
    const urls = buildDriverUrls({
      codeRef: "IECC-C402.4",
      edition: "IECC 2021",
      editionSlug: "iecc-2021",
      jurisdictionKey: "austin_tx",
      drivers: ["upcodes"],
    });
    expect(urls.some((u) => u.url.includes("up.codes/viewer/austin/iecc-2021"))).toBe(
      true,
    );
    expect(urls.some((u) => u.url.includes("viewer/texas/iecc-2021"))).toBe(false);
  });

  it("uses municipality slug for A117.1-2017", () => {
    const urls = buildDriverUrls({
      codeRef: "A117.1-302",
      edition: "A117.1 2017",
      editionSlug: "a1171-2017",
      jurisdictionKey: "austin_tx",
      drivers: ["upcodes", "icc"],
    });
    expect(
      urls.some((u) => u.url.includes("up.codes/viewer/austin/icc-a117.1-2017")),
    ).toBe(true);
    expect(urls.some((u) => u.url.includes("A11712017"))).toBe(true);
  });

  it("keeps Florida FBC 2023 paths for miami jurisdiction", () => {
    const urls = buildDriverUrls({
      codeRef: "FBC-M601.6",
      edition: "FBC 2023",
      editionSlug: "fbc-2023",
      jurisdictionKey: "miami_beach_fl",
      drivers: ["icc", "upcodes", "florida"],
    });
    expect(urls.some((u) => u.url.includes("FLMECH2023P1"))).toBe(true);
    expect(urls.some((u) => u.url.includes("florida-building-code-2023"))).toBe(
      true,
    );
  });
});
