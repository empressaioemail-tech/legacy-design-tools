/**
 * maxHeightFtFactFromParcelRecord.ts — the serve/prod-cutover adapter.
 * Fixtures mirror the real writer shape in hauska-factory's
 * parcel-envelope-cells.mjs (live sample: 48021:34137 value=35,
 * districtCode=SF-1, bastrop-development-code).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  memoryParcelRecordStore,
  resetParcelRecordQueryableForTests,
  setParcelRecordQueryableForTests,
} from "./parcelRecordCellRead";
import { maxHeightFtFactFromParcelRecord } from "./maxHeightFtFactFromParcelRecord";
import { MAX_HEIGHT_FT_RAIL_KEY } from "./maxHeightFtFactRead";

afterEach(() => {
  resetParcelRecordQueryableForTests();
});

describe("maxHeightFtFactFromParcelRecord", () => {
  it("a malformed parcelNodeId refuses invalid-parcel-node-id without touching the store", async () => {
    const result = await maxHeightFtFactFromParcelRecord("not-a-valid-id");
    expect(result).toEqual({
      state: "refused",
      code: "invalid-parcel-node-id",
      source: "max-height-ft-fact",
      entityId: null,
      reason:
        '"not-a-valid-id" is not a valid parcel node id (county_fips:prop_id). Refusing rather than guessing a place_key.',
    });
  });

  it("no store configured refuses parcel-record-store-not-configured", async () => {
    setParcelRecordQueryableForTests(null);
    const result = await maxHeightFtFactFromParcelRecord("48021:34137");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-store-not-configured");
  });

  it("LIVE-SHAPE: a real Bastrop SF-1 cell (35 ft) maps to a present fact carrying its extra fields off the cell itself", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48021:34137",
            railKey: MAX_HEIGHT_FT_RAIL_KEY,
            cellState: {
              kind: "value",
              value: 35,
              source: "@empressaio/setback-corpus@1.1.0:bastrop-development-code",
              vintage: "2026-09-11T01:11:32.598Z",
              citationUrl: "https://www.cityofbastrop.org/page/open/18744/0/ORDINANCE.pdf",
              districtCode: "SF-1",
              districtName: "SF-1 Single-Family Residential",
              jurisdictionKey: "bastrop-development-code",
              resolvedTableKey: "bastrop-development-code",
            },
          },
        ],
      }),
    );
    const result = await maxHeightFtFactFromParcelRecord("48021:34137");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.feet).toBe(35);
    expect(result.districtCode).toBe("SF-1");
    expect(result.citationUrl).toContain("cityofbastrop.org");
  });

  it("absent-verified (a corpus-confirmed sentinel/no-value district) carries its basis honestly", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48491:1",
            railKey: MAX_HEIGHT_FT_RAIL_KEY,
            cellState: { kind: "absent-verified", basis: { method: "envelope-corpus-lookup", finding: "ENVELOPE_ROUTER_FIELD_NOT_SPECIFIED", districtCode: "GB", vintage: "2026-09-11" } },
          },
        ],
      }),
    );
    const result = await maxHeightFtFactFromParcelRecord("48491:1");
    expect(result.state).toBe("absent");
    if (result.state !== "absent") throw new Error("unreachable");
    expect(result.absence?.reason).toBe("ENVELOPE_ROUTER_FIELD_NOT_SPECIFIED");
  });

  it("deferred/unaccounted (the zoningDistrict-blocked residual) refuses, never a fabricated absence or present", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48453:1", railKey: MAX_HEIGHT_FT_RAIL_KEY, cellState: { kind: "unaccounted" } },
        ],
      }),
    );
    const result = await maxHeightFtFactFromParcelRecord("48453:1");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-unaccounted");
  });

  it("a value cell whose value is not a readable number refuses rather than inventing feet", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48021:1", railKey: MAX_HEIGHT_FT_RAIL_KEY, cellState: { kind: "value", value: null, source: "corpus", vintage: "2026-09-11" } },
        ],
      }),
    );
    const result = await maxHeightFtFactFromParcelRecord("48021:1");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-malformed-cell");
  });

  it("no cell row at all (no-such-parcel-or-rail) maps to parcel-record-cell-miss, distinct from unaccounted", async () => {
    setParcelRecordQueryableForTests(memoryParcelRecordStore({ cells: [] }));
    const result = await maxHeightFtFactFromParcelRecord("48021:999999");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-cell-miss");
  });
});
