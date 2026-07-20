/**
 * F4k end-to-end proof: once a Hays-County setback table is registered, the
 * buildable-envelope derive path (getSetbackTable -> mapDistrict -> labelEdges
 * -> deriveBuildableEnvelope) produces a real cited polygon instead of the
 * "no-setbacks" 404 the route returns when getSetbackTable is null.
 *
 * This drives the exact composition the route (brokeragePlaceBuildableEnvelope)
 * runs, keyed by the SYNTHESIZED jurisdiction key (`dripping_springs_tx` etc.),
 * on a real-coordinate rectangular parcel large enough that the setbacks don't
 * consume the lot. It is the local stand-in for a live POST to the deployed
 * envelope route for a Dripping Springs / Kyle / Buda address.
 */

import { describe, it, expect } from "vitest";
import { getSetbackTable } from "@workspace/adapters";
import { feetToMeters, type Ring } from "./geometry";
import { labelEdges } from "./edgeLabeling";
import { mapDistrict } from "./districtMapping";
import { deriveBuildableEnvelope } from "./derive";

// A generous rectangular lot so residential setbacks leave buildable area.
const LNG0 = -98.0;
const LAT0 = 30.1;

function rectRing(wFt = 150, hFt = 250): Ring {
  const mPerDegLat = (Math.PI / 180) * 6_378_137;
  const mPerDegLng = mPerDegLat * Math.cos((LAT0 * Math.PI) / 180);
  const halfW = feetToMeters(wFt) / 2 / mPerDegLng;
  const halfH = feetToMeters(hFt) / 2 / mPerDegLat;
  return [
    [LNG0 - halfW, LAT0 - halfH],
    [LNG0 + halfW, LAT0 - halfH],
    [LNG0 + halfW, LAT0 + halfH],
    [LNG0 - halfW, LAT0 + halfH],
    [LNG0 - halfW, LAT0 - halfH],
  ];
}

function roadSouthOf(): [number, number][] {
  const mPerDegLat = (Math.PI / 180) * 6_378_137;
  const roadLat = LAT0 - feetToMeters(150) / mPerDegLat;
  return [
    [LNG0 - 0.002, roadLat],
    [LNG0 + 0.002, roadLat],
  ];
}

const CASES: { synthKey: string; zoningCode: string; expectDistrict: string }[] =
  [
    {
      synthKey: "dripping_springs_tx",
      zoningCode: "SF-2",
      expectDistrict: "SF-2 Single-Family Residential Moderate Density",
    },
    {
      synthKey: "kyle_tx",
      zoningCode: "R-1-1",
      expectDistrict: "R-1-1 Single-Family Residential 1",
    },
    {
      synthKey: "buda_tx",
      zoningCode: "R-2",
      expectDistrict: "R-2 Suburban Residential",
    },
  ];

describe("F4k — Hays buildable envelope draws once the setback table exists", () => {
  for (const c of CASES) {
    it(`${c.synthKey}: derives a cited, non-empty envelope`, () => {
      // 1) The route's step 2: resolve the setback table by synthesized key.
      const table = getSetbackTable(c.synthKey);
      expect(table).not.toBeNull(); // was null => route returns "no-setbacks".

      // 2) District mapping (route step 3).
      const district = mapDistrict(table!, c.zoningCode);
      expect(district).not.toBeNull();
      expect(district!.district.district_name).toBe(c.expectDistrict);

      // 3) Edge labeling (route step 4).
      const ring = rectRing();
      const labeling = labelEdges({ ring, road: roadSouthOf() });
      expect(labeling).not.toBeNull();

      // 4) Derive (route step 5) — the honest polygon the map draws.
      const derived = deriveBuildableEnvelope({
        ring,
        table: table!,
        district: district!,
        labeling: labeling!,
      });

      // The envelope exists (non-empty) and carries a real polygon + citation.
      expect(derived.empty).toBe(false);
      expect(derived.geojson.features.length).toBe(1);
      const feat = derived.geojson.features[0]!;
      expect(feat.geometry?.type).toBe("Polygon");
      expect(feat.geometry!.coordinates[0]!.length).toBeGreaterThanOrEqual(4);
      expect(feat.properties.buildableAreaSqFt).toBeGreaterThan(0);
      expect(derived.citationUrl).toMatch(/^https:\/\//);
      expect(feat.properties.setbacks.district).toBe(c.expectDistrict);
    });
  }
});
