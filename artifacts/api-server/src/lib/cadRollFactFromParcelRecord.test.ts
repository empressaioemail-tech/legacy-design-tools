/**
 * cadRollFactFromParcelRecord.ts — the PARCEL-B-SLATE2 adapter, as amended by
 * P-269 (folded into P-297, operator ruling A-193). Fixtures mirror LIVE
 * parcel_record data, read 2026-09-03 via the RO credential: gold parcel
 * 48021:34137 (improvementValue=404630, landValue=106715, marketValue=511345,
 * yearBuilt=1910, assessedValue and livingAreaSqft both absent-verified) and
 * the mandatory Williamson wire-probe pair R664999/R665023 (S6-COLLISION's own
 * post-fix honest state: landValue, improvementValue, assessedValue all
 * absent-verified; marketValue a genuinely shared, native, correct 134000 on
 * both -- confirmed by S6-COLLISION's own close, NOT a collision artifact).
 *
 * P-269's own assertions live at the bottom of each describe block: a refused
 * cell, a malformed value, an unreadable store, and an absent valueBasis all
 * produce a DECLARED REFUSAL (or, for valueBasis, no label at all) -- never
 * the null that used to mean "the caller keeps the legacy value".
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  memoryParcelRecordStore,
  resetParcelRecordQueryableForTests,
  setParcelRecordQueryableForTests,
} from "./parcelRecordCellRead";
import {
  PARCEL_RECORD_REFUSAL_CODES,
  dollarFactFromParcelRecord,
  isParcelRecordRefusal,
  livingAreaSqftFromParcelRecord,
  resolveValueBasisFromParcelRecord,
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
    const result = await dollarFactFromParcelRecord("48021", "34137", "improvementValue", "county-assessed");
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
    const result = await dollarFactFromParcelRecord("48021", "34137", "assessedValue", "county-assessed");
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
    const result = await dollarFactFromParcelRecord("48021", "99999", "improvementValue", "county-assessed");
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
    const a = await dollarFactFromParcelRecord("48491", "R664999", "marketValue", "county-assessed");
    const b = await dollarFactFromParcelRecord("48491", "R665023", "marketValue", "county-assessed");
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
    const result = await dollarFactFromParcelRecord("48491", "R664999", "landValue", "county-assessed");
    expect(result?.state).toBe("absent");
  });

  it("CTX-B1: valueBasis is a pass-through parameter, not re-derived per rail -- a stratmap-redistributed tier serialises unchanged, never coerced to county-assessed", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48309:184293", railKey: "marketValue", cellState: { kind: "value", value: "6506490", source: "cad_property", vintage: "2025" } },
        ],
      }),
    );
    const result = await dollarFactFromParcelRecord("48309", "184293", "marketValue", "stratmap-redistributed");
    expect(result).toMatchObject({ state: "present", v: 6506490, valueBasis: "stratmap-redistributed" });
  });

  /**
   * P-269's headline falsifier: "a test that fails if a refused cell ever
   * yields the legacy value". Before P-269 this call returned `null`, and
   * `null` is precisely how the caller (attachCadRollOverlaysToFacets) was
   * told to keep the offline bake's number.
   */
  it("FALSIFIER (P-269): an unaccounted cell is a DECLARED REFUSAL, never null, never the legacy value", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({ cells: [{ placeKey: "48021:1", railKey: "marketValue", cellState: { kind: "unaccounted" } }] }),
    );
    const result = await dollarFactFromParcelRecord("48021", "1", "marketValue", "county-assessed");
    expect(result).not.toBeNull();
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe(PARCEL_RECORD_REFUSAL_CODES.unaccounted);
    expect(result.reason).toContain("has not yet examined this rail");
  });

  it("FALSIFIER (P-269): an engine-refused cell carries the engine's own reason to the wire", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48021:1", railKey: "marketValue", cellState: { kind: "refused", reason: "no CAD district covers this account" } },
        ],
      }),
    );
    const result = await dollarFactFromParcelRecord("48021", "1", "marketValue", "county-assessed");
    expect(result).toEqual({
      state: "refused",
      code: PARCEL_RECORD_REFUSAL_CODES["engine-refused"],
      reason: "no CAD district covers this account",
    });
  });

  it("FALSIFIER (P-269): a value cell whose payload does not coerce is a malformed-cell refusal, never null", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48021:1", railKey: "marketValue", cellState: { kind: "value", value: "not-a-number", source: "cad_property", vintage: "v" } },
        ],
      }),
    );
    const result = await dollarFactFromParcelRecord("48021", "1", "marketValue", "county-assessed");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe(PARCEL_RECORD_REFUSAL_CODES["malformed-cell"]);
    expect(result.reason).toContain("not-a-number");
  });

  it("FALSIFIER (P-269): an unconfigured store is a declared refusal, never null -- 'the read did not happen' is not 'no value'", async () => {
    setParcelRecordQueryableForTests(null);
    const result = await dollarFactFromParcelRecord("48021", "34137", "marketValue", "county-assessed");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe(PARCEL_RECORD_REFUSAL_CODES["store-not-configured"]);
  });

  it("FALSIFIER (P-269): a null valueBasis is OMITTED from the wire, not defaulted to a label nothing verified", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48021:1", railKey: "marketValue", cellState: { kind: "value", value: "250000", source: "cad_property", vintage: "v" } },
        ],
      }),
    );
    const result = await dollarFactFromParcelRecord("48021", "1", "marketValue", null);
    expect(result).toEqual({ state: "present", v: 250000, source: "cad_property", vintage: "v" });
    expect("valueBasis" in result).toBe(false);
  });
});

