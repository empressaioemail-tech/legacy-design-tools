/**
 * cadRollFactFromParcelRecord.ts — the PARCEL-B-SLATE2 adapter. Fixtures
 * mirror LIVE parcel_record data, read 2026-09-03 via the RO credential:
 * gold parcel 48021:34137 (improvementValue=404630, landValue=106715,
 * marketValue=511345, yearBuilt=1910, assessedValue and livingAreaSqft both
 * absent-verified) and the mandatory Williamson wire-probe pair
 * R664999/R665023 (S6-COLLISION's own post-fix honest state: landValue,
 * improvementValue, assessedValue all absent-verified; marketValue a
 * genuinely shared, native, correct 134000 on both -- confirmed by
 * S6-COLLISION's own close, NOT a collision artifact).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  memoryParcelRecordStore,
  resetParcelRecordQueryableForTests,
  setParcelRecordQueryableForTests,
} from "./parcelRecordCellRead";
import {
  dollarFactFromParcelRecord,
  livingAreaSqftFromParcelRecord,
  yearBuiltFromParcelRecord,
} from "./cadRollFactFromParcelRecord";

afterEach(() => {
  resetParcelRecordQueryableForTests();
});

const GOLD_ABSENT_BASIS = {
  propId: "34137",
  source: "cad_property",
  taxYear: 2025,
  vintage: "2026-09-02T18:13:56.751Z",
  countyFips: "48021",
};

describe("dollarFactFromParcelRecord", () => {
  it("LIVE-SHAPE: a stringified dollar value (gold improvementValue) coerces to a present wire", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48021:34137",
            railKey: "improvementValue",
            cellState: { kind: "value", value: "404630", source: "cad_property", vintage: "2026-09-02T18:13:56.751Z" },
          },
        ],
      }),
    );
    const result = await dollarFactFromParcelRecord("48021", "34137", "improvementValue");
    expect(result).toEqual({
      state: "present",
      v: 404630,
      source: "cad_property",
      vintage: "2026-09-02T18:13:56.751Z",
      valueBasis: "county-assessed",
    });
  });

  it("LIVE-SHAPE: absent-verified (gold assessedValue's real basis shape) maps to CadRollAbsentWire, never a fabricated 0", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48021:34137", railKey: "assessedValue", cellState: { kind: "absent-verified", basis: GOLD_ABSENT_BASIS } },
        ],
      }),
    );
    const result = await dollarFactFromParcelRecord("48021", "34137", "assessedValue");
    expect(result?.state).toBe("absent");
  });

  it("falsifier: a stored 0 is a real zero, never collapsed to absent (Bastrop vacant-land parity with cadRollValue.ts's own rule)", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48021:99999", railKey: "improvementValue", cellState: { kind: "value", value: "0", source: "cad_property", vintage: "2026-09-02T18:13:56.751Z" } },
        ],
      }),
    );
    const result = await dollarFactFromParcelRecord("48021", "99999", "improvementValue");
    expect(result).toEqual({ state: "zero", v: 0, source: "cad_property", vintage: "2026-09-02T18:13:56.751Z", valueBasis: "county-assessed" });
  });

  it("LIVE-SHAPE: the Williamson pair's genuinely-shared native marketValue (134000 on both) reads through unchanged -- not a defect this adapter should mask or alter", async () => {
    const store = memoryParcelRecordStore({
      cells: [
        { placeKey: "48491:R664999", railKey: "marketValue", cellState: { kind: "value", value: "134000", source: "cad_property", vintage: "2026-09-02T16:23:02.321Z" } },
        { placeKey: "48491:R665023", railKey: "marketValue", cellState: { kind: "value", value: "134000", source: "cad_property", vintage: "2026-09-02T16:23:02.321Z" } },
      ],
    });
    setParcelRecordQueryableForTests(store);
    const a = await dollarFactFromParcelRecord("48491", "R664999", "marketValue");
    const b = await dollarFactFromParcelRecord("48491", "R665023", "marketValue");
    expect(a).toEqual({ state: "present", v: 134000, source: "cad_property", vintage: "2026-09-02T16:23:02.321Z", valueBasis: "county-assessed" });
    expect(b).toEqual(a);
  });

  it("LIVE-SHAPE: the Williamson pair's post-S6 honest absence on landValue -- never the pre-fix duplicated 613956", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48491:R664999", railKey: "landValue", cellState: { kind: "absent-verified", basis: { propId: "R664999", source: "cad_property", taxYear: 2025, vintage: "2026-09-02T16:23:02.321Z", countyFips: "48491" } } },
        ],
      }),
    );
    const result = await dollarFactFromParcelRecord("48491", "R664999", "landValue");
    expect(result?.state).toBe("absent");
  });

  it("a refused cell (unaccounted) returns null -- caller keeps the legacy value, refusal is not a fourth wire state", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({ cells: [{ placeKey: "48021:1", railKey: "marketValue", cellState: { kind: "unaccounted" } }] }),
    );
    const result = await dollarFactFromParcelRecord("48021", "1", "marketValue");
    expect(result).toBeNull();
  });

  it("store not configured returns null, never throws -- caller keeps the legacy value", async () => {
    setParcelRecordQueryableForTests(null);
    const result = await dollarFactFromParcelRecord("48021", "34137", "marketValue");
    expect(result).toBeNull();
  });
});

describe("livingAreaSqftFromParcelRecord", () => {
  it("LIVE-SHAPE: gold's absent-verified livingAreaSqft maps to absent-in-record", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({ cells: [{ placeKey: "48021:34137", railKey: "livingAreaSqft", cellState: { kind: "absent-verified", basis: GOLD_ABSENT_BASIS } }] }),
    );
    const result = await livingAreaSqftFromParcelRecord("48021", "34137");
    expect(result).toEqual({ status: "absent-in-record" });
  });

  it("a positive sqft value populates", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({ cells: [{ placeKey: "48021:1", railKey: "livingAreaSqft", cellState: { kind: "value", value: "2800", source: "cad_property", vintage: "v" } }] }),
    );
    const result = await livingAreaSqftFromParcelRecord("48021", "1");
    expect(result).toEqual({ status: "populated", value: 2800 });
  });

  it("falsifier: a stored 0 sqft is absent, never a populated zero (sqft is never zero, per positiveSqftOrNull)", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({ cells: [{ placeKey: "48021:1", railKey: "livingAreaSqft", cellState: { kind: "value", value: "0", source: "cad_property", vintage: "v" } }] }),
    );
    const result = await livingAreaSqftFromParcelRecord("48021", "1");
    expect(result).toBeNull();
  });
});

describe("yearBuiltFromParcelRecord", () => {
  it("LIVE-SHAPE: gold's real yearBuilt (raw number 1910, not a string) reads through", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({ cells: [{ placeKey: "48021:34137", railKey: "yearBuilt", cellState: { kind: "value", value: 1910, source: "cad_property", vintage: "2026-09-02T18:13:56.751Z" } }] }),
    );
    const result = await yearBuiltFromParcelRecord("48021", "34137");
    expect(result).toEqual({ v: 1910, source: "parcel_record", vintage: "2026-09-02T18:13:56.751Z" });
  });

  it("LIVE-SHAPE: the Williamson pair's absent yearBuilt returns null, never a fabricated year", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({ cells: [{ placeKey: "48491:R664999", railKey: "yearBuilt", cellState: { kind: "absent-verified", basis: {} } }] }),
    );
    const result = await yearBuiltFromParcelRecord("48491", "R664999");
    expect(result).toBeNull();
  });

  it("falsifier: a year of 0 is refused as invalid, never served as a real year", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({ cells: [{ placeKey: "48021:1", railKey: "yearBuilt", cellState: { kind: "value", value: 0, source: "cad_property", vintage: "v" } }] }),
    );
    const result = await yearBuiltFromParcelRecord("48021", "1");
    expect(result).toBeNull();
  });
});
