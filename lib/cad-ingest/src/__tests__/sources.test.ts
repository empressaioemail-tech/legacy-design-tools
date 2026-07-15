/**
 * Per-CAD bulk-source registry tests (Rail B).
 *
 * These assert the acquisition posture of each corridor CAD — which
 * are open-fetch (fully automatable) vs manual-download (operator hands
 * the drop back) — and that the open-fetch dataset roles line up with
 * the roles the Orion CLI slots them into. Live-endpoint reachability
 * is proven separately by the bounded ingest sample, not in unit tests.
 */

import { describe, expect, it } from "vitest";
import { CAD_BULK_SOURCES, resolveCadBulkSource } from "../sources";

describe("CAD bulk-source registry", () => {
  it("resolves WCAD (48491) as an open-fetch source with the four Orion roles", () => {
    const src = resolveCadBulkSource("48491");
    expect(src?.mode).toBe("open-fetch");
    if (src?.mode !== "open-fetch") throw new Error("expected open-fetch");

    const roles = src.datasets.map((d) => d.kind).sort();
    expect(roles).toEqual(["land", "owner", "property", "segment"]);

    // Every dataset is a plain https GET on the Socrata portal.
    for (const ds of src.datasets) {
      expect(ds.url).toMatch(
        /^https:\/\/data\.wcad\.org\/api\/views\/[a-z0-9-]+\/rows\.csv\?accessType=DOWNLOAD$/,
      );
    }
    // Property is mandatory for the ingest to produce rows.
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

  it("returns undefined for counties with no registered bulk source", () => {
    // Travis/TCAD has no free bulk roll (PIA route, separate).
    expect(resolveCadBulkSource("48453")).toBeUndefined();
    expect(resolveCadBulkSource("99999")).toBeUndefined();
  });

  it("tolerates surrounding whitespace on the fips key", () => {
    expect(resolveCadBulkSource(" 48491 ")?.mode).toBe("open-fetch");
  });

  it("registry has exactly the two corridor CADs wired for v1", () => {
    expect(Object.keys(CAD_BULK_SOURCES).sort()).toEqual(["48209", "48491"]);
  });
});
