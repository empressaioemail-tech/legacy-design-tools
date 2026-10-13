/**
 * cityLimitsFactFromParcelRecord.ts — the PARCEL-B-SLATE1 adapter.
 * Fixtures mirror LIVE parcel_record data, read 2026-09-02 via the RO
 * credential: a real value cell (city name string), a real absent-verified
 * basis shape ({disposition: "unincorporated", ...}), distinct from wells/
 * specialDistricts' {finding: "..."} shape.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  memoryParcelRecordStore,
  resetParcelRecordQueryableForTests,
  setParcelRecordQueryableForTests,
} from "./parcelRecordCellRead";
import {
  CITY_LIMITS_RAIL_KEY,
  cityLimitsFactFromParcelRecord,
} from "./cityLimitsFactFromParcelRecord";

const POINT = { longitude: -97.315, latitude: 30.11 };

afterEach(() => {
  resetParcelRecordQueryableForTests();
});

describe("cityLimitsFactFromParcelRecord", () => {
  it("a malformed parcelNodeId maps to unmeasured, carrying the queryPoint through unchanged", async () => {
    const result = await cityLimitsFactFromParcelRecord("not-a-valid-id", POINT);
    expect(result.status).toBe("unmeasured");
    expect(result.etjStatus).toBe("unresolved");
    expect(result.queryPoint).toEqual(POINT);
  });

  it("no store configured maps to unmeasured with the parcel-record-store-not-configured reason embedded in basis", async () => {
    setParcelRecordQueryableForTests(null);
    const result = await cityLimitsFactFromParcelRecord("48021:34137", POINT);
    expect(result.status).toBe("unmeasured");
    expect(result.basis).toMatch(/store-not-configured/);
  });

  it("LIVE-SHAPE: a real value cell (city name string) maps to incorporated with the city name, no fabricated geoId/gnis", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48021:34137",
            railKey: CITY_LIMITS_RAIL_KEY,
            cellState: { kind: "value", value: "Bastrop", source: "landing_parcel_jurisdiction", vintage: "2026-09-02T18:13:56.751Z" },
          },
        ],
      }),
    );
    const result = await cityLimitsFactFromParcelRecord("48021:34137", POINT);
    expect(result.status).toBe("incorporated");
    expect(result.cityName).toBe("Bastrop");
    expect(result.etjStatus).toBe("unresolved");
    expect(result.geoId).toBeUndefined();
    expect(result.gnis).toBeUndefined();
    expect(result.queryPoint).toEqual(POINT);
  });

  it("LIVE-SHAPE: real absent-verified basis ({disposition: unincorporated, ...}) maps to unincorporated, a real determination", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48021:10001",
            railKey: CITY_LIMITS_RAIL_KEY,
            cellState: {
              kind: "absent-verified",
              basis: {
                propId: "10001",
                source: "landing_parcel_jurisdiction",
                vintage: "2026-09-02T18:13:56.751Z",
                countyFips: "48021",
                disposition: "unincorporated",
              },
            },
          },
        ],
      }),
    );
    const result = await cityLimitsFactFromParcelRecord("48021:10001", POINT);
    expect(result.status).toBe("unincorporated");
    expect(result.basis).toMatch(/unincorporated/);
    expect(result.basis).toMatch(/landing_parcel_jurisdiction/);
  });

  it("THE LOAD-BEARING CASE: unaccounted maps to unmeasured, never a fabricated incorporated/unincorporated determination", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48453:493738", railKey: CITY_LIMITS_RAIL_KEY, cellState: { kind: "unaccounted" } },
        ],
      }),
    );
    const result = await cityLimitsFactFromParcelRecord("48453:493738", POINT);
    expect(result.status).toBe("unmeasured");
    expect(result.basis).toMatch(/unaccounted/);
  });

  it("a value cell with a non-string value refuses to unmeasured rather than inventing a city", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48021:1",
            railKey: CITY_LIMITS_RAIL_KEY,
            cellState: { kind: "value", value: 12345, source: "landing_parcel_jurisdiction", vintage: "2026-09-02" },
          },
        ],
      }),
    );
    const result = await cityLimitsFactFromParcelRecord("48021:1", POINT);
    expect(result.status).toBe("unmeasured");
    expect(result.basis).toMatch(/not a usable city name/);
  });

  it("no cell row at all maps to unmeasured, carrying the cell-miss distinction in basis text even though the type cannot", async () => {
    setParcelRecordQueryableForTests(memoryParcelRecordStore({ cells: [] }));
    const result = await cityLimitsFactFromParcelRecord("48021:999999", POINT);
    expect(result.status).toBe("unmeasured");
    expect(result.basis).toMatch(/no-such-parcel-or-rail/);
  });

  it("a null queryPoint passes through unchanged in every branch", async () => {
    setParcelRecordQueryableForTests(memoryParcelRecordStore({ cells: [] }));
    const result = await cityLimitsFactFromParcelRecord("48021:999999", null);
    expect(result.queryPoint).toBeNull();
  });
});

describe("cityLimitsFactFromParcelRecord — area-share split carried from the record", () => {
  const HSB_SPLIT = {
    method: "area-share-3083-v1",
    pieces: [
      { cityName: "Horseshoe Bay", geoId: "4834862", share: 0.93, areaM2: 2145.2 },
      { cityName: null, geoId: null, share: 0.07, areaM2: 161.5 },
    ],
  };

  it("a cell written before the rule (no areaShare) serves exactly as before: no areaShare key, basis unchanged", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48021:34137",
            railKey: CITY_LIMITS_RAIL_KEY,
            cellState: { kind: "value", value: "Bastrop", source: "landing_parcel_jurisdiction", vintage: "2026-09-02T18:13:56.751Z" },
          },
        ],
      }),
    );
    const result = await cityLimitsFactFromParcelRecord("48021:34137", POINT);
    expect("areaShare" in result).toBe(false);
    expect(result.basis).toBe(
      "parcel_record cityLimits: incorporated, city 'Bastrop' (source: landing_parcel_jurisdiction, vintage: 2026-09-02T18:13:56.751Z).",
    );
  });

  it("an incorporated value cell carrying a split serves it, and the basis discloses it", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48053:1",
            railKey: CITY_LIMITS_RAIL_KEY,
            cellState: {
              kind: "value",
              value: "Horseshoe Bay",
              source: "landing_parcel_jurisdiction",
              vintage: "2026-10-14",
              areaShare: HSB_SPLIT,
            },
          },
        ],
      }),
    );
    const result = await cityLimitsFactFromParcelRecord("48053:1", POINT);
    expect(result.status).toBe("incorporated");
    expect(result.cityName).toBe("Horseshoe Bay");
    expect(result.areaShare?.split).toBe(true);
    expect(result.areaShare?.disclosure).toBe("93% in Horseshoe Bay, 7% unincorporated");
    expect(result.basis).toMatch(/Split by area \(area-share-3083-v1\): 93% in Horseshoe Bay, 7% unincorporated\.$/);
  });

  it("an unincorporated (absent-verified) cell carries its split inside the basis object", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48053:2",
            railKey: CITY_LIMITS_RAIL_KEY,
            cellState: {
              kind: "absent-verified",
              basis: {
                propId: "2",
                source: "landing_parcel_jurisdiction",
                vintage: "2026-10-14",
                countyFips: "48053",
                disposition: "unincorporated",
                areaShare: {
                  method: "area-share-3083-v1",
                  pieces: [
                    { cityName: null, share: 0.88, areaM2: 4048 },
                    { cityName: "Bertram", geoId: "4807876", share: 0.12, areaM2: 552 },
                  ],
                },
              },
            },
          },
        ],
      }),
    );
    const result = await cityLimitsFactFromParcelRecord("48053:2", POINT);
    expect(result.status).toBe("unincorporated");
    expect(result.areaShare?.disclosure).toBe("88% unincorporated, 12% in Bertram");
    expect(result.basis).toMatch(/88% unincorporated, 12% in Bertram/);
  });

  it("a stored split that contradicts the cell's own answer is dropped, never served", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48053:3",
            railKey: CITY_LIMITS_RAIL_KEY,
            cellState: {
              kind: "value",
              value: "Marble Falls",
              source: "landing_parcel_jurisdiction",
              vintage: "2026-10-14",
              areaShare: HSB_SPLIT,
            },
          },
        ],
      }),
    );
    const result = await cityLimitsFactFromParcelRecord("48053:3", POINT);
    expect(result.status).toBe("incorporated");
    expect("areaShare" in result).toBe(false);
    expect(result.basis).not.toMatch(/Split by area/);
  });
});
