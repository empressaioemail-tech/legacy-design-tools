/**
 * Per-CAD bulk-source registry tests (Rail B).
 */

import { describe, expect, it } from "vitest";
import {
  CAD_BULK_SOURCES,
  DCAD_CERTIFIED_OPEN_FETCH_URL,
  resolveCadBulkSource,
} from "../sources";

describe("CAD bulk-source registry", () => {
  it("resolves WCAD (48491) as an open-fetch source with the four Orion roles", () => {
    const src = resolveCadBulkSource("48491");
    expect(src?.mode).toBe("open-fetch");
    if (src?.mode !== "open-fetch") throw new Error("expected open-fetch");

    const roles = src.datasets.map((d) => d.kind).sort();
    expect(roles).toEqual(["land", "owner", "property", "segment"]);

    for (const ds of src.datasets) {
      expect(ds.url).toMatch(
        /^https:\/\/data\.wcad\.org\/api\/views\/[a-z0-9-]+\/rows\.csv\?accessType=DOWNLOAD$/,
      );
    }
    expect(src.datasets.some((d) => d.kind === "property")).toBe(true);
  });

  it("resolves Hays (48209) as a manual-download source with operator instructions", () => {
    const src = resolveCadBulkSource("48209");
    expect(src?.mode).toBe("manual-download");
    if (src?.mode !== "manual-download") throw new Error("expected manual");
    expect(src.page).toContain("hayscad.com");
    expect(src.instructions).toMatch(/--county=48209/);
    expect(src.instructions).toMatch(/--file=/);
  });

  it("resolves Tarrant (48439) as open-fetch-zip residential PropertyData", () => {
    const src = resolveCadBulkSource("48439");
    expect(src?.mode).toBe("open-fetch-zip");
    if (src?.mode !== "open-fetch-zip") throw new Error("expected zip");
    expect(src.url).toContain("PropertyData(Delimited)_R.ZIP");
    expect(src.label).toBe("PropertyData(Delimited)_R.ZIP");
  });

  it("resolves Dallas (48113) as open-fetch-zip DCAD certified", () => {
    const src = resolveCadBulkSource("48113");
    expect(src?.mode).toBe("open-fetch-zip");
    if (src?.mode !== "open-fetch-zip") throw new Error("expected zip");
    expect(src.url).toBe(DCAD_CERTIFIED_OPEN_FETCH_URL);
    expect(src.label).toContain("DCAD2026_CERTIFIED");
  });

  it("returns undefined for counties with no registered bulk source", () => {
    expect(resolveCadBulkSource("48453")).toBeUndefined();
    expect(resolveCadBulkSource("99999")).toBeUndefined();
  });

  it("tolerates surrounding whitespace on the fips key", () => {
    expect(resolveCadBulkSource(" 48491 ")?.mode).toBe("open-fetch");
  });

  it("registry includes corridor + bulk_primary counties", () => {
    expect(Object.keys(CAD_BULK_SOURCES).sort()).toEqual([
      "48113",
      "48209",
      "48439",
      "48491",
    ]);
  });
});
