/**
 * overlayDistrictsFactServeCutover.ts — P-297 (operator ruling A-193, OPS-24 law 7): the serve switch
 * is the code-owned SLATE, and what a parcel shows comes from ITS OWN cell.
 *
 * Rail note: overlayDistricts has no legacy reader, and its writer only writes a cell inside
 * the 12 confirmed cities -- so before this rail has a gate verdict most slated pairs still
 * refuse. Under the ruling that refusal names the PARCEL's own cell state, which is the
 * honest answer, instead of hiding behind a county-wide verdict.
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
import { loadOverlayDistrictsFactForServe } from "./overlayDistrictsFactServeCutover";
import {
  memoryParcelRecordStore,
  resetParcelRecordQueryableForTests,
  setParcelRecordQueryableForTests,
  type ParcelRecordQueryable,
} from "./parcelRecordCellRead";
import { isSlatedForCellServe } from "./cellServeRule";
import { notCutOverOverlayDistrictsFact } from "./overlayDistrictsFactRead";

const RAIL_KEY = "overlayDistricts";
const SLATED = "48021:34137";
const UNSLATED = "48103:100";

/** Counts every parcel_record query. Any call at all from an unslated pair is a defect. */
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

afterEach(() => {
  resetParcelRecordQueryableForTests();
});

describe("overlayDistrictsFactServeCutover — the slate is the switch", () => {
  it("the slate says what this suite assumes about its two counties", () => {
    expect(isSlatedForCellServe("48021", RAIL_KEY)).toBe(true);
    expect(isSlatedForCellServe("48103", RAIL_KEY)).toBe(false);
  });

  it("an UNSLATED pair never touches parcel_record — it runs the pre-cutover path, unchanged, with zero I/O", async () => {
    const withoutStore = await loadOverlayDistrictsFactForServe(UNSLATED);
    const counter = countingStore();
    setParcelRecordQueryableForTests(counter.store);
    const withStore = await loadOverlayDistrictsFactForServe(UNSLATED);
    expect(counter.calls()).toBe(0);
    expect(withStore).toEqual(withoutStore);
  });

  it("FALSIFIER 2: an unaccounted cell on a SLATED pair is a declared refusal carrying the cell's reason, never the pre-cutover answer", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [{ placeKey: SLATED, railKey: RAIL_KEY, cellState: { kind: "unaccounted" } }],
      }),
    );
    const served = await loadOverlayDistrictsFactForServe(SLATED);
    const preCutover = notCutOverOverlayDistrictsFact(SLATED);
    const wire = JSON.stringify(served);
    expect(served?.state).toBe("refused");
    expect(wire).toContain("parcel-record-unaccounted");
    expect(wire).toContain("has not yet examined this rail");
    expect(served).not.toEqual(preCutover);
  });

  it("an engine-refused cell on a SLATED pair is a declared refusal carrying the engine's own words", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: SLATED,
            railKey: RAIL_KEY,
            cellState: { kind: "refused", reason: "no source covers this parcel" },
          },
        ],
      }),
    );
    const served = await loadOverlayDistrictsFactForServe(SLATED);
    const wire = JSON.stringify(served);
    expect(served?.state).toBe("refused");
    expect(wire).toContain("parcel-record-engine-refused");
    expect(wire).toContain("no source covers this parcel");
  });

  it("FALSIFIER 1: a 48021 parcel whose own cell is earned is served that cell even though the county's verdict may read refuse", async () => {
    // No verdict store is injected anywhere in this file, and the wrapper has no
    // verdict seam left to inject one into: the verdict cannot reach this decision.
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: SLATED,
            railKey: RAIL_KEY,
            cellState: { kind: "absent-verified", basis: { method: "sweep", finding: "swept, none found" } },
          },
        ],
      }),
    );
    const served = await loadOverlayDistrictsFactForServe(SLATED);
    expect(served?.state).toBe("absent");
  });

  it("a SLATED pair whose cell row does not exist is a declared refusal naming the missing row", async () => {
    setParcelRecordQueryableForTests(memoryParcelRecordStore({ cells: [] }));
    const served = await loadOverlayDistrictsFactForServe(SLATED);
    const wire = JSON.stringify(served);
    expect(served?.state).toBe("refused");
    expect(wire).toContain("parcel-record-cell-miss");
  });

  it("an unreadable/unconfigured store on a SLATED pair is a declared refusal, never the pre-cutover answer", async () => {
    setParcelRecordQueryableForTests(null);
    const served = await loadOverlayDistrictsFactForServe(SLATED);
    const preCutover = notCutOverOverlayDistrictsFact(SLATED);
    expect(served?.state).toBe("refused");
    expect(JSON.stringify(served)).toContain("parcel-record-store-not-configured");
    expect(served).not.toEqual(preCutover);
  });

  it("a malformed parcelNodeId keeps the pre-cutover path's own answer (no place_key is guessed)", async () => {
    setParcelRecordQueryableForTests(memoryParcelRecordStore({ cells: [] }));
    const malformed = "not-a-valid-id";
    const viaWrapper = await loadOverlayDistrictsFactForServe(malformed);
    resetParcelRecordQueryableForTests();
    const withoutStore = await loadOverlayDistrictsFactForServe(malformed);
    expect(viaWrapper).toEqual(withoutStore);
  });
});
