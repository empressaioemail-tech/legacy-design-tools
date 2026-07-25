import { describe, expect, it } from "vitest";

import {
  BASTROP_P5_ROAD_CLASS_SETBACKS,
  roadClassSetbackFt,
} from "./roadClassSetbacks";

describe("roadClassSetbacks (27c WDLL 4)", () => {
  it("street front (residential) differs from alley rear on P-5", () => {
    const streetFront = roadClassSetbackFt(
      BASTROP_P5_ROAD_CLASS_SETBACKS,
      "P-5 Core",
      "residential",
      "front",
      () => 99,
    );
    const alleyRear = roadClassSetbackFt(
      BASTROP_P5_ROAD_CLASS_SETBACKS,
      "P-5 Core",
      "alley",
      "rear",
      () => 99,
    );
    expect(streetFront).toBe(15);
    expect(alleyRear).toBe(5);
    expect(alleyRear).not.toBe(streetFront);
  });

  it("falls back to flat axis when road-class cell missing", () => {
    const ft = roadClassSetbackFt(
      BASTROP_P5_ROAD_CLASS_SETBACKS,
      "P-5 Core",
      "highway",
      "front",
      () => 12,
    );
    expect(ft).toBe(12);
  });
});
