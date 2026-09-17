/**
 * cadRollServeCutover.ts — the PARCEL-B-SLATE2 integration point, under P-297
 * (operator ruling A-193) with P-269 folded in.
 *
 * The pre-P-297 suite asserted the old contract: an unslated county returns
 * every field null, a slated county overlays on a real PASS verdict, and
 * refuse / no verdict / store failure / an unset store all return null so the
 * caller keeps the bake. The last three of those encoded the defect the ruling
 * names, and they are deleted rather than kept passing. What remains is the
 * switch (slate, per rail) plus the refusal the customer now gets instead of a
 * stale baked number.
 *
 * NOTE the six rails are decided INDEPENDENTLY, and `livingAreaSqft` /
 * `yearBuilt` are in the slate for 48021 as well, so a slated parcel's overlay
 * is never "all null" merely because the dollar rails are unmet.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  memoryParcelRecordStore,
  resetParcelRecordQueryableForTests,
  setParcelRecordQueryableForTests,
  type ParcelRecordQueryable,
} from "./parcelRecordCellRead";
import { resolveCadRollOverlaysForServe } from "./cadRollServeCutover";
import { isSlatedForCellServe } from "./cellServeRule";
import { PARCEL_RECORD_REFUSAL_CODES } from "./cadRollFactFromParcelRecord";

afterEach(() => {
  resetParcelRecordQueryableForTests();
});

const NOW = "2026-09-03T07:00:00.000Z";
const SLATED = "48021:34137"; // Bastrop: all six rails are slated.
const UNSLATED = "48103:100"; // Crane: no rail is slated.

/** Counts every parcel_record query; any call from an unslated pair is a defect. */
function countingStore(): { store: ParcelRecordQueryable; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    store: {
      async query() {
        calls += 1;
        return { rows: [] };
      },
    } as ParcelRecordQueryable,
  };
}

