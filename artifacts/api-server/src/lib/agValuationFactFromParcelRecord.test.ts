/**
 * agValuationFactFromParcelRecord.ts — the serve/prod-cutover adapter.
 * Fixtures mirror the real writer shapes in hauska-factory's
 * parcel-ag-valuation.mjs: agValuationCompanionPayload
 * ({statecode, landType, description, acres, value, currValue, agFlag,
 * rawAgFlag, sequence, apprMethod, agYear, propertyNumber}, shared verbatim
 * across Williamson/WCAD and Travis/TCAD) and agValuationSweepAbsentBasis's
 * absent-verified shape.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  memoryParcelRecordStore,
  resetParcelRecordQueryableForTests,
  setParcelRecordQueryableForTests,
} from "./parcelRecordCellRead";
import { agValuationFactFromParcelRecord } from "./agValuationFactFromParcelRecord";
import { AG_VALUATION_RAIL_KEY } from "./agValuationFactRead";

afterEach(() => {
  resetParcelRecordQueryableForTests();
});

describe("agValuationFactFromParcelRecord", () => {
  it("a malformed parcelNodeId refuses invalid-parcel-node-id without touching the store", async () => {
    const result = await agValuationFactFromParcelRecord("not-a-valid-id");
    expect(result).toEqual({
      state: "refused",
      code: "invalid-parcel-node-id",
      source: "ag-valuation-fact",
      entityId: null,
      reason:
        '"not-a-valid-id" is not a valid parcel node id (county_fips:prop_id). Refusing rather than guessing a place_key.',
    });
  });

  it("no store configured refuses parcel-record-store-not-configured", async () => {
    setParcelRecordQueryableForTests(null);
    const result = await agValuationFactFromParcelRecord("48491:34137");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-store-not-configured");
  });

  it("absent-verified (sweep basis) maps to a typed absence, never a fabricated present", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48491:34137",
            railKey: AG_VALUATION_RAIL_KEY,
            cellState: {
              kind: "absent-verified",
              basis: {
                source: "tx_wcad_ag_valuation",
                countyFips: "48491",
                propId: "34137",
                method: "attribute-join-sweep",
                finding: "no WCAD/TCAD land record for this prop_id",
                vintage: "2026-09-04T00:00:00.000Z",
              },
            },
          },
        ],
      }),
    );
    const result = await agValuationFactFromParcelRecord("48491:34137");
    expect(result.state).toBe("absent");
    if (result.state !== "absent") throw new Error("unreachable");
    expect(result.absence).toEqual({
      kind: "absent-verified",
      reason: "no WCAD/TCAD land record for this prop_id",
    });
    expect(result.verifiedAbsence).toBe(true);
    expect(result.sourceTier).toBe("attribute-join-sweep");
  });

  it("LIVE-SHAPE: one WCAD land record (Williamson) maps to a present entries array of length 1", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48491:R125831",
            railKey: AG_VALUATION_RAIL_KEY,
            cellState: { kind: "value", disposition: "rows", rowCount: 1, source: "tx_wcad_ag_valuation", vintage: "2026-09-04T00:00:00.000Z" },
          },
        ],
        companionRows: [
          {
            placeKey: "48491:R125831",
            railKey: AG_VALUATION_RAIL_KEY,
            rowIndex: 0,
            payload: {
              statecode: "D1", landType: "Native Pasture", description: "Ag use",
              acres: 12.5, value: 890, currValue: 890, agFlag: true, rawAgFlag: "Y",
              sequence: 1, apprMethod: "AG", agYear: 2025, propertyNumber: "R125831",
            },
            source: "tx_wcad_ag_valuation",
            vintage: "2026-09-04T00:00:00.000Z",
          },
        ],
      }),
    );
    const result = await agValuationFactFromParcelRecord("48491:R125831");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toEqual({
      statecode: "D1", landType: "Native Pasture", description: "Ag use",
      acres: 12.5, value: 890, currValue: 890, agFlag: true, rawAgFlag: "Y",
      sequence: 1, apprMethod: "AG", agYear: 2025, propertyNumber: "R125831",
    });
  });

  it("multiple land-record segments (WCAD, rowCount 2) carry every entry, none dropped as a picked lead", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48491:R200000",
            railKey: AG_VALUATION_RAIL_KEY,
            cellState: { kind: "value", disposition: "rows", rowCount: 2, source: "tx_wcad_ag_valuation", vintage: "2026-09-04" },
          },
        ],
        companionRows: [
          { placeKey: "48491:R200000", railKey: AG_VALUATION_RAIL_KEY, rowIndex: 0, payload: { sequence: 1, landType: "Dry Cropland", agFlag: true }, source: "tx_wcad_ag_valuation", vintage: "2026-09-04" },
          { placeKey: "48491:R200000", railKey: AG_VALUATION_RAIL_KEY, rowIndex: 1, payload: { sequence: 2, landType: "Native Pasture", agFlag: true }, source: "tx_wcad_ag_valuation", vintage: "2026-09-04" },
        ],
      }),
    );
    const result = await agValuationFactFromParcelRecord("48491:R200000");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((e) => e.landType)).toEqual(["Dry Cropland", "Native Pasture"]);
  });

  it("a rawAgFlag/agYear that came through as a number is preserved verbatim, not stringified", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48453:998877",
            railKey: AG_VALUATION_RAIL_KEY,
            cellState: { kind: "value", disposition: "rows", rowCount: 1, source: "tx_tcad_ag_valuation", vintage: "2026-09-04" },
          },
        ],
        companionRows: [
          { placeKey: "48453:998877", railKey: AG_VALUATION_RAIL_KEY, rowIndex: 0, payload: { rawAgFlag: 1, agYear: 2025 }, source: "tx_tcad_ag_valuation", vintage: "2026-09-04" },
        ],
      }),
    );
    const result = await agValuationFactFromParcelRecord("48453:998877");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.entries[0].rawAgFlag).toBe(1);
    expect(result.entries[0].agYear).toBe(2025);
  });

  it("THE LOAD-BEARING CASE: unaccounted (a parcel in a non-target county, correctly untouched) refuses, never a fabricated absence or present", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48021:493738", railKey: AG_VALUATION_RAIL_KEY, cellState: { kind: "unaccounted" } },
        ],
      }),
    );
    const result = await agValuationFactFromParcelRecord("48021:493738");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-unaccounted");
  });

  it("a value cell with no readable companion rows refuses rather than inventing a land record", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48491:1",
            railKey: AG_VALUATION_RAIL_KEY,
            cellState: { kind: "value", disposition: "rows", rowCount: 1, source: "tx_wcad_ag_valuation", vintage: "2026-09-04" },
          },
        ],
        companionRows: [],
      }),
    );
    const result = await agValuationFactFromParcelRecord("48491:1");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-malformed-cell");
  });

  it("no cell row at all (no-such-parcel-or-rail) maps to parcel-record-cell-miss, distinct from unaccounted", async () => {
    setParcelRecordQueryableForTests(memoryParcelRecordStore({ cells: [] }));
    const result = await agValuationFactFromParcelRecord("48491:999999");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-cell-miss");
  });
});
