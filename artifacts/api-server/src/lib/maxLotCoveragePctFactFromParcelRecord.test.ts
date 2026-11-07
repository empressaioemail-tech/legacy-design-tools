/**
 * maxLotCoveragePctFactFromParcelRecord.ts — the serve/prod-cutover
 * adapter. Fixtures mirror the real writer shape in hauska-factory's
 * parcel-envelope-cells.mjs (live sample: 48453:141689 value=40,
 * districtCode=SF-3, austin-tx).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  memoryParcelRecordStore,
  resetParcelRecordQueryableForTests,
  setParcelRecordQueryableForTests,
} from "./parcelRecordCellRead";
import { maxLotCoveragePctFactFromParcelRecord } from "./maxLotCoveragePctFactFromParcelRecord";
import { MAX_LOT_COVERAGE_PCT_RAIL_KEY } from "./maxLotCoveragePctFactRead";

afterEach(() => {
  resetParcelRecordQueryableForTests();
});

describe("maxLotCoveragePctFactFromParcelRecord", () => {
  it("a malformed parcelNodeId refuses invalid-parcel-node-id without touching the store", async () => {
    const result = await maxLotCoveragePctFactFromParcelRecord("not-a-valid-id");
    expect(result).toEqual({
      state: "refused",
      code: "invalid-parcel-node-id",
      source: "max-lot-coverage-pct-fact",
      entityId: null,
      reason:
        '"not-a-valid-id" is not a valid parcel node id (county_fips:prop_id). Refusing rather than guessing a place_key.',
    });
  });

  it("no store configured refuses parcel-record-store-not-configured", async () => {
    setParcelRecordQueryableForTests(null);
    const result = await maxLotCoveragePctFactFromParcelRecord("48453:141689");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-store-not-configured");
  });

  it("LIVE-SHAPE: a real Austin SF-3 cell (40%) maps to a present fact carrying its extra fields off the cell itself", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48453:141689",
            railKey: MAX_LOT_COVERAGE_PCT_RAIL_KEY,
            cellState: {
              kind: "value",
              value: 40,
              source: "@empressaio/setback-corpus@1.1.0:austin-tx",
              vintage: "2026-09-11T03:14:06.335Z",
              citationUrl: "https://services.austintexas.gov/edims/document.cfm?id=419477",
              districtCode: "SF-3",
              districtName: "SF-3 Family Residence",
              jurisdictionKey: "austin-tx",
              resolvedTableKey: "austin-tx",
            },
          },
        ],
      }),
    );
    const result = await maxLotCoveragePctFactFromParcelRecord("48453:141689");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.percent).toBe(40);
    expect(result.districtCode).toBe("SF-3");
  });

  it("deferred/unaccounted (the zoningDistrict-blocked residual) refuses, never a fabricated absence or present", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48309:1", railKey: MAX_LOT_COVERAGE_PCT_RAIL_KEY, cellState: { kind: "unaccounted" } },
        ],
      }),
    );
    const result = await maxLotCoveragePctFactFromParcelRecord("48309:1");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-unaccounted");
  });

  it("a value cell whose value is not a readable number refuses rather than inventing a percent", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48453:1", railKey: MAX_LOT_COVERAGE_PCT_RAIL_KEY, cellState: { kind: "value", value: null, source: "corpus", vintage: "2026-09-11" } },
        ],
      }),
    );
    const result = await maxLotCoveragePctFactFromParcelRecord("48453:1");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-malformed-cell");
  });

  it("no cell row at all (no-such-parcel-or-rail) maps to parcel-record-cell-miss, distinct from unaccounted", async () => {
    setParcelRecordQueryableForTests(memoryParcelRecordStore({ cells: [] }));
    const result = await maxLotCoveragePctFactFromParcelRecord("48453:999999");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-cell-miss");
  });
});
