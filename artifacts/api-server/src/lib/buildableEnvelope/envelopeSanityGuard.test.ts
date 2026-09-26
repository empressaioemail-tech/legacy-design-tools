import { describe, expect, it } from "vitest";
import {
  ENVELOPE_SHAPE_UNRESOLVED,
  envelopeSanityReasons,
  outsideMaxFt,
} from "./envelopeSanityGuard";
import type { Ring } from "./geometry";

const M_PER_FT = 0.3048;

function ringFromLocal(pts: Array<{ x: number; y: number }>): Ring {
  const lng0 = -97.74;
  const lat0 = 30.27;
  const mLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const mLat = 111320;
  const closed = [...pts, pts[0]!];
  return closed.map((p) => [lng0 + p.x / mLng, lat0 + p.y / mLat]);
}

const w = 100 * M_PER_FT;
const h = 50 * M_PER_FT;
const parcel = ringFromLocal([
  { x: 0, y: 0 },
  { x: w, y: 0 },
  { x: w, y: h },
  { x: 0, y: h },
]);
const inset = ringFromLocal([
  { x: 5 * M_PER_FT, y: 20 * M_PER_FT },
  { x: w - 5 * M_PER_FT, y: 20 * M_PER_FT },
  { x: w - 5 * M_PER_FT, y: h - 10 * M_PER_FT },
  { x: 5 * M_PER_FT, y: h - 10 * M_PER_FT },
]);
const feet = [20, 5, 10, 5];

describe("envelope sanity guard", () => {
  it("passes a road-fronted inset inside the lot and inside the area band", () => {
    expect(
      envelopeSanityReasons({
        cleanedRing: parcel,
        originalRing: parcel,
        envelopeRing: inset,
        insetFeet: feet,
        edgeSignal: "road",
      }),
    ).toEqual([]);
  });

  it("fails a planted vertex outside the lot, and the sentence is not the machine code", () => {
    const shifted = ringFromLocal([
      { x: 5 * M_PER_FT, y: 20 * M_PER_FT },
      { x: w + 30 * M_PER_FT, y: -10 * M_PER_FT },
      { x: w - 5 * M_PER_FT, y: h - 10 * M_PER_FT },
      { x: 5 * M_PER_FT, y: h - 10 * M_PER_FT },
    ]);
    const reasons = envelopeSanityReasons({
      cleanedRing: parcel,
      originalRing: parcel,
      envelopeRing: shifted,
      insetFeet: feet,
      edgeSignal: "road",
    });
    expect(reasons).toContain("envelope-outside-ring");
    expect(ENVELOPE_SHAPE_UNRESOLVED).not.toContain("envelope-outside-ring");
    expect(outsideMaxFt(shifted, parcel)).toBeGreaterThan(1);
  });

  it("fails a planted sliver on the area band", () => {
    const sliver = ringFromLocal([
      { x: 20 * M_PER_FT, y: 25 * M_PER_FT },
      { x: 30 * M_PER_FT, y: 25 * M_PER_FT },
      { x: 30 * M_PER_FT, y: 35 * M_PER_FT },
      { x: 20 * M_PER_FT, y: 35 * M_PER_FT },
    ]);
    expect(
      envelopeSanityReasons({
        cleanedRing: parcel,
        originalRing: parcel,
        envelopeRing: sliver,
        insetFeet: feet,
        edgeSignal: "road",
      }),
    ).toContain("envelope-area-outside-band");
  });

  it("fails a shape front and a stub under 2 ft, and does not fail a sub-foot overshoot", () => {
    expect(
      envelopeSanityReasons({
        cleanedRing: parcel,
        originalRing: parcel,
        envelopeRing: inset,
        insetFeet: feet,
        edgeSignal: "shape",
      }),
    ).toEqual(["front-from-shape"]);

    const nick = 0.4 * M_PER_FT;
    const stubRing = ringFromLocal([
      { x: 0, y: 0 },
      { x: nick, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ]);
    expect(
      envelopeSanityReasons({
        cleanedRing: stubRing,
        originalRing: stubRing,
        envelopeRing: inset,
        insetFeet: [20, 0, 5, 10, 5],
        edgeSignal: "road",
      }),
    ).toContain("ring-stub-edge");

    const hair = ringFromLocal([
      { x: 5 * M_PER_FT, y: 20 * M_PER_FT },
      { x: w - 5 * M_PER_FT + 0.4 * M_PER_FT, y: 20 * M_PER_FT },
      { x: w - 5 * M_PER_FT + 0.4 * M_PER_FT, y: h - 10 * M_PER_FT },
      { x: 5 * M_PER_FT, y: h - 10 * M_PER_FT },
    ]);
    const reasons = envelopeSanityReasons({
      cleanedRing: parcel,
      originalRing: parcel,
      envelopeRing: hair,
      insetFeet: feet,
      edgeSignal: "road",
    });
    expect(reasons).not.toContain("envelope-outside-ring");
    expect(outsideMaxFt(hair, parcel)!).toBeLessThan(1);
  });
});
