/**
 * maxImperviousCoverPctFactFromParcelRecord.ts — the serve/prod-cutover
 * adapter. Fixtures mirror the real writer shape in hauska-factory's
 * parcel-max-impervious-cover.mjs: maxImperviousCoverCellState
 * ({kind:"value", value:<percent>, watershedType, inRechargeZone,
 * crosswalkCitation, source, vintage}, live sample from the wave2 close:
 * WATER SUPPLY SUBURBAN -> 30%, LDC Sec. 25-8-423(B)).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  memoryParcelRecordStore,
  resetParcelRecordQueryableForTests,
  setParcelRecordQueryableForTests,
} from "./parcelRecordCellRead";
import { maxImperviousCoverPctFactFromParcelRecord } from "./maxImperviousCoverPctFactFromParcelRecord";
import { MAX_IMPERVIOUS_COVER_PCT_RAIL_KEY } from "./maxImperviousCoverPctFactRead";

afterEach(() => {
  resetParcelRecordQueryableForTests();
});

describe("maxImperviousCoverPctFactFromParcelRecord", () => {
  it("a malformed parcelNodeId refuses invalid-parcel-node-id without touching the store", async () => {
    const result = await maxImperviousCoverPctFactFromParcelRecord("not-a-valid-id");
    expect(result).toEqual({
      state: "refused",
      code: "invalid-parcel-node-id",
      source: "max-impervious-cover-pct-fact",
      entityId: null,
      reason:
        '"not-a-valid-id" is not a valid parcel node id (county_fips:prop_id). Refusing rather than guessing a place_key.',
    });
  });

  it("no store configured refuses parcel-record-store-not-configured", async () => {
    setParcelRecordQueryableForTests(null);
    const result = await maxImperviousCoverPctFactFromParcelRecord("48453:34137");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-store-not-configured");
  });

  it("LIVE-SHAPE: a real WATER SUPPLY SUBURBAN cell (30%, LDC Sec. 25-8-423(B)) maps to a present fact carrying its extra fields off the cell itself", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48453:34137",
            railKey: MAX_IMPERVIOUS_COVER_PCT_RAIL_KEY,
            cellState: {
              kind: "value",
              value: 30,
              watershedType: "WATER SUPPLY SUBURBAN",
              inRechargeZone: false,
              crosswalkCitation:
                "Austin LDC Ch. 25-8, Subchapter A, Article 7 (Water Supply Suburban Watershed Regulations), Uplands Zone impervious cover provision (commonly cited as 25-8-423(B))",
              source: "tx_austin_watershed",
              vintage: "2026-09-04T00:00:00.000Z",
            },
          },
        ],
      }),
    );
    const result = await maxImperviousCoverPctFactFromParcelRecord("48453:34137");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.percent).toBe(30);
    expect(result.watershedType).toBe("WATER SUPPLY SUBURBAN");
    expect(result.inRechargeZone).toBe(false);
    expect(result.crosswalkCitation).toContain("25-8-423(B)");
  });

  it("inRechargeZone true is preserved, not defaulted false", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48453:55555",
            railKey: MAX_IMPERVIOUS_COVER_PCT_RAIL_KEY,
            cellState: { kind: "value", value: 30, watershedType: "WATER SUPPLY SUBURBAN", inRechargeZone: true, crosswalkCitation: "cited", source: "tx_austin_watershed", vintage: "2026-09-04" },
          },
        ],
      }),
    );
    const result = await maxImperviousCoverPctFactFromParcelRecord("48453:55555");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.inRechargeZone).toBe(true);
  });

  it("THE LOAD-BEARING CASE: unaccounted (a parcel outside Austin's watershed-regulation area entirely, the normal/expected case per this rail's own module doc) refuses, never a fabricated absence or present", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48453:493738", railKey: MAX_IMPERVIOUS_COVER_PCT_RAIL_KEY, cellState: { kind: "unaccounted" } },
        ],
      }),
    );
    const result = await maxImperviousCoverPctFactFromParcelRecord("48453:493738");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-unaccounted");
  });

  it("a value cell whose value is not a readable number refuses rather than inventing a percent", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48453:1", railKey: MAX_IMPERVIOUS_COVER_PCT_RAIL_KEY, cellState: { kind: "value", value: null, source: "tx_austin_watershed", vintage: "2026-09-04" } },
        ],
      }),
    );
    const result = await maxImperviousCoverPctFactFromParcelRecord("48453:1");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-malformed-cell");
  });

  it("no cell row at all (no-such-parcel-or-rail) maps to parcel-record-cell-miss, distinct from unaccounted", async () => {
    setParcelRecordQueryableForTests(memoryParcelRecordStore({ cells: [] }));
    const result = await maxImperviousCoverPctFactFromParcelRecord("48453:999999");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-cell-miss");
  });
});
