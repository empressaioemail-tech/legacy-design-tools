/**
 * utilityServiceFactFromParcelRecord.ts — the serve/prod-cutover adapter.
 * Fixtures mirror the real writer shapes in hauska-factory's
 * parcel-utility-service.mjs: utilityCompanionPayload
 * ({utilityType, ccnNo, utility, status, ccnType}) at fixed rowIndex slots
 * (0 = water, 1 = sewer, 2 = electric), and utilitySweepAbsentBasis's
 * absent-verified shape.
 *
 * The "electric-only" case below is the exact live-production bug this
 * card's own post-deploy witness-parcel check caught: the original cutover
 * only read rowIndex 0/1, built against the wave-1 writer, and never
 * re-checked wave 2's version of the same file that added rowIndex 2. Any
 * parcel with only an electric row (a large share of the population, since
 * electric's HIFLD source tiles the whole state) was served a fabricated
 * malformed-cell refusal instead of its real record. This fixture is the
 * falsifier for that specific bug -- it must never regress.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  memoryParcelRecordStore,
  resetParcelRecordQueryableForTests,
  setParcelRecordQueryableForTests,
} from "./parcelRecordCellRead";
import {
  utilityServiceFactFromParcelRecord,
} from "./utilityServiceFactFromParcelRecord";
import { UTILITY_SERVICE_RAIL_KEY } from "./utilityServiceFactRead";

afterEach(() => {
  resetParcelRecordQueryableForTests();
});

describe("utilityServiceFactFromParcelRecord", () => {
  it("a malformed parcelNodeId refuses invalid-parcel-node-id without touching the store", async () => {
    const result = await utilityServiceFactFromParcelRecord("not-a-valid-id");
    expect(result).toEqual({
      state: "refused",
      code: "invalid-parcel-node-id",
      source: "utility-service-fact",
      entityId: null,
      reason:
        '"not-a-valid-id" is not a valid parcel node id (county_fips:prop_id). Refusing rather than guessing a place_key.',
    });
  });

  it("no store configured refuses parcel-record-store-not-configured", async () => {
    setParcelRecordQueryableForTests(null);
    const result = await utilityServiceFactFromParcelRecord("48021:34137");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-store-not-configured");
  });

  it("absent-verified (sweep basis) maps to a typed absence, never a fabricated present", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48021:34137",
            railKey: UTILITY_SERVICE_RAIL_KEY,
            cellState: {
              kind: "absent-verified",
              basis: {
                source: "tx_puct_ccn",
                countyFips: "48021",
                propId: "34137",
                method: "zone-major-sweep",
                finding: "no PUCT CCN polygon (water or sewer) contains this parcel's centroid",
                vintage: "2026-09-04T00:00:00.000Z",
              },
            },
          },
        ],
      }),
    );
    const result = await utilityServiceFactFromParcelRecord("48021:34137");
    expect(result.state).toBe("absent");
    if (result.state !== "absent") throw new Error("unreachable");
    expect(result.absence).toEqual({
      kind: "absent-verified",
      reason: "no PUCT CCN polygon (water or sewer) contains this parcel's centroid",
    });
    expect(result.verifiedAbsence).toBe(true);
    expect(result.sourceTier).toBe("zone-major-sweep");
    expect(result.sourceAdapter).toBe("parcel_record");
  });

  it("sewer-only (rowCount 1, fixed rowIndex 1 -- the observed production shape while TWDB water is down) carries sewer, water null", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48453:301328",
            railKey: UTILITY_SERVICE_RAIL_KEY,
            cellState: { kind: "value", disposition: "rows", rowCount: 1, source: "tx_puct_ccn", vintage: "2026-09-04T00:00:00.000Z" },
          },
        ],
        companionRows: [
          {
            placeKey: "48453:301328",
            railKey: UTILITY_SERVICE_RAIL_KEY,
            rowIndex: 1,
            payload: { utilityType: "sewer", ccnNo: "20800", utility: "CITY OF AUSTIN", status: "REGULATED", ccnType: "MUNICIPAL" },
            source: "tx_puct_ccn",
            vintage: "2026-09-04T00:00:00.000Z",
          },
        ],
      }),
    );
    const result = await utilityServiceFactFromParcelRecord("48453:301328");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.water).toBeNull();
    expect(result.sewer).toEqual({
      ccnNo: "20800",
      utility: "CITY OF AUSTIN",
      status: "REGULATED",
      ccnType: "MUNICIPAL",
    });
    expect(result.electric).toBeNull();
    expect(result.sourceAdapter).toBe("parcel_record");
  });

  it("THE REGRESSION CASE: electric-only (rowCount 1, fixed rowIndex 2 -- the real, live production shape for the ~49% of parcels with no sewer/water) carries electric, water and sewer null, never a fabricated malformed-cell refusal", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48055:1",
            railKey: UTILITY_SERVICE_RAIL_KEY,
            cellState: { kind: "value", disposition: "rows", rowCount: 1, source: "tx_puct_ccn", vintage: "2026-09-03T18:38:34.997Z" },
          },
        ],
        companionRows: [
          {
            placeKey: "48055:1",
            railKey: UTILITY_SERVICE_RAIL_KEY,
            rowIndex: 2,
            payload: { utilityType: "electric", ccnNo: "14626", utility: "PEDERNALES ELECTRIC COOP, INC", status: "REGULATED", ccnType: "COOPERATIVE" },
            source: "tx_puct_ccn",
            vintage: "2026-09-03T18:38:34.997Z",
          },
        ],
      }),
    );
    const result = await utilityServiceFactFromParcelRecord("48055:1");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.water).toBeNull();
    expect(result.sewer).toBeNull();
    expect(result.electric).toEqual({
      ccnNo: "14626",
      utility: "PEDERNALES ELECTRIC COOP, INC",
      status: "REGULATED",
      ccnType: "COOPERATIVE",
    });
  });

  it("all three (water, sewer, electric) present carries all three independently", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48453:1000025",
            railKey: UTILITY_SERVICE_RAIL_KEY,
            cellState: { kind: "value", disposition: "rows", rowCount: 3, source: "tx_puct_ccn", vintage: "2026-09-04" },
          },
        ],
        companionRows: [
          { placeKey: "48453:1000025", railKey: UTILITY_SERVICE_RAIL_KEY, rowIndex: 0, payload: { utilityType: "water", ccnNo: "1", utility: "W" }, source: "tx_puct_ccn", vintage: "2026-09-04" },
          { placeKey: "48453:1000025", railKey: UTILITY_SERVICE_RAIL_KEY, rowIndex: 1, payload: { utilityType: "sewer", ccnNo: "2", utility: "S" }, source: "tx_puct_ccn", vintage: "2026-09-04" },
          { placeKey: "48453:1000025", railKey: UTILITY_SERVICE_RAIL_KEY, rowIndex: 2, payload: { utilityType: "electric", ccnNo: "3", utility: "E" }, source: "tx_puct_ccn", vintage: "2026-09-04" },
        ],
      }),
    );
    const result = await utilityServiceFactFromParcelRecord("48453:1000025");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.water?.ccnNo).toBe("1");
    expect(result.sewer?.ccnNo).toBe("2");
    expect(result.electric?.ccnNo).toBe("3");
  });

  it("both water and sewer present (rowCount 2, both fixed slots filled) carries both independently, not a picked lead", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48021:10018",
            railKey: UTILITY_SERVICE_RAIL_KEY,
            cellState: { kind: "value", disposition: "rows", rowCount: 2, source: "tx_puct_ccn", vintage: "2026-09-04T00:00:00.000Z" },
          },
        ],
        companionRows: [
          {
            placeKey: "48021:10018",
            railKey: UTILITY_SERVICE_RAIL_KEY,
            rowIndex: 0,
            payload: { utilityType: "water", ccnNo: "10863", utility: "AQUA TEXAS", status: "REGULATED", ccnType: "MUNICIPAL" },
            source: "tx_puct_ccn",
            vintage: "2026-09-04T00:00:00.000Z",
          },
          {
            placeKey: "48021:10018",
            railKey: UTILITY_SERVICE_RAIL_KEY,
            rowIndex: 1,
            payload: { utilityType: "sewer", ccnNo: "20811", utility: "BASTROP COUNTY WCID", status: "REGULATED", ccnType: "MUNICIPAL" },
            source: "tx_puct_ccn",
            vintage: "2026-09-04T00:00:00.000Z",
          },
        ],
      }),
    );
    const result = await utilityServiceFactFromParcelRecord("48021:10018");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.water?.ccnNo).toBe("10863");
    expect(result.sewer?.ccnNo).toBe("20811");
    expect(result.electric).toBeNull();
  });

  it("THE LOAD-BEARING CASE: unaccounted refuses, never a fabricated absence or a present service", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48453:493738", railKey: UTILITY_SERVICE_RAIL_KEY, cellState: { kind: "unaccounted" } },
        ],
      }),
    );
    const result = await utilityServiceFactFromParcelRecord("48453:493738");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-unaccounted");
  });

  it("a value cell with no readable water, sewer, or electric companion row refuses rather than inventing service", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48021:1",
            railKey: UTILITY_SERVICE_RAIL_KEY,
            cellState: { kind: "value", disposition: "rows", rowCount: 1, source: "tx_puct_ccn", vintage: "2026-09-04" },
          },
        ],
        companionRows: [],
      }),
    );
    const result = await utilityServiceFactFromParcelRecord("48021:1");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-malformed-cell");
  });

  it("no cell row at all (no-such-parcel-or-rail) maps to parcel-record-cell-miss, distinct from unaccounted", async () => {
    setParcelRecordQueryableForTests(memoryParcelRecordStore({ cells: [] }));
    const result = await utilityServiceFactFromParcelRecord("48021:999999");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-cell-miss");
  });
});