describe("resolveValueBasisFromParcelRecord", () => {
  it("required violation test: assessedValue absent (StratMap structurally cannot populate it) resolves stratmap-redistributed, never county-assessed", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48309:184293", railKey: "assessedValue", cellState: { kind: "absent-verified", basis: GOLD_ABSENT_BASIS } },
        ],
      }),
    );
    const basis = await resolveValueBasisFromParcelRecord("48309", "184293");
    expect(basis).not.toBe("county-assessed");
    expect(basis).toBe("stratmap-redistributed");
  });

  it("a not-applicable assessedValue cell resolves stratmap-redistributed too -- a stated absence is not an assertion about provenance, but it is not silence either (P-269 CP1 answer)", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48309:184294", railKey: "assessedValue", cellState: { kind: "not-applicable", reason: "county does not assess this account class" } },
        ],
      }),
    );
    expect(await resolveValueBasisFromParcelRecord("48309", "184294")).toBe("stratmap-redistributed");
  });

  it("control: a genuine present assessedValue resolves county-assessed -- Caldwell 48055:32541", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48055:32541", railKey: "assessedValue", cellState: { kind: "value", value: "1884580", source: "cad_property", vintage: "2026-caldwell-cad-export_june-5-2026" } },
        ],
      }),
    );
    const basis = await resolveValueBasisFromParcelRecord("48055", "32541");
    expect(basis).toBe("county-assessed");
  });

  it("FALSIFIER (P-269): a refused/unaccounted assessedValue cell asserts NOTHING -- the answer is null, not a publisher's label", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({ cells: [{ placeKey: "48021:1", railKey: "assessedValue", cellState: { kind: "unaccounted" } }] }),
    );
    expect(await resolveValueBasisFromParcelRecord("48021", "1")).toBeNull();
  });

  it("FALSIFIER (P-269): an unreadable store asserts nothing either -- null, never county-assessed and never stratmap-redistributed", async () => {
    setParcelRecordQueryableForTests(null);
    expect(await resolveValueBasisFromParcelRecord("48021", "34137")).toBeNull();
  });

  it("FALSIFIER (P-269): a value cell that does not coerce is not evidence of a CAD-district export -- null, not county-assessed", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48021:2", railKey: "assessedValue", cellState: { kind: "value", value: "n/a", source: "cad_property", vintage: "v" } },
        ],
      }),
    );
    expect(await resolveValueBasisFromParcelRecord("48021", "2")).toBeNull();
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

  it("FALSIFIER (P-269): a stored 0 sqft is a declared malformed-cell refusal, never null-as-keep-legacy and never a populated zero", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({ cells: [{ placeKey: "48021:1", railKey: "livingAreaSqft", cellState: { kind: "value", value: "0", source: "cad_property", vintage: "v" } }] }),
    );
    const result = await livingAreaSqftFromParcelRecord("48021", "1");
    expect(isParcelRecordRefusal(result)).toBe(true);
    if (!isParcelRecordRefusal(result)) throw new Error("unreachable");
    expect(result.code).toBe(PARCEL_RECORD_REFUSAL_CODES["malformed-cell"]);
  });

  it("FALSIFIER (P-269): a refused cell is a declared refusal, never null", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({ cells: [{ placeKey: "48021:1", railKey: "livingAreaSqft", cellState: { kind: "refused", reason: "no footprint source" } }] }),
    );
    const result = await livingAreaSqftFromParcelRecord("48021", "1");
    expect(isParcelRecordRefusal(result)).toBe(true);
    if (!isParcelRecordRefusal(result)) throw new Error("unreachable");
    expect(result.reason).toBe("no footprint source");
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

  it("LIVE-SHAPE: the Williamson pair's absent yearBuilt returns null -- a stated absence, the only shape this rail's consumers have for one", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({ cells: [{ placeKey: "48491:R664999", railKey: "yearBuilt", cellState: { kind: "absent-verified", basis: {} } }] }),
    );
    const result = await yearBuiltFromParcelRecord("48491", "R664999");
    expect(result).toBeNull();
  });

  it("FALSIFIER (P-269): a year of 0 is a declared malformed-cell refusal, never null-as-keep-legacy and never served as a real year", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({ cells: [{ placeKey: "48021:1", railKey: "yearBuilt", cellState: { kind: "value", value: 0, source: "cad_property", vintage: "v" } }] }),
    );
    const result = await yearBuiltFromParcelRecord("48021", "1");
    expect(isParcelRecordRefusal(result)).toBe(true);
    if (!isParcelRecordRefusal(result)) throw new Error("unreachable");
    expect(result.code).toBe(PARCEL_RECORD_REFUSAL_CODES["malformed-cell"]);
  });

  it("FALSIFIER (P-269): a refused yearBuilt cell is a declared refusal carrying the cell's reason", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({ cells: [{ placeKey: "48021:1", railKey: "yearBuilt", cellState: { kind: "refused", reason: "construction year ambiguous" } }] }),
    );
    const result = await yearBuiltFromParcelRecord("48021", "1");
    expect(isParcelRecordRefusal(result)).toBe(true);
    if (!isParcelRecordRefusal(result)) throw new Error("unreachable");
    expect(result.reason).toBe("construction year ambiguous");
  });
});
