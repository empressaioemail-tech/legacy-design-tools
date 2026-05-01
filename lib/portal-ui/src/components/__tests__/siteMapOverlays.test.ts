// Unit tests for `extractBriefingSourceOverlays`. Lives in portal-ui
// because site-context has no vitest config of its own.

import { describe, it, expect } from "vitest";
import {
  extractBriefingSourceOverlays,
  type BriefingSourceForOverlays,
  type SiteMapOverlay,
} from "@workspace/site-context/client/overlays";

function mk(
  over: Partial<BriefingSourceForOverlays> &
    Pick<BriefingSourceForOverlays, "id" | "sourceKind" | "payload">,
): BriefingSourceForOverlays {
  return {
    id: over.id,
    layerKind: over.layerKind ?? "zoning",
    sourceKind: over.sourceKind,
    provider: over.provider ?? null,
    payload: over.payload,
    supersededAt: over.supersededAt ?? null,
  };
}

describe("extractBriefingSourceOverlays", () => {
  it("turns a Bastrop parcel ArcGIS polygon (wkid 4326) into a polygon overlay tagged as the local tier", () => {
    const overlays = extractBriefingSourceOverlays([
      mk({
        id: "src-parcel",
        sourceKind: "local-adapter",
        layerKind: "parcel",
        provider: "Bastrop County",
        payload: {
          kind: "parcel",
          parcel: {
            attributes: { OBJECTID: 1, PARCEL_ID: "01-12345" },
            geometry: {
              rings: [
                [
                  [-97.32, 30.11],
                  [-97.31, 30.11],
                  [-97.31, 30.12],
                  [-97.32, 30.12],
                  [-97.32, 30.11],
                ],
              ],
              spatialReference: { wkid: 4326 },
            },
          },
        },
      }),
    ]);

    expect(overlays).toHaveLength(1);
    const overlay = overlays[0]!;
    expect(overlay.kind).toBe("polygon");
    expect(overlay.tier).toBe("local");
    expect(overlay.sourceId).toBe("src-parcel");
    expect(overlay.layerKind).toBe("parcel");
    expect(overlay.provider).toBe("Bastrop County");
    if (overlay.kind !== "polygon") throw new Error("expected polygon");
    expect(overlay.positions).toHaveLength(1);
    // ArcGIS rings are [lng, lat]; Leaflet positions are [lat, lng].
    // The first ArcGIS vertex `[-97.32, 30.11]` should land as
    // `[30.11, -97.32]` in the projected ring.
    expect(overlay.positions[0]![0]).toEqual([30.11, -97.32]);
  });

  it("renders the federal-tier FEMA flood polygons via payload.features[].geometry, one polygon per feature", () => {
    const overlays = extractBriefingSourceOverlays([
      mk({
        id: "src-fema",
        sourceKind: "federal-adapter",
        layerKind: "flood-zone",
        provider: "FEMA NFHL",
        payload: {
          kind: "flood-zone",
          inSpecialFloodHazardArea: true,
          features: [
            {
              attributes: { FLD_ZONE: "AE" },
              geometry: {
                rings: [
                  [
                    [-97.5, 30.1],
                    [-97.4, 30.1],
                    [-97.4, 30.2],
                    [-97.5, 30.2],
                    [-97.5, 30.1],
                  ],
                ],
                spatialReference: { wkid: 4326 },
              },
            },
            {
              attributes: { FLD_ZONE: "X" },
              geometry: {
                rings: [
                  [
                    [-97.6, 30.1],
                    [-97.55, 30.1],
                    [-97.55, 30.15],
                    [-97.6, 30.15],
                    [-97.6, 30.1],
                  ],
                ],
                spatialReference: { wkid: 4326 },
              },
            },
          ],
        },
      }),
    ]);

    expect(overlays).toHaveLength(2);
    expect(overlays.every((o) => o.kind === "polygon")).toBe(true);
    expect(overlays.every((o) => o.tier === "federal")).toBe(true);
    expect(overlays.every((o) => o.sourceId === "src-fema")).toBe(true);
  });

  it("unprojects an ArcGIS Web Mercator (wkid 102100) ring into WGS84 lat/lng so legacy services render correctly", () => {
    // (0, 0) in Web Mercator should round-trip to (0, 0) lat/lng.
    // A Web Mercator y of ~3503549.84 corresponds to ~30° latitude.
    const overlays = extractBriefingSourceOverlays([
      mk({
        id: "src-wm",
        sourceKind: "state-adapter",
        layerKind: "zoning",
        provider: null,
        payload: {
          kind: "zoning",
          zoning: {
            attributes: {},
            geometry: {
              rings: [
                [
                  [0, 0],
                  [10000, 0],
                  [10000, 3503549.84],
                  [0, 3503549.84],
                  [0, 0],
                ],
              ],
              spatialReference: { wkid: 102100 },
            },
          },
        },
      }),
    ]);

    expect(overlays).toHaveLength(1);
    const overlay = overlays[0]!;
    if (overlay.kind !== "polygon") throw new Error("expected polygon");
    const ring = overlay.positions[0]!;
    expect(ring[0]![0]).toBeCloseTo(0, 5);
    expect(ring[0]![1]).toBeCloseTo(0, 5);
    // The third vertex [10000, 3503549.84] should be near (30°, ~0.0898°).
    expect(ring[2]![0]).toBeGreaterThan(29.9);
    expect(ring[2]![0]).toBeLessThan(30.1);
    expect(ring[2]![1]).toBeGreaterThan(0);
    expect(ring[2]![1]).toBeLessThan(0.2);
    expect(overlay.tier).toBe("state");
  });

  it("turns a USGS NED elevation point payload into a point overlay tagged as the federal tier", () => {
    const overlays = extractBriefingSourceOverlays([
      mk({
        id: "src-ned",
        sourceKind: "federal-adapter",
        layerKind: "elevation-point",
        provider: "USGS NED",
        payload: {
          kind: "elevation-point",
          elevationFeet: 412.7,
          units: "ft",
          location: { x: -97.3214, y: 30.1105 },
        },
      }),
    ]);

    expect(overlays).toHaveLength(1);
    const overlay = overlays[0]!;
    if (overlay.kind !== "point") throw new Error("expected point");
    expect(overlay.tier).toBe("federal");
    expect(overlay.position).toEqual([30.1105, -97.3214]);
  });

  it("returns no overlays for adapter responses that carry no geometry (FCC broadband, EPA EJScreen)", () => {
    const overlays = extractBriefingSourceOverlays([
      mk({
        id: "src-fcc",
        sourceKind: "federal-adapter",
        layerKind: "broadband-availability",
        provider: "FCC",
        payload: {
          kind: "broadband-availability",
          providerCount: 3,
          fastestDownstreamMbps: 1000,
          fastestUpstreamMbps: 100,
          providers: [],
        },
      }),
      mk({
        id: "src-epa",
        sourceKind: "federal-adapter",
        layerKind: "ejscreen-blockgroup",
        provider: "EPA",
        payload: {
          kind: "ejscreen-blockgroup",
          population: 1234,
          demographicIndexPercentile: 42,
          pm25Percentile: 50,
          ozonePercentile: 60,
          leadPaintPercentile: 30,
          raw: {},
        },
      }),
    ]);
    expect(overlays).toEqual([]);
  });

  it("silently skips malformed / partial geometry instead of throwing", () => {
    const overlays = extractBriefingSourceOverlays([
      // null payload — totally absent geometry
      mk({
        id: "src-null",
        sourceKind: "local-adapter",
        layerKind: "parcel",
        payload: { kind: "parcel", parcel: null },
      }),
      // rings exists but is not an array
      mk({
        id: "src-bad-rings",
        sourceKind: "local-adapter",
        layerKind: "parcel",
        payload: {
          kind: "parcel",
          parcel: { geometry: { rings: "not-an-array" } },
        },
      }),
      // ring with only 2 vertices (not enough for a polygon)
      mk({
        id: "src-degenerate",
        sourceKind: "local-adapter",
        layerKind: "parcel",
        payload: {
          kind: "parcel",
          parcel: {
            geometry: {
              rings: [
                [
                  [-97.32, 30.11],
                  [-97.31, 30.11],
                ],
              ],
              spatialReference: { wkid: 4326 },
            },
          },
        },
      }),
      // out-of-range WGS84 coordinates
      mk({
        id: "src-out-of-range",
        sourceKind: "local-adapter",
        layerKind: "parcel",
        payload: {
          kind: "parcel",
          parcel: {
            geometry: {
              rings: [
                [
                  [-9999, 9999],
                  [-9999, 9999],
                  [-9999, 9999],
                ],
              ],
              spatialReference: { wkid: 4326 },
            },
          },
        },
      }),
      // payload.location with NaN coordinates
      mk({
        id: "src-nan-point",
        sourceKind: "federal-adapter",
        layerKind: "elevation-point",
        payload: { location: { x: Number.NaN, y: 30 } },
      }),
    ]);
    expect(overlays).toEqual([]);
  });

  it("ignores superseded sources so the auditor only sees current-layer geometry", () => {
    const overlays = extractBriefingSourceOverlays([
      mk({
        id: "src-old",
        sourceKind: "local-adapter",
        layerKind: "parcel",
        provider: "Old run",
        supersededAt: "2026-01-01T00:00:00.000Z",
        payload: {
          kind: "parcel",
          parcel: {
            geometry: {
              rings: [
                [
                  [-97.32, 30.11],
                  [-97.31, 30.11],
                  [-97.31, 30.12],
                  [-97.32, 30.12],
                  [-97.32, 30.11],
                ],
              ],
              spatialReference: { wkid: 4326 },
            },
          },
        },
      }),
      mk({
        id: "src-current",
        sourceKind: "local-adapter",
        layerKind: "parcel",
        provider: "Current run",
        payload: {
          kind: "parcel",
          parcel: {
            geometry: {
              rings: [
                [
                  [-97.41, 30.21],
                  [-97.4, 30.21],
                  [-97.4, 30.22],
                  [-97.41, 30.22],
                  [-97.41, 30.21],
                ],
              ],
              spatialReference: { wkid: 4326 },
            },
          },
        },
      }),
    ]);

    expect(overlays).toHaveLength(1);
    expect(overlays[0]!.sourceId).toBe("src-current");
    expect(overlays[0]!.provider).toBe("Current run");
  });

  it("returns an empty array (and does not throw) when given an empty source list", () => {
    const overlays: SiteMapOverlay[] = extractBriefingSourceOverlays([]);
    expect(overlays).toEqual([]);
  });
});
