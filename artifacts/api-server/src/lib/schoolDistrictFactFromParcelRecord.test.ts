/**
 * schoolDistrictFactFromParcelRecord.ts — the serve/prod-cutover adapter.
 * Fixtures mirror the real writer shape in hauska-factory's
 * parcel-school-district.mjs: schoolDistrictCellState
 * ({kind:"value", value:<name>, districtCode, geoid, source, vintage}, live
 * sample from the acquire-gis close: 48309:135397 "McGregor ISD").
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  memoryParcelRecordStore,
  resetParcelRecordQueryableForTests,
  setParcelRecordQueryableForTests,
} from "./parcelRecordCellRead";
import { schoolDistrictFactFromParcelRecord } from "./schoolDistrictFactFromParcelRecord";
import { SCHOOL_DISTRICT_RAIL_KEY } from "./schoolDistrictFactRead";

afterEach(() => {
  resetParcelRecordQueryableForTests();
});

describe("schoolDistrictFactFromParcelRecord", () => {
  it("a malformed parcelNodeId refuses invalid-parcel-node-id without touching the store", async () => {
    const result = await schoolDistrictFactFromParcelRecord("not-a-valid-id");
    expect(result).toEqual({
      state: "refused",
      code: "invalid-parcel-node-id",
      source: "school-district-fact",
      entityId: null,
      reason:
        '"not-a-valid-id" is not a valid parcel node id (county_fips:prop_id). Refusing rather than guessing a place_key.',
    });
  });

  it("no store configured refuses parcel-record-store-not-configured", async () => {
    setParcelRecordQueryableForTests(null);
    const result = await schoolDistrictFactFromParcelRecord("48309:135397");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-store-not-configured");
  });

  it("LIVE-SHAPE: a real sampled cell (McGregor ISD, 48309:135397) maps to a present fact carrying districtCode and geoid off the cell itself", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48309:135397",
            railKey: SCHOOL_DISTRICT_RAIL_KEY,
            cellState: {
              kind: "value",
              value: "McGregor ISD",
              districtCode: "161-909",
              geoid: "4829820",
              source: "tx_school_district",
              vintage: "2026-09-03T16:50:31.471Z",
            },
          },
        ],
      }),
    );
    const result = await schoolDistrictFactFromParcelRecord("48309:135397");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.districtName).toBe("McGregor ISD");
    expect(result.districtCode).toBe("161-909");
    expect(result.geoid).toBe("4829820");
    expect(result.sourceAdapter).toBe("parcel_record");
  });

  it("a value cell with no companion rows at all is still present -- this rail has none by design", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48021:1",
            railKey: SCHOOL_DISTRICT_RAIL_KEY,
            cellState: { kind: "value", value: "Bastrop ISD", districtCode: "011-901", geoid: "4801020", source: "tx_school_district", vintage: "2026-09-03" },
          },
        ],
        companionRows: [],
      }),
    );
    const result = await schoolDistrictFactFromParcelRecord("48021:1");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.districtName).toBe("Bastrop ISD");
  });

  it("a value cell missing districtCode/geoid carries them as null, never fabricated", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48021:2",
            railKey: SCHOOL_DISTRICT_RAIL_KEY,
            cellState: { kind: "value", value: "Bastrop ISD", source: "tx_school_district", vintage: "2026-09-03" },
          },
        ],
      }),
    );
    const result = await schoolDistrictFactFromParcelRecord("48021:2");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.districtCode).toBeNull();
    expect(result.geoid).toBeNull();
  });

  it("THE LOAD-BEARING CASE: unaccounted (never examined, OR one of the 13 known zero-hit/multi-hit anomalies -- indistinguishable from the serve side alone, see module doc) refuses, never a fabricated district", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48453:493738", railKey: SCHOOL_DISTRICT_RAIL_KEY, cellState: { kind: "unaccounted" } },
        ],
      }),
    );
    const result = await schoolDistrictFactFromParcelRecord("48453:493738");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-unaccounted");
  });

  it("a value cell whose value is not a readable string refuses rather than inventing a district name", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48021:3", railKey: SCHOOL_DISTRICT_RAIL_KEY, cellState: { kind: "value", value: null, source: "tx_school_district", vintage: "2026-09-03" } },
        ],
      }),
    );
    const result = await schoolDistrictFactFromParcelRecord("48021:3");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-malformed-cell");
  });

  it("no cell row at all (no-such-parcel-or-rail) maps to parcel-record-cell-miss, distinct from unaccounted", async () => {
    setParcelRecordQueryableForTests(memoryParcelRecordStore({ cells: [] }));
    const result = await schoolDistrictFactFromParcelRecord("48021:999999");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-cell-miss");
  });
});
