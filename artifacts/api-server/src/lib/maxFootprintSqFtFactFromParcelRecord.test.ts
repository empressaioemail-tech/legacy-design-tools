/**
 * maxFootprintSqFtFactFromParcelRecord.ts — the serve/prod-cutover adapter.
 * Fixtures mirror the real writer shape in hauska-factory's
 * parcel-envelope-cells.mjs (live sample: 48491:R391328 value=2658.8,
 * inputs{parcelAreaSqFt:5317.61, maxLotCoveragePct:50}).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  memoryParcelRecordStore,
  resetParcelRecordQueryableForTests,
  setParcelRecordQueryableForTests,
} from "./parcelRecordCellRead";
import { maxFootprintSqFtFactFromParcelRecord } from "./maxFootprintSqFtFactFromParcelRecord";
import { MAX_FOOTPRINT_SQFT_RAIL_KEY } from "./maxFootprintSqFtFactRead";

afterEach(() => {
  resetParcelRecordQueryableForTests();
});

describe("maxFootprintSqFtFactFromParcelRecord", () => {
  it("a malformed parcelNodeId refuses invalid-parcel-node-id without touching the store", async () => {
    const result = await maxFootprintSqFtFactFromParcelRecord("not-a-valid-id");
    expect(result).toEqual({
      state: "refused",
      code: "invalid-parcel-node-id",
      source: "max-footprint-sqft-fact",
      entityId: null,
      reason:
        '"not-a-valid-id" is not a valid parcel node id (county_fips:prop_id). Refusing rather than guessing a place_key.',
    });
  });

  it("no store configured refuses parcel-record-store-not-configured", async () => {
    setParcelRecordQueryableForTests(null);
    const result = await maxFootprintSqFtFactFromParcelRecord("48491:R391328");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-store-not-configured");
  });

  it("LIVE-SHAPE: a real derived cell (2658.8 sqft = 5317.61 x 50 / 100) maps to a present fact carrying its inputs off the cell itself", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48491:R391328",
            railKey: MAX_FOOTPRINT_SQFT_RAIL_KEY,
            cellState: {
              kind: "value",
              value: 2658.8,
              inputs: { parcelAreaSqFt: 5317.61, maxLotCoveragePct: 50 },
              method: "parcelAreaSqFt x maxLotCoveragePct / 100",
              source: "@empressaio/setback-corpus@1.1.0:round-rock-tx",
              vintage: "2026-09-11T01:14:13.820Z",
            },
          },
        ],
      }),
    );
    const result = await maxFootprintSqFtFactFromParcelRecord("48491:R391328");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.sqFt).toBe(2658.8);
    expect(result.inputs).toEqual({ parcelAreaSqFt: 5317.61, maxLotCoveragePct: 50 });
    expect(result.method).toContain("parcelAreaSqFt");
  });

  it("a present cell with no inputs recorded yields inputs: null, never a fabricated pair", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48021:1", railKey: MAX_FOOTPRINT_SQFT_RAIL_KEY, cellState: { kind: "value", value: 1200, method: "parcelAreaSqFt x maxLotCoveragePct / 100", source: "corpus", vintage: "2026-09-11" } },
        ],
      }),
    );
    const result = await maxFootprintSqFtFactFromParcelRecord("48021:1");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.inputs).toBeNull();
  });

  it("deferred/unaccounted (the maxLotCoveragePct-blocked residual) refuses, never a fabricated absence or present", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48055:1", railKey: MAX_FOOTPRINT_SQFT_RAIL_KEY, cellState: { kind: "unaccounted" } },
        ],
      }),
    );
    const result = await maxFootprintSqFtFactFromParcelRecord("48055:1");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-unaccounted");
  });

  it("a value cell whose value is not a readable number refuses rather than inventing a sqFt", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48491:1", railKey: MAX_FOOTPRINT_SQFT_RAIL_KEY, cellState: { kind: "value", value: null, source: "corpus", vintage: "2026-09-11" } },
        ],
      }),
    );
    const result = await maxFootprintSqFtFactFromParcelRecord("48491:1");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-malformed-cell");
  });

  it("no cell row at all (no-such-parcel-or-rail) maps to parcel-record-cell-miss, distinct from unaccounted", async () => {
    setParcelRecordQueryableForTests(memoryParcelRecordStore({ cells: [] }));
    const result = await maxFootprintSqFtFactFromParcelRecord("48491:999999");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-cell-miss");
  });
});
