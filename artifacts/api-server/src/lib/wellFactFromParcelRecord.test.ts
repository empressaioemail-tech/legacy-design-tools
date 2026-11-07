/**
 * wellFactFromParcelRecord.ts — the PARCEL-B-SLATE1 adapter. Fixtures below
 * mirror LIVE parcel_record data, read 2026-09-02 via the RO credential:
 * gold parcel 48021:34137's absent-verified basis shape, a real wells value
 * cell + companion payload ({api, isOrphan, wellStatus, gisWellNumber}), and
 * a real rowCount=2 multi-well parcel.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  memoryParcelRecordStore,
  resetParcelRecordQueryableForTests,
  setParcelRecordQueryableForTests,
} from "./parcelRecordCellRead";
import { WELLS_RAIL_KEY, wellFactFromParcelRecord } from "./wellFactFromParcelRecord";

afterEach(() => {
  resetParcelRecordQueryableForTests();
});

describe("wellFactFromParcelRecord", () => {
  it("a malformed parcelNodeId refuses invalid-parcel-node-id without touching the store", async () => {
    const result = await wellFactFromParcelRecord("not-a-valid-id");
    expect(result).toEqual({
      state: "refused",
      code: "invalid-parcel-node-id",
      source: "well-fact",
      tried: [],
      reason:
        '"not-a-valid-id" is not a valid parcel node id (county_fips:prop_id). Refusing rather than guessing a place_key.',
    });
  });

  it("no store configured refuses parcel-record-store-not-configured", async () => {
    setParcelRecordQueryableForTests(null);
    const result = await wellFactFromParcelRecord("48021:34137");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-store-not-configured");
  });

  it("LIVE-SHAPE: absent-verified (gold parcel's real basis shape) maps to a typed absence, never a present well", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48021:34137",
            railKey: WELLS_RAIL_KEY,
            cellState: {
              kind: "absent-verified",
              basis: {
                method: "zone-major-sweep",
                propId: "34137",
                source: "tx_rrc_well",
                finding: "no tx_rrc_well point falls within this parcel's geometry",
                vintage: "2026-09-02T14:46:32.344Z",
                countyFips: "48021",
              },
            },
          },
        ],
      }),
    );
    const result = await wellFactFromParcelRecord("48021:34137");
    expect(result.state).toBe("absent");
    if (result.state !== "absent") throw new Error("unreachable");
    expect(result.absence).toEqual({
      kind: "absent-verified",
      reason: "no tx_rrc_well point falls within this parcel's geometry",
    });
    expect(result.verifiedAbsence).toBe(true);
    expect(result.sourceTier).toBe("zone-major-sweep");
    expect(result.sourceAdapter).toBe("parcel_record");
  });

  it("LIVE-SHAPE: one companion row (real tx_rrc_well payload shape) maps to a present well, honestly on-parcel with no proximity data", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48453:301328",
            railKey: WELLS_RAIL_KEY,
            cellState: { kind: "value", disposition: "rows", rowCount: 1, source: "tx_rrc_well", vintage: "2026-09-02T14:46:32.482Z" },
          },
        ],
        companionRows: [
          {
            placeKey: "48453:301328",
            railKey: WELLS_RAIL_KEY,
            rowIndex: 0,
            payload: { api: "02130878", isOrphan: false, wellStatus: "dry", gisWellNumber: "1" },
            source: "tx_rrc_well",
            vintage: "UNKNOWN",
          },
        ],
      }),
    );
    const result = await wellFactFromParcelRecord("48453:301328");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.apiNumber14).toBe("02130878");
    expect(result.wellStatus).toBe("dry");
    expect(result.orphaned).toBe(false);
    expect(result.parcelRelation).toBe("on-parcel");
    expect(result.proximityRadiusMeters).toBeNull();
    expect(result.proximityDistanceMeters).toBeNull();
    expect(result.surfaceLocation).toBeNull();
    expect(result.wellType).toBeNull();
    expect(result.operatorName).toBeNull();
    expect(result.wells).toHaveLength(1);
    expect(result.sourceAdapter).toBe("parcel_record");
  });

  it("LIVE-SHAPE: rowCount=2 (real multi-well parcel) carries every well, lead chosen by wellKey ordering", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48021:103414",
            railKey: WELLS_RAIL_KEY,
            cellState: { kind: "value", disposition: "rows", rowCount: 2, source: "tx_rrc_well", vintage: "2026-09-02" },
          },
        ],
        companionRows: [
          {
            placeKey: "48021:103414",
            railKey: WELLS_RAIL_KEY,
            rowIndex: 0,
            payload: { api: "02131389", isOrphan: false, wellStatus: "dry", gisWellNumber: "1" },
            source: "tx_rrc_well",
            vintage: "2026-08-10",
          },
          {
            placeKey: "48021:103414",
            railKey: WELLS_RAIL_KEY,
            rowIndex: 1,
            payload: { api: "02130878", isOrphan: true, wellStatus: "permitted", gisWellNumber: "1" },
            source: "tx_rrc_well",
            vintage: "2026-08-10",
          },
        ],
      }),
    );
    const result = await wellFactFromParcelRecord("48021:103414");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.wells).toHaveLength(2);
    // Lead is the lexically smaller wellKey (02130878 < 02131389).
    expect(result.apiNumber14).toBe("02130878");
    expect(result.orphaned).toBe(true);
  });

  it("THE LOAD-BEARING CASE: unaccounted refuses, never a fabricated absence or a present well", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48453:493738", railKey: WELLS_RAIL_KEY, cellState: { kind: "unaccounted" } },
        ],
      }),
    );
    const result = await wellFactFromParcelRecord("48453:493738");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-unaccounted");
  });

  it("a value cell with empty/unreadable companion rows refuses rather than inventing a well", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48021:1",
            railKey: WELLS_RAIL_KEY,
            cellState: { kind: "value", disposition: "rows", rowCount: 1, source: "tx_rrc_well", vintage: "2026-09-02" },
          },
        ],
        companionRows: [],
      }),
    );
    const result = await wellFactFromParcelRecord("48021:1");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-malformed-cell");
  });

  it("no cell row at all (no-such-parcel-or-rail) maps to parcel-record-cell-miss, distinct from unaccounted", async () => {
    setParcelRecordQueryableForTests(memoryParcelRecordStore({ cells: [] }));
    const result = await wellFactFromParcelRecord("48021:999999");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-cell-miss");
  });
});
