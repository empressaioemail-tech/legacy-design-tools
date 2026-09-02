/**
 * specialDistrictFactFromParcelRecord.ts — the PARCEL-B-SLATE1 adapter.
 * Fixtures mirror LIVE parcel_record data, read 2026-09-02 via the RO
 * credential: gold parcel's absent-verified basis shape, a real
 * tx_special_district companion payload, and a real rowCount=2 parcel.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  memoryParcelRecordStore,
  resetParcelRecordQueryableForTests,
  setParcelRecordQueryableForTests,
} from "./parcelRecordCellRead";
import {
  SPECIAL_DISTRICTS_RAIL_KEY,
  specialDistrictFactFromParcelRecord,
} from "./specialDistrictFactFromParcelRecord";

afterEach(() => {
  resetParcelRecordQueryableForTests();
});

describe("specialDistrictFactFromParcelRecord", () => {
  it("a malformed parcelNodeId refuses invalid-parcel-node-id without touching the store", async () => {
    const result = await specialDistrictFactFromParcelRecord("not-a-valid-id");
    expect(result).toEqual({
      state: "refused",
      code: "invalid-parcel-node-id",
      source: "special-district-fact",
      tried: [],
      reason:
        '"not-a-valid-id" is not a valid parcel node id (county_fips:prop_id). Refusing rather than guessing a place_key.',
    });
  });

  it("no store configured refuses parcel-record-store-not-configured", async () => {
    setParcelRecordQueryableForTests(null);
    const result = await specialDistrictFactFromParcelRecord("48021:34137");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-store-not-configured");
  });

  it("LIVE-SHAPE: absent-verified (gold parcel's real basis shape) maps to a typed absence, never a fabricated district", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48021:34137",
            railKey: SPECIAL_DISTRICTS_RAIL_KEY,
            cellState: {
              kind: "absent-verified",
              basis: {
                method: "zone-major-sweep",
                propId: "34137",
                source: "tx_special_district",
                finding: "no tx_special_district polygon intersects this parcel's geometry",
                vintage: "2026-09-02T14:46:32.344Z",
                countyFips: "48021",
              },
            },
          },
        ],
      }),
    );
    const result = await specialDistrictFactFromParcelRecord("48021:34137");
    expect(result.state).toBe("absent");
    if (result.state !== "absent") throw new Error("unreachable");
    expect(result.absence).toEqual({
      kind: "absent-verified",
      reason: "no tx_special_district polygon intersects this parcel's geometry",
    });
    expect(result.verifiedAbsence).toBe(true);
    expect(result.sourceTier).toBe("zone-major-sweep");
  });

  it("LIVE-SHAPE: one companion row (real tx_special_district payload shape) maps to a present district", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48021:102817",
            railKey: SPECIAL_DISTRICTS_RAIL_KEY,
            cellState: { kind: "value", disposition: "rows", rowCount: 1, source: "tx_special_district", vintage: "2026-09-02T14:46:32.344Z" },
          },
        ],
        companionRows: [
          {
            placeKey: "48021:102817",
            railKey: SPECIAL_DISTRICTS_RAIL_KEY,
            rowIndex: 0,
            payload: { districtId: "3504125", districtName: "The Colony MUD 1C", districtType: "MUD" },
            source: "tx_special_district",
            vintage: "2026-08-10",
          },
        ],
      }),
    );
    const result = await specialDistrictFactFromParcelRecord("48021:102817");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.districtId).toBe("3504125");
    expect(result.districtName).toBe("The Colony MUD 1C");
    expect(result.districtType).toBe("MUD");
  });

  it("LIVE-SHAPE: rowCount=2 (real multi-district parcel) picks the MUD-preferred, lexically-first district as lead", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48021:103414",
            railKey: SPECIAL_DISTRICTS_RAIL_KEY,
            cellState: { kind: "value", disposition: "rows", rowCount: 2, source: "tx_special_district", vintage: "2026-09-02" },
          },
        ],
        companionRows: [
          {
            placeKey: "48021:103414",
            railKey: SPECIAL_DISTRICTS_RAIL_KEY,
            rowIndex: 0,
            payload: { districtId: "9999999", districtName: "Some ESD", districtType: "ESD" },
            source: "tx_special_district",
            vintage: "2026-08-10",
          },
          {
            placeKey: "48021:103414",
            railKey: SPECIAL_DISTRICTS_RAIL_KEY,
            rowIndex: 1,
            payload: { districtId: "2969829", districtName: "The Colony MUD 1F", districtType: "MUD" },
            source: "tx_special_district",
            vintage: "2026-08-10",
          },
        ],
      }),
    );
    const result = await specialDistrictFactFromParcelRecord("48021:103414");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    // MUD preferred over ESD even though ESD's districtId sorts first lexically.
    expect(result.districtId).toBe("2969829");
    expect(result.districtType).toBe("MUD");
  });

  it("THE LOAD-BEARING CASE: unaccounted refuses, never a fabricated absence or a present district", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48453:493738", railKey: SPECIAL_DISTRICTS_RAIL_KEY, cellState: { kind: "unaccounted" } },
        ],
      }),
    );
    const result = await specialDistrictFactFromParcelRecord("48453:493738");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-unaccounted");
  });

  it("a value cell with empty/unreadable companion rows refuses rather than inventing a district", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48021:1",
            railKey: SPECIAL_DISTRICTS_RAIL_KEY,
            cellState: { kind: "value", disposition: "rows", rowCount: 1, source: "tx_special_district", vintage: "2026-09-02" },
          },
        ],
        companionRows: [],
      }),
    );
    const result = await specialDistrictFactFromParcelRecord("48021:1");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-malformed-cell");
  });

  it("no cell row at all (no-such-parcel-or-rail) maps to parcel-record-cell-miss, distinct from unaccounted", async () => {
    setParcelRecordQueryableForTests(memoryParcelRecordStore({ cells: [] }));
    const result = await specialDistrictFactFromParcelRecord("48021:999999");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-cell-miss");
  });
});
