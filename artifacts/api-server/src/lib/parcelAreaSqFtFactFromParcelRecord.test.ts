/**
 * parcelAreaSqFtFactFromParcelRecord.ts — the serve/prod-cutover adapter.
 * Fixtures mirror the real writer shape in hauska-factory's
 * parcel-envelope-cells.mjs (live sample: 48491:R638791 value=7239.42,
 * method="ST_Area(geography) over ST_MakeValid(ST_Union(...)) of all
 * fragments for this prop_id", fragmentCount=1).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  memoryParcelRecordStore,
  resetParcelRecordQueryableForTests,
  setParcelRecordQueryableForTests,
} from "./parcelRecordCellRead";
import { parcelAreaSqFtFactFromParcelRecord } from "./parcelAreaSqFtFactFromParcelRecord";
import { PARCEL_AREA_SQFT_RAIL_KEY } from "./parcelAreaSqFtFactRead";

afterEach(() => {
  resetParcelRecordQueryableForTests();
});

describe("parcelAreaSqFtFactFromParcelRecord", () => {
  it("a malformed parcelNodeId refuses invalid-parcel-node-id without touching the store", async () => {
    const result = await parcelAreaSqFtFactFromParcelRecord("not-a-valid-id");
    expect(result).toEqual({
      state: "refused",
      code: "invalid-parcel-node-id",
      source: "parcel-area-sqft-fact",
      entityId: null,
      reason:
        '"not-a-valid-id" is not a valid parcel node id (county_fips:prop_id). Refusing rather than guessing a place_key.',
    });
  });

  it("no store configured refuses parcel-record-store-not-configured", async () => {
    setParcelRecordQueryableForTests(null);
    const result = await parcelAreaSqFtFactFromParcelRecord("48491:R638791");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-store-not-configured");
  });

  it("LIVE-SHAPE: a real geometry-derived cell (7239.42 sqft, 1 fragment) maps to a present fact carrying its extra fields off the cell itself", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48491:R638791",
            railKey: PARCEL_AREA_SQFT_RAIL_KEY,
            cellState: {
              kind: "value",
              value: 7239.42,
              method: "ST_Area(geography) over ST_MakeValid(ST_Union(...)) of all fragments for this prop_id",
              source: "txgio_parcel",
              vintage: "2026-09-11T01:14:13.820Z",
              fragmentCount: 1,
            },
          },
        ],
      }),
    );
    const result = await parcelAreaSqFtFactFromParcelRecord("48491:R638791");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.sqFt).toBe(7239.42);
    expect(result.fragmentCount).toBe(1);
    expect(result.method).toContain("ST_Area");
  });

  it("a multi-fragment parcel preserves its real fragmentCount, not defaulted to 1", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48453:55555",
            railKey: PARCEL_AREA_SQFT_RAIL_KEY,
            cellState: { kind: "value", value: 12000.5, method: "ST_Area(geography)...", source: "txgio_parcel", vintage: "2026-09-11", fragmentCount: 3 },
          },
        ],
      }),
    );
    const result = await parcelAreaSqFtFactFromParcelRecord("48453:55555");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.fragmentCount).toBe(3);
  });

  it("unaccounted (Hays, untouched by S2) refuses, never a fabricated absence or present", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48209:1", railKey: PARCEL_AREA_SQFT_RAIL_KEY, cellState: { kind: "unaccounted" } },
        ],
      }),
    );
    const result = await parcelAreaSqFtFactFromParcelRecord("48209:1");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-unaccounted");
  });

  it("a value cell whose value is not a readable number refuses rather than inventing a sqFt", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48021:1", railKey: PARCEL_AREA_SQFT_RAIL_KEY, cellState: { kind: "value", value: null, source: "txgio_parcel", vintage: "2026-09-11" } },
        ],
      }),
    );
    const result = await parcelAreaSqFtFactFromParcelRecord("48021:1");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-malformed-cell");
  });

  it("no cell row at all (no-such-parcel-or-rail) maps to parcel-record-cell-miss, distinct from unaccounted", async () => {
    setParcelRecordQueryableForTests(memoryParcelRecordStore({ cells: [] }));
    const result = await parcelAreaSqFtFactFromParcelRecord("48021:999999");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-cell-miss");
  });
});
