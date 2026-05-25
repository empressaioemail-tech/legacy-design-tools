import { describe, expect, it } from "vitest";
import {
  filterOverlaysByLayerVisibility,
  layerRowIdForBriefingSource,
} from "../client/layerVisibility";
import type { BriefingSourceForOverlays, SiteMapOverlay } from "../client/overlays";

const femaSource: BriefingSourceForOverlays = {
  id: "src-fema",
  layerKind: "fema:nfhl-flood-zone",
  sourceKind: "federal-adapter",
  provider: "FEMA",
  payload: {},
  supersededAt: null,
};

const parcelSource: BriefingSourceForOverlays = {
  id: "src-parcel",
  layerKind: "regrid:parcels",
  sourceKind: "national-aggregator",
  provider: "Regrid",
  payload: {},
  supersededAt: null,
};

const overlayFor = (sourceId: string): SiteMapOverlay => ({
  kind: "polygon",
  sourceId,
  layerKind: "test",
  provider: null,
  tier: "federal",
  positions: [[[40, -105], [40.001, -105], [40.001, -104.999]]],
});

describe("layerRowIdForBriefingSource", () => {
  it("maps federal and national sources to palette row ids", () => {
    expect(layerRowIdForBriefingSource(femaSource)).toBe("fed-fema");
    expect(layerRowIdForBriefingSource(parcelSource)).toBe("local-src-parcel");
  });
});

describe("filterOverlaysByLayerVisibility", () => {
  it("drops overlays when their palette row is toggled off", () => {
    const overlays = [overlayFor("src-fema"), overlayFor("src-parcel")];
    const visibility = { "fed-fema": false, "local-src-parcel": true };
    const initial = { "fed-fema": true, "local-src-parcel": true };
    const filtered = filterOverlaysByLayerVisibility(
      overlays,
      [femaSource, parcelSource],
      visibility,
      initial,
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.sourceId).toBe("src-parcel");
  });

  it("respects base-dem-contours toggle for topography overlays", () => {
    const topo: SiteMapOverlay = {
      kind: "polyline",
      sourceId: "site-topography",
      layerKind: "elevation-contour",
      provider: "USGS 3DEP",
      tier: "topography",
      positions: [[[40, -105], [40.001, -105]]],
    };
    const hidden = filterOverlaysByLayerVisibility(
      [topo],
      [],
      { "base-dem-contours": false },
      { "base-dem-contours": true },
    );
    expect(hidden).toHaveLength(0);
  });
});
