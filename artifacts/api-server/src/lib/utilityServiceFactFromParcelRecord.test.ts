/**
 * utilityServiceFactFromParcelRecord.ts — the serve/prod-cutover adapter.
 * Fixtures mirror the real writer shapes in hauska-factory's
 * parcel-utility-service.mjs: utilityCompanionPayload
 * ({utilityType, ccnNo, utility, status, ccnType}) at fixed rowIndex slots
 * (0 = water, 1 = sewer), and utilitySweepAbsentBasis's absent-verified
 * shape.
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
    expect(result.sourceAdapter).toBe("parcel_record");
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

  it("a value cell with no readable water or sewer companion row refuses rather than inventing service", async () => {
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