describe("resolveCadRollOverlaysForServe — the slate is the switch, per rail", () => {
  it("the slate says what this suite assumes about its two parcels", () => {
    for (const rail of [
      "marketValue",
      "assessedValue",
      "landValue",
      "improvementValue",
      "livingAreaSqft",
      "yearBuilt",
    ]) {
      expect(isSlatedForCellServe("48021", rail), rail).toBe(true);
      expect(isSlatedForCellServe("48103", rail), rail).toBe(false);
    }
  });

  it("an UNSLATED county returns every field null — the caller keeps its own bake — with ZERO parcel_record I/O", async () => {
    const withoutStore = await resolveCadRollOverlaysForServe("48103", "100");
    expect(withoutStore).toEqual({
      marketValue: null,
      assessedValue: null,
      landValue: null,
      improvementValue: null,
      livingAreaSqft: null,
      yearBuilt: null,
    });
    const counter = countingStore();
    setParcelRecordQueryableForTests(counter.store);
    const withStore = await resolveCadRollOverlaysForServe("48103", "100");
    expect(counter.calls()).toBe(0);
    expect(withStore).toEqual(withoutStore);
  });

  it("FALSIFIER 1: a SLATED county serves each parcel from its own cells — no verdict store exists in this file to consult", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: SLATED, railKey: "marketValue", cellState: { kind: "value", value: "511345", source: "cad_property", vintage: NOW } },
          { placeKey: SLATED, railKey: "assessedValue", cellState: { kind: "value", value: "250000", source: "cad_property", vintage: NOW } },
          { placeKey: SLATED, railKey: "landValue", cellState: { kind: "value", value: "106715", source: "cad_property", vintage: NOW } },
          { placeKey: SLATED, railKey: "improvementValue", cellState: { kind: "value", value: "404630", source: "cad_property", vintage: NOW } },
          { placeKey: SLATED, railKey: "livingAreaSqft", cellState: { kind: "value", value: 1420, source: "cad_property", vintage: NOW } },
          { placeKey: SLATED, railKey: "yearBuilt", cellState: { kind: "value", value: 1910, source: "cad_property", vintage: NOW } },
        ],
      }),
    );
    const result = await resolveCadRollOverlaysForServe("48021", "34137");
    expect(result.marketValue).toEqual({ state: "present", v: 511345, source: "cad_property", vintage: NOW, valueBasis: "county-assessed" });
    expect(result.landValue).toEqual({ state: "present", v: 106715, source: "cad_property", vintage: NOW, valueBasis: "county-assessed" });
    expect(result.improvementValue).toEqual({ state: "present", v: 404630, source: "cad_property", vintage: NOW, valueBasis: "county-assessed" });
    expect(result.livingAreaSqft).toEqual({ status: "populated", value: 1420 });
    expect(result.yearBuilt).toEqual({ v: 1910, source: "parcel_record", vintage: NOW });
  });

  it("FALSIFIER 2: an unaccounted cell on a slated rail is a declared refusal, and the OTHER rails still serve their own cells", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: SLATED, railKey: "marketValue", cellState: { kind: "unaccounted" } },
          { placeKey: SLATED, railKey: "landValue", cellState: { kind: "value", value: "106715", source: "cad_property", vintage: NOW } },
        ],
      }),
    );
    const result = await resolveCadRollOverlaysForServe("48021", "34137");
    expect(result.marketValue).toEqual({
      state: "refused",
      code: PARCEL_RECORD_REFUSAL_CODES.unaccounted,
      reason: expect.stringContaining("has not yet examined this rail"),
    });
    // The same parcel's earned rail is unaffected: the verdict-shaped "one bad
    // cell turns the whole county back to the bake" reading is gone.
    expect(result.landValue).toMatchObject({ state: "present", v: 106715 });
    // And a rail with no cell row at all refuses by name rather than going null.
    expect(result.assessedValue).toMatchObject({ code: PARCEL_RECORD_REFUSAL_CODES["no-such-parcel-or-rail"] });
  });

  it("an unconfigured store on a slated county is a declared refusal per rail, never null (P-269)", async () => {
    setParcelRecordQueryableForTests(null);
    const result = await resolveCadRollOverlaysForServe("48021", "34137");
    expect(result.marketValue).toMatchObject({ code: PARCEL_RECORD_REFUSAL_CODES["store-not-configured"] });
    expect(result.livingAreaSqft).toMatchObject({ code: PARCEL_RECORD_REFUSAL_CODES["store-not-configured"] });
    expect(result.yearBuilt).toMatchObject({ code: PARCEL_RECORD_REFUSAL_CODES["store-not-configured"] });
  });

  it("valueBasis is omitted (not defaulted) when the store asserts nothing about assessedValue", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: SLATED, railKey: "marketValue", cellState: { kind: "value", value: "511345", source: "cad_property", vintage: NOW } },
          { placeKey: SLATED, railKey: "assessedValue", cellState: { kind: "unaccounted" } },
        ],
      }),
    );
    const result = await resolveCadRollOverlaysForServe("48021", "34137");
    expect(result.marketValue).toEqual({ state: "present", v: 511345, source: "cad_property", vintage: NOW });
  });

  it("the CTX-B1 basis is still ONE determination per parcel, shared by all four dollar rails", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: SLATED, railKey: "assessedValue", cellState: { kind: "value", value: "250000", source: "cad_property", vintage: NOW } },
          { placeKey: SLATED, railKey: "marketValue", cellState: { kind: "value", value: "511345", source: "cad_property", vintage: NOW } },
          { placeKey: SLATED, railKey: "landValue", cellState: { kind: "value", value: "106715", source: "cad_property", vintage: NOW } },
          { placeKey: SLATED, railKey: "improvementValue", cellState: { kind: "value", value: "404630", source: "cad_property", vintage: NOW } },
        ],
      }),
    );
    const result = await resolveCadRollOverlaysForServe("48021", "34137");
    for (const rail of ["marketValue", "assessedValue", "landValue", "improvementValue"] as const) {
      expect(result[rail]).toMatchObject({ valueBasis: "county-assessed" });
    }
  });
});
