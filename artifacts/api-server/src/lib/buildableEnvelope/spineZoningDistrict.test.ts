import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../routes/brokerageNodeFacets", () => ({
  loadBakedNodeFacetSnapshot: vi.fn(),
}));

import { loadBakedNodeFacetSnapshot } from "../../routes/brokerageNodeFacets";
import {
  resolveSpineZoningWhenGisAbsent,
  spineZoningProvenanceNote,
} from "./spineZoningDistrict";

const loadBaked = vi.mocked(loadBakedNodeFacetSnapshot);

const testEnvelopeBriefRefusal = {
  state: "refused" as const,
  code: "not-in-bake" as const,
  producer: "baked-envelope-facet" as const,
  supersededBy: "buildable-envelope" as const,
  reason: "test fixture",
};

describe("resolveSpineZoningWhenGisAbsent", () => {
  beforeEach(() => {
    loadBaked.mockReset();
    delete process.env.HAUSKA_RETRIEVAL_API_KEY;
    delete process.env.RETRIEVAL_API_KEY;
  });

  it("returns null when GIS zoningCode is present", async () => {
    const result = await resolveSpineZoningWhenGisAbsent("48021:33512", "P-5");
    expect(result).toBeNull();
    expect(loadBaked).not.toHaveBeenCalled();
  });

  it("reads district from baked facets when GIS is blank", async () => {
    loadBaked.mockResolvedValue({
      parcelNodeId: "48021:33512",
      facets: {
        zoning: { district: "P-5", jurisdictionKey: "bastrop_city_tx" },
      },
      snapshotAt: "2026-07-20T12:00:00.000Z",
      tier2: null,
      envelopeBriefRefusal: testEnvelopeBriefRefusal,
    });
    const result = await resolveSpineZoningWhenGisAbsent("48021:33512", null);
    expect(result).toEqual({
      district: "P-5",
      source: "baked-snapshot",
      snapshotAt: "2026-07-20T12:00:00.000Z",
    });
  });

  it("returns null when GIS blank and bake lacks district", async () => {
    loadBaked.mockResolvedValue({
      parcelNodeId: "48021:99999",
      facets: { zoning: null },
      snapshotAt: null,
      tier2: null,
      envelopeBriefRefusal: testEnvelopeBriefRefusal,
    });
    const result = await resolveSpineZoningWhenGisAbsent("48021:99999", "");
    expect(result).toBeNull();
  });

  it("formats baked provenance without inventing", () => {
    const note = spineZoningProvenanceNote({
      district: "P-5",
      source: "baked-snapshot",
      snapshotAt: "2026-07-20T12:00:00.000Z",
    });
    expect(note).toContain("P-5");
    expect(note).toContain("baked node-facet snapshot");
    expect(note).toContain("not invented");
  });
});
