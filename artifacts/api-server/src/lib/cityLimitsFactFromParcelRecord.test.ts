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
