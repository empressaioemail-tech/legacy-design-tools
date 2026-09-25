import { describe, expect, it } from "vitest";
import {
  NEAREST_PARCELS_DEFAULT_CAP,
  NEAREST_PARCELS_MAX_CAP,
  clampNearestCap,
  dedupeNearestKnnRows,
  searchNearestParcels,
} from "./txgioNearestParcels";

describe("clampNearestCap", () => {
  it("defaults to 20 and caps at 50", () => {
    expect(clampNearestCap(undefined)).toBe(NEAREST_PARCELS_DEFAULT_CAP);
    expect(clampNearestCap(999)).toBe(NEAREST_PARCELS_MAX_CAP);
    expect(clampNearestCap(5)).toBe(5);
  });
});

describe("dedupeNearestKnnRows", () => {
  const rows = [
    { countyFips: "48021", propId: "100", distanceFt: 10 },
    { countyFips: "48021", propId: "0100", distanceFt: 11 },
    { countyFips: "48021", propId: "200", distanceFt: 20 },
    { countyFips: "48021", propId: "300", distanceFt: 30 },
    { countyFips: "48021", propId: "400", distanceFt: 40 },
    { countyFips: "48021", propId: "500", distanceFt: 50 },
  ];

  it("orders by distance and drops the subject parcel", () => {
    const out = dedupeNearestKnnRows({
      rows,
      subjectParcelNodeId: "48021:100",
      cap: 3,
    });
    expect(out.neighbors.map((n) => n.parcelNodeId)).toEqual([
      "48021:200",
      "48021:300",
      "48021:400",
    ]);
    expect(out.truncated).toBe(true);
  });

  it("does not declare truncation when the set fits", () => {
    const out = dedupeNearestKnnRows({
      rows: rows.slice(2, 4),
      subjectParcelNodeId: "48021:999",
      cap: 5,
    });
    expect(out.neighbors).toHaveLength(2);
    expect(out.truncated).toBe(false);
  });
});

describe("searchNearestParcels refusals", () => {
  it("refuses an out-of-scope county by name", async () => {
    const result = await searchNearestParcels({
      parcelNodeId: "48113:1",
      db: { query: async () => ({ rows: [] }) },
    });
    expect(result).toMatchObject({
      refused: true,
      code: "nearest_county_out_of_scope",
    });
  });

  it("refuses when the subject has no geometry row", async () => {
    const result = await searchNearestParcels({
      parcelNodeId: "48021:34137",
      db: { query: async () => ({ rows: [] }) },
    });
    expect(result).toMatchObject({
      refused: true,
      code: "nearest_subject_not_in_store",
    });
  });
});
