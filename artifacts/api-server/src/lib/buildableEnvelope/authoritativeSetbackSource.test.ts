import { describe, expect, it } from "vitest";

import {
  effectiveDateForTable,
  resolveAuthoritativeSetbacks,
} from "./authoritativeSetbackSource";

describe("resolveAuthoritativeSetbacks", () => {
  it("prefers codified ordinance over newer GIS per-parcel atom (Bastrop SF-1 class)", () => {
    const resolved = resolveAuthoritativeSetbacks({
      jurisdictionKey: "bastrop-city-tx",
      districtCode: "SF-1",
      atomRule: {
        front: 25,
        side: 5,
        rear: 25,
        side_corner: 15,
        sourceAdapter: "bastrop-city-gis-layer-23",
        extractedAt: "2026-07-31T00:00:00.000Z",
      },
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.sourceKind).toBe("codified-ordinance");
    expect(resolved!.scalars.front_ft).toBe(30);
    expect(resolved!.scalars.side_ft).toBe(10);
  });

  it("resolves Pflugerville SF-S from codified table", () => {
    const resolved = resolveAuthoritativeSetbacks({
      jurisdictionKey: "pflugerville-tx",
      districtCode: "SF-S",
      atomRule: null,
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.scalars).toEqual({
      front_ft: 25,
      side_ft: 7.5,
      rear_ft: 20,
      side_corner_ft: 15,
    });
    expect(resolved!.sourceKind).toBe("codified-ordinance");
  });
});

describe("effectiveDateForTable", () => {
  it("reads explicit effectiveDate when set on table JSON", () => {
    expect(
      effectiveDateForTable({
        jurisdictionKey: "x",
        jurisdictionDisplayName: "X",
        effectiveDate: "2026-04-14",
        districts: [],
      } as never),
    ).toBe("2026-04-14");
  });
});
