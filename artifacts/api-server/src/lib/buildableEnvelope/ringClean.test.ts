import { describe, expect, it } from "vitest";
import { labelEdges } from "./edgeLabeling";
import {
  cleanParcelRing,
  feetToMeters,
  insetPerEdge,
  openRing,
  ringAreaSqFt,
} from "./geometry";
import { insetFeetForLabeling } from "./edgeLabeling";

const LAT = 30.274;
const LNG = -97.725;

function at(eastFt: number, northFt: number): [number, number] {
  const mPerDegLat = (Math.PI / 180) * 6_378_137;
  const mPerDegLng = mPerDegLat * Math.cos((LAT * Math.PI) / 180);
  return [
    LNG + feetToMeters(eastFt) / mPerDegLng,
    LAT + feetToMeters(northFt) / mPerDegLat,
  ];
}

describe("cleanParcelRing", () => {
  it("drops a sub-2 ft stub and a collinear fragment, and keeps the corners", () => {
    // A ~35 x 69 ft lot with a 0.6 ft stub and a 3 ft collinear nick,
    // the shape of 48453:198414's ring.
    const dirty = [
      at(0, 0),
      at(35, 0),
      at(35.4, 0.6),
      at(35, 69),
      at(0, 69),
      at(0, 65.7),
      at(0, 0),
    ];
    const cleaned = cleanParcelRing(dirty);
    expect(openRing(cleaned).length).toBe(4);
    const shortest = openRing(cleaned).map((p, i, arr) => {
      const q = arr[(i + 1) % arr.length]!;
      const dx = (q[0] - p[0]) * Math.cos((LAT * Math.PI) / 180) * ((Math.PI / 180) * 6_378_137);
      const dy = (q[1] - p[1]) * ((Math.PI / 180) * 6_378_137);
      return Math.hypot(dx, dy) * 3.280839895;
    });
    expect(Math.min(...shortest)).toBeGreaterThan(2);
  });

  it("the cleaned inset area sits inside the edge-length band", () => {
    const dirty = [
      at(0, 0),
      at(35, 0),
      at(35.4, 0.6),
      at(35, 69),
      at(0, 69),
      at(0, 65.7),
      at(0, 0),
    ];
    const cleaned = cleanParcelRing(dirty);
    const mPerDegLat = (Math.PI / 180) * 6_378_137;
    const roadLat = LAT - feetToMeters(40) / mPerDegLat;
    const labeling = labelEdges({
      ring: cleaned,
      roads: [
        {
          name: "Bob Harrison St",
          polyline: [
            [LNG - 0.002, roadLat],
            [LNG + 0.002, roadLat],
          ],
        },
      ],
      situsAddress: "1403 BOB HARRISON ST",
    });
    expect(labeling).not.toBeNull();
    expect(labeling!.signal).toBe("road");
    const feet = insetFeetForLabeling(labeling!, {
      front_ft: 25,
      side_ft: 5,
      rear_ft: 10,
    });
    const inset = insetPerEdge(cleaned, feet);
    expect(inset.empty).toBe(false);
    const lot = ringAreaSqFt(cleaned);
    const drawn = inset.areaSqFt;
    // Orthogonal estimate on a ~35 x 69 ft lot at 25/5/10 is about 850.
    expect(drawn).toBeGreaterThan(500);
    expect(drawn).toBeLessThan(lot);
    expect(Math.abs(drawn - 850) / 850).toBeLessThan(0.35);
  });

  it("keeps a bend whose chord would leave the lot by more than a foot", () => {
    // A 100 x 40 ft lot whose north edge bows 15 ft. The retired 45°
    // accumulation would replace that bow with the chord.
    const dirty = [
      at(0, 0),
      at(100, 0),
      at(100, 40),
      at(75, 55),
      at(50, 55),
      at(25, 55),
      at(0, 40),
      at(0, 0),
    ];
    const cleaned = openRing(cleanParcelRing(dirty));
    const bulge = cleaned.some((p) => {
      const northFt =
        (p[1] - LAT) * ((Math.PI / 180) * 6_378_137) * 3.280839895;
      return northFt > 50;
    });
    expect(bulge).toBe(true);
  });
});
