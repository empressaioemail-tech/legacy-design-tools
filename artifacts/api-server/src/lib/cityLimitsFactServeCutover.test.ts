/**
 * cityLimitsFactServeCutover.ts — P-297 (operator ruling A-193, OPS-24 law 7): the serve switch
 * is the code-owned SLATE, and what a parcel shows comes from ITS OWN cell.
 *
 * Rail note: cityLimits' legacy reader is POINT-based (loadCityLimitsFact takes a query
 * point, not a parcelNodeId) and its wire is `CityLimitsFactWire` — a refusal is served as
 * `status: "unmeasured"` with the reason in `basis`, NOT as a `state: "refused"` object.
 * That is this rail's existing refusal shape, reused rather than replaced.
 *
 * THIS FILE REPLACES the pre-P-297 suite, which pinned the old contract
 * ("only a PASS verdict reaches the record; refuse / excluded / no verdict /
 * store failure / no store all fall back to the legacy value"). Those
 * assertions encoded the exact defect the ruling names -- one unaccounted cell
 * anywhere in a slated county turning every parcel in it back to the bake --
 * so they are deleted rather than kept passing. The adapter's own answer
 * shapes are covered by <rail>FactFromParcelRecord.test.ts; what this file
 * covers is the SWITCH, per the dispatch's falsifiers 1, 2 and 4.
 */

import { afterEach, describe, expect, it } from "vitest";
import { loadCityLimitsFactForServe } from "./cityLimitsFactServeCutover";
import { loadCityLimitsFact } from "./cityLimitsFactRead";
import {
  memoryParcelRecordStore,
  resetParcelRecordQueryableForTests,
  setParcelRecordQueryableForTests,
  type ParcelRecordQueryable,
} from "./parcelRecordCellRead";
import { isSlatedForCellServe } from "./cellServeRule";

const RAIL_KEY = "cityLimits";
const SLATED = "48021:34137";
const UNSLATED = "48103:100";

afterEach(() => {
  resetParcelRecordQueryableForTests();
});

describe("cityLimitsFactServeCutover — the slate is the switch", () => {
  it("the slate says what this suite assumes about its two counties", () => {
    expect(isSlatedForCellServe("48021", RAIL_KEY)).toBe(true);
    expect(isSlatedForCellServe("48103", RAIL_KEY)).toBe(false);
  });

  it("an UNSLATED pair keeps the point-based legacy read, with zero parcel_record I/O", async () => {
    let calls = 0;
    const counter = {
      async query() {
        calls += 1;
        return { rows: [] };
      },
    } as ParcelRecordQueryable;
    const withoutStore = await loadCityLimitsFactForServe(UNSLATED, null);
    setParcelRecordQueryableForTests(counter);
    const withStore = await loadCityLimitsFactForServe(UNSLATED, null);
    expect(calls).toBe(0);
    expect(withStore).toEqual(withoutStore);
    expect(withoutStore).toEqual(await loadCityLimitsFact(null));
  });

  it("FALSIFIER 2: an unaccounted cell on a SLATED pair is served as this rail's own refusal shape, with the cell's reason", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [{ placeKey: SLATED, railKey: RAIL_KEY, cellState: { kind: "unaccounted" } }],
      }),
    );
    const served = await loadCityLimitsFactForServe(SLATED, null);
    const legacy = await loadCityLimitsFact(null);
    expect(served.status).toBe("unmeasured");
    expect(served.basis).toContain("unaccounted");
    expect(served.basis).toContain("has not yet examined this rail");
    expect(served).not.toEqual(legacy);
  });

  it("an UNSLATED-shaped malformed parcelNodeId falls through to the point-only legacy read", async () => {
    setParcelRecordQueryableForTests(memoryParcelRecordStore({ cells: [] }));
    const served = await loadCityLimitsFactForServe("not-a-valid-id", null);
    resetParcelRecordQueryableForTests();
    expect(served).toEqual(await loadCityLimitsFact(null));
  });

  it("a SLATED pair with a real absent-verified cell is served that determination, not the legacy read", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: SLATED,
            railKey: RAIL_KEY,
            cellState: { kind: "absent-verified", basis: { disposition: "unincorporated" } },
          },
        ],
      }),
    );
    const served = await loadCityLimitsFactForServe(SLATED, null);
    expect(served.status).not.toBe("unmeasured");
    expect(served.source).toBeDefined();
  });
});
