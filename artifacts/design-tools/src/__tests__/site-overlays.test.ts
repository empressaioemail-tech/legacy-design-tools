/**
 * P1-1 — briefing-source → SiteMap overlay extraction.
 *
 * `extractBriefingSourceOverlays` (lib/site-context/src/client/overlays.ts)
 * is the wiring between a Generate Layers run's persisted adapter results
 * and what the Site Context map actually draws. The verified P1-1 failure
 * was a payload-shape mismatch: the extractor only knew polygon `rings`,
 * so `ugrc:dem` (now polygon bands) and `grand-county-ut:roads` (polyline
 * `paths` / OSM ways) adapter results were fetched, logged, and persisted
 * but never rendered. These tests pin every payload shape the adapters
 * emit.
 */

import { describe, it, expect } from "vitest";
import {
  extractBriefingSourceOverlays,
  type BriefingSourceForOverlays,
} from "@workspace/site-context/client/overlays";

function source(
  payload: unknown,
  overrides: Partial<BriefingSourceForOverlays> = {},
): BriefingSourceForOverlays {
  return {
    id: "src-1",
    layerKind: "test-layer",
    sourceKind: "state-adapter",
    provider: "Test Provider",
    payload,
    supersededAt: null,
    ...overrides,
  };
}

describe("extractBriefingSourceOverlays", () => {
  it("renders an ArcGIS parcel polygon (WGS84 rings → [lat,lng])", () => {
    const overlays = extractBriefingSourceOverlays([
      source({
        kind: "parcel",
        parcel: {
          attributes: { PARCEL_ID: "abc" },
          geometry: {
            rings: [
              [
                [-109.55, 38.57],
                [-109.54, 38.57],
                [-109.54, 38.58],
                [-109.55, 38.57],
              ],
            ],
          },
        },
      }),
    ]);
    expect(overlays).toHaveLength(1);
    expect(overlays[0]!.kind).toBe("polygon");
    expect(overlays[0]!.kind === "polygon" && overlays[0]!.positions[0]![0]).toEqual([
      38.57, -109.55,
    ]);
  });

  it("renders ugrc:dem elevation-band polygons from payload.features[].geometry.rings", () => {
    const overlays = extractBriefingSourceOverlays([
      source({
        kind: "elevation-contours",
        featureCount: 1,
        features: [
          {
            attributes: { ContourEle: 4800 },
            geometry: {
              rings: [
                [
                  [-109.6, 38.5],
                  [-109.5, 38.5],
                  [-109.5, 38.6],
                  [-109.6, 38.5],
                ],
              ],
            },
          },
        ],
      }),
    ]);
    expect(overlays).toHaveLength(1);
    expect(overlays[0]!.kind).toBe("polygon");
  });

  it("renders county-GIS roads as polylines from payload.features[].geometry.paths", () => {
    const overlays = extractBriefingSourceOverlays([
      source(
        {
          kind: "roads",
          source: "county-gis",
          features: [
            {
              attributes: { NAME: "Kayenta Dr" },
              geometry: {
                paths: [
                  [
                    [-109.55, 38.57],
                    [-109.54, 38.575],
                  ],
                ],
              },
            },
          ],
        },
        { sourceKind: "local-adapter" },
      ),
    ]);
    expect(overlays).toHaveLength(1);
    expect(overlays[0]!.kind).toBe("polyline");
    expect(
      overlays[0]!.kind === "polyline" && overlays[0]!.positions[0]!.length,
    ).toBe(2);
  });

  it("renders OSM Overpass roads as a polyline from payload.elements", () => {
    const overlays = extractBriefingSourceOverlays([
      source(
        {
          kind: "roads",
          source: "osm",
          radiusMeters: 100,
          elements: [
            {
              type: "way",
              id: 1,
              geometry: [
                { lat: 38.57, lon: -109.55 },
                { lat: 38.571, lon: -109.549 },
                { lat: 38.572, lon: -109.548 },
              ],
            },
          ],
        },
        { sourceKind: "local-adapter" },
      ),
    ]);
    expect(overlays).toHaveLength(1);
    expect(overlays[0]!.kind).toBe("polyline");
    expect(
      overlays[0]!.kind === "polyline" && overlays[0]!.positions[0]!.length,
    ).toBe(3);
  });

  it("unprojects Web Mercator (wkid 102100) rings to WGS84", () => {
    const overlays = extractBriefingSourceOverlays([
      source({
        kind: "zoning",
        zoning: {
          geometry: {
            spatialReference: { wkid: 102100 },
            rings: [
              [
                [-12191000, 4660000],
                [-12190000, 4660000],
                [-12190000, 4661000],
                [-12191000, 4660000],
              ],
            ],
          },
        },
      }),
    ]);
    expect(overlays).toHaveLength(1);
    const [lat, lng] = (overlays[0]!.kind === "polygon" &&
      overlays[0]!.positions[0]![0]) as [number, number];
    // -12.19M / 4.66M Web Mercator lands in roughly SW Utah.
    expect(lat).toBeGreaterThan(37);
    expect(lat).toBeLessThan(39);
    expect(lng).toBeGreaterThan(-110);
    expect(lng).toBeLessThan(-109);
  });

  it("skips superseded sources", () => {
    const overlays = extractBriefingSourceOverlays([
      source(
        {
          kind: "parcel",
          parcel: {
            geometry: {
              rings: [
                [
                  [-109.55, 38.57],
                  [-109.54, 38.57],
                  [-109.54, 38.58],
                  [-109.55, 38.57],
                ],
              ],
            },
          },
        },
        { supersededAt: "2026-05-01T00:00:00.000Z" },
      ),
    ]);
    expect(overlays).toHaveLength(0);
  });

  it("skips malformed / unknown payloads without throwing", () => {
    expect(extractBriefingSourceOverlays([source(null)])).toEqual([]);
    expect(extractBriefingSourceOverlays([source({ kind: "mystery" })])).toEqual(
      [],
    );
    expect(
      extractBriefingSourceOverlays([
        source({ kind: "roads", source: "osm", elements: "not-an-array" }),
      ]),
    ).toEqual([]);
  });
});
