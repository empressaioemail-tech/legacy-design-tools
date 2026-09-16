/**
 * floodHazardFactServeCutover.ts — P-297 (operator ruling A-193, OPS-24 law
 * 7): the serve switch is the code-owned SLATE, and what a parcel shows comes
 * from ITS OWN cell.
 *
 * Rail note: flood is slated in all six counties, Caldwell (48055) included —
 * the pair the slate deliberately kept listed so an excluded/refused verdict
 * would be VISIBLE. Under this ruling the visibility is the PARCEL's, decided
 * by its own cell.
 *
 * STORE SEAM DIFFERENCE, DISCLOSED: this rail's adapter does NOT read through
 * `parcelRecordCellRead.ts`. It reuses `parcelRecordFactRead.ts`'s
 * `loadParcelRecordFloodFact` (PARCEL-C-REPORT's own already-deployed flood
 * cell read), so its test store is injected through THAT module's seam
 * (`memoryParcelRecordFlood`). Both seams exist in this repo for two different
 * consumers; this file uses the one this rail actually goes through.
 *
 * THIS FILE REPLACES the pre-P-297 suite, which pinned the old contract
 * ("only a PASS verdict reaches the record; refuse / excluded / no verdict /
 * store failure / no store all fall back to the legacy atom"). Those
 * assertions encoded the exact defect the ruling names, so they are deleted
 * rather than kept passing.
 */

import { afterEach, describe, expect, it } from "vitest";
import { loadFloodHazardFactForServe } from "./floodHazardFactServeCutover";
import { loadFloodHazardFactAtom } from "./floodHazardFactRead";
import {
  FLOOD_RAIL_KEY,
  memoryParcelRecordFlood,
  resetParcelRecordQueryableForTests,
  setParcelRecordQueryableForTests,
} from "./parcelRecordFactRead";
import { isSlatedForCellServe } from "./cellServeRule";

const RAIL_KEY = "flood";
const SLATED = "48021:34137";
const UNSLATED = "48103:100";

afterEach(() => {
  resetParcelRecordQueryableForTests();
});

describe("loadFloodHazardFactForServe — the slate is the switch", () => {
  it("the slate says what this suite assumes about its two counties", () => {
    expect(isSlatedForCellServe("48021", RAIL_KEY)).toBe(true);
    expect(isSlatedForCellServe("48055", RAIL_KEY)).toBe(true); // Caldwell, deliberately listed
    expect(isSlatedForCellServe("48103", RAIL_KEY)).toBe(false);
    expect(FLOOD_RAIL_KEY).toBe(RAIL_KEY);
  });

  it("an UNSLATED pair never touches parcel_record — it runs the atom path, unchanged, with zero I/O", async () => {
    let calls = 0;
    const withoutStore = await loadFloodHazardFactForServe(UNSLATED);
    setParcelRecordQueryableForTests({
      async query() {
        calls += 1;
        return { rows: [] };
      },
    });
    const withStore = await loadFloodHazardFactForServe(UNSLATED);
    expect(calls).toBe(0);
    expect(withStore).toEqual(withoutStore);
  });

  it("FALSIFIER 2: an unaccounted cell on a SLATED pair is a declared refusal carrying the cell's reason, never the atom answer", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordFlood([{ placeKey: SLATED, cellState: { kind: "unaccounted" } }]),
    );
    const served = await loadFloodHazardFactForServe(SLATED);
    const preCutover = await loadFloodHazardFactAtom(SLATED);
    expect(served?.state).toBe("refused");
    expect(JSON.stringify(served)).toContain("parcel-record-unaccounted");
    expect(JSON.stringify(served)).toContain("has not yet examined flood");
    expect(served).not.toEqual(preCutover);
  });

  it("an engine-refused cell on a SLATED pair is a declared refusal carrying the engine's own words", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordFlood([
        { placeKey: SLATED, cellState: { kind: "refused", reason: "no flood source covers this parcel" } },
      ]),
    );
    const served = await loadFloodHazardFactForServe(SLATED);
    expect(served?.state).toBe("refused");
    expect(JSON.stringify(served)).toContain("no flood source covers this parcel");
  });

  it("FALSIFIER 1: a slated parcel whose own cell is earned is served that cell, with no verdict store anywhere in this file", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordFlood([
        {
          placeKey: SLATED,
          cellState: { kind: "absent-verified", basis: { method: "sweep", finding: "swept, none found" } },
        },
      ]),
    );
    const served = await loadFloodHazardFactForServe(SLATED);
    expect(served?.state).toBe("absent");
    if (served?.state !== "absent" || !served.absence) throw new Error("unreachable");
    expect(served.absence.kind).toBe("absent-verified");
  });

  it("a present flood zone cell is served as a present determination (the value form)", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordFlood([
        {
          placeKey: SLATED,
          cellState: { kind: "value", source: "fema-nfhl", vintage: "2026-08-01" },
          payload: { zone: "AE", floodway: false, bfe: 412, method: "nfhl-sweep", sourceVintage: "2026-08-01" },
        },
      ]),
    );
    const served = await loadFloodHazardFactForServe(SLATED);
    expect(served?.state).toBe("present");
    if (served?.state !== "present") throw new Error("unreachable");
    expect(served.floodZone).toBe("AE");
    expect(served.inSpecialFloodHazardArea).toBe(true);
  });

  it("a SLATED pair whose cell row does not exist is a declared refusal naming the missing row", async () => {
    setParcelRecordQueryableForTests(memoryParcelRecordFlood([]));
    const served = await loadFloodHazardFactForServe(SLATED);
    expect(served?.state).toBe("refused");
    expect(JSON.stringify(served)).toContain("parcel-record-cell-miss");
  });

  it("an unreadable/unconfigured store on a SLATED pair is a declared refusal, never the atom answer", async () => {
    resetParcelRecordQueryableForTests();
    setParcelRecordQueryableForTests(null);
    const served = await loadFloodHazardFactForServe(SLATED);
    const preCutover = await loadFloodHazardFactAtom(SLATED);
    expect(served?.state).toBe("refused");
    expect(JSON.stringify(served)).toContain("parcel-record-store-not-configured");
    expect(served).not.toEqual(preCutover);
  });

  it("a malformed parcelNodeId keeps the atom read's own answer (no place_key is guessed)", async () => {
    setParcelRecordQueryableForTests(memoryParcelRecordFlood([]));
    const malformed = "not-a-valid-id";
    const viaWrapper = await loadFloodHazardFactForServe(malformed);
    resetParcelRecordQueryableForTests();
    const withoutStore = await loadFloodHazardFactForServe(malformed);
    expect(viaWrapper).toEqual(withoutStore);
  });
});
