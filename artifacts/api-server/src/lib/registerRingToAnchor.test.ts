import { describe, expect, it } from "vitest";

import { registerRingToAnchor } from "./parcelDrawStub";

// 906 FARM ST (48021:48026), 2026-10-06: the boundary ring's origin is the
// average of its 4 corners after lot-line scrubbing; the anchor averages the
// county ring's 5 vertices (one sits on the straight west edge), so the
// outline drew 56 ft off the aerial.
describe("registerRingToAnchor", () => {
  const corners: [number, number][] = [
    [0, 0],
    [300, 0],
    [300, 200],
    [0, 200],
  ];
  // The county ring, in the anchor's frame: same corners plus a collinear
  // vertex on the west edge, so its vertex average sits west of the corners'.
  const countyInAnchorFrame = (shiftX: number, shiftY: number): [number, number][] =>
    [...corners, [0, 40] as [number, number]].map(([x, y]) => [x + shiftX, y + shiftY]);

  it("finds the slide between the scrubbed ring and the anchor frame", () => {
    const ring = corners.map(([x, y]) => [x - 150, y - 100] as [number, number]);
    const reference = countyInAnchorFrame(-150 + 54.7, -100 + 12.1);
    const t = registerRingToAnchor(ring, reference);
    expect(t).not.toBeNull();
    expect(t![0]).toBeCloseTo(54.7, 5);
    expect(t![1]).toBeCloseTo(12.1, 5);
  });

  it("leaves an already-registered ring alone", () => {
    const ring = corners.map(([x, y]) => [x - 150, y - 100] as [number, number]);
    expect(registerRingToAnchor(ring, countyInAnchorFrame(-150, -100))).toBeNull();
  });

  it("refuses when the shapes do not match", () => {
    const ring = corners.map(([x, y]) => [x - 150, y - 100] as [number, number]);
    const other: [number, number][] = [[0, 0], [90, 10], [40, 170], [-60, 60]];
    expect(registerRingToAnchor(ring, other)).toBeNull();
  });
});
