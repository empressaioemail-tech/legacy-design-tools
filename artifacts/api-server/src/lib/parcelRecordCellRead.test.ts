/**
 * parcel_record per-parcel cell reader. No store for the pure-interpret
 * tests; a fake ParcelRecordQueryable for the async-load tests.
 *
 * unaccounted MUST interpret as a refusal, never a present/absent shape --
 * that is the load-bearing assertion of this file
 * (`_decisions/2026-09-01_serve_path_never_emits_pipeline_state.md`).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  interpretParcelRecordCell,
  loadParcelRecordCell,
  memoryParcelRecordStore,
  resetParcelRecordQueryableForTests,
  setParcelRecordQueryableForTests,
} from "./parcelRecordCellRead";

afterEach(() => {
  resetParcelRecordQueryableForTests();
});

describe("interpretParcelRecordCell — pure, fixture-driven", () => {
  it("a scalar value cell interprets as present with its value, source, and vintage", () => {
    const result = interpretParcelRecordCell("48021:34137", "apn", {
      kind: "value",
      value: "34137",
      source: "cad_property",
      vintage: "2025",
    }, []);
    expect(result).toEqual({
      state: "present",
      source: "parcel_record",
      placeKey: "48021:34137",
      railKey: "apn",
      cellSource: "cad_property",
      vintage: "2025",
      value: "34137",
      disposition: null,
      rowCount: null,
      companionRows: [],
    });
  });

  it("a companion value cell carries disposition, rowCount, and its companion rows", () => {
    const result = interpretParcelRecordCell(
      "48021:34137",
      "flood",
      { kind: "value", disposition: "rows", rowCount: 1, source: "tx_fema_nfhl_flood_zone", vintage: "NFHL_48_20260101" },
      [{ row_index: 0, payload: { zone: "AE", floodway: false }, source: "tx_fema_nfhl_flood_zone", vintage: "NFHL_48_20260101" }],
    );
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.disposition).toBe("rows");
    expect(result.rowCount).toBe(1);
    expect(result.companionRows).toEqual([
      { rowIndex: 0, payload: { zone: "AE", floodway: false }, source: "tx_fema_nfhl_flood_zone", vintage: "NFHL_48_20260101" },
    ]);
  });

  it("a companion value cell with disposition=empty-set carries zero companion rows honestly (sourced, found nothing)", () => {
    const result = interpretParcelRecordCell(
      "48021:34137",
      "wells",
      { kind: "value", disposition: "empty-set", rowCount: 0, source: "tx_rrc_well", vintage: "2026-09-02" },
      [],
    );
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.disposition).toBe("empty-set");
    expect(result.companionRows).toEqual([]);
  });

  it("absent-verified with a string basis (sweep) carries the string basis verbatim", () => {
    const result = interpretParcelRecordCell("48021:34137", "flood", {
      kind: "absent-verified",
      basis: "zone-major sweep, no containing NFHL zone found",
    }, []);
    expect(result).toEqual({
      state: "absent",
      source: "parcel_record",
      placeKey: "48021:34137",
      railKey: "flood",
      verdict: "absent-verified",
      basis: "zone-major sweep, no containing NFHL zone found",
    });
  });

  it("absent-verified with a CadNullVerifiedBasis object carries the structured basis, not stringified", () => {
    const basis = {
      source: "cad_property",
      countyFips: "48309",
      propId: "12345",
      taxYear: 2025,
      vintage: "2026-08-01",
    };
    const result = interpretParcelRecordCell("48309:12345", "assessedValue", {
      kind: "absent-verified",
      basis,
    }, []);
    expect(result.state).toBe("absent");
    if (result.state !== "absent") throw new Error("unreachable");
    expect(result.basis).toEqual(basis);
  });

  it("not-applicable carries the reason string as basis", () => {
    const result = interpretParcelRecordCell("48021:5001", "zoningDistrict", {
      kind: "not-applicable",
      reason: "unincorporated parcel — county does not zone land outside city limits",
    }, []);
    expect(result).toEqual({
      state: "absent",
      source: "parcel_record",
      placeKey: "48021:5001",
      railKey: "zoningDistrict",
      verdict: "not-applicable",
      basis: "unincorporated parcel — county does not zone land outside city limits",
    });
  });

  it("refused (the engine's own kind) interprets as a refusal carrying the engine's refusal string", () => {
    const result = interpretParcelRecordCell("48021:34137", "someRail", {
      kind: "refused",
      refusal: "ambiguous crosswalk match, ties not broken",
    }, []);
    expect(result).toEqual({
      state: "refused",
      source: "parcel_record",
      placeKey: "48021:34137",
      railKey: "someRail",
      code: "engine-refused",
      reason: "ambiguous crosswalk match, ties not broken",
    });
  });

  it("THE LOAD-BEARING CASE: unaccounted interprets as a refusal, never present or absent — no pipeline word reaches the wire", () => {
    const result = interpretParcelRecordCell("48453:493738", "livingAreaSqft", {
      kind: "unaccounted",
    }, []);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("unaccounted");
    // Falsifier: the reason string must never contain the bare words a
    // downstream consumer might mistake for a served state.
    expect(result.reason).not.toMatch(/^unmeasured$/i);
    expect(result.reason).not.toMatch(/^unresolved$/i);
  });

  it("a cell body with an unrecognized kind refuses with malformed-cell rather than guessing", () => {
    const result = interpretParcelRecordCell("48021:34137", "apn", {
      kind: "pending",
    }, []);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("malformed-cell");
  });

  it("a non-object cell body refuses with malformed-cell", () => {
    const result = interpretParcelRecordCell("48021:34137", "apn", null, []);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("malformed-cell");
  });
});

describe("loadParcelRecordCell — async, fake store", () => {
  it("returns store-not-configured when no queryable is injected and no env var is set", async () => {
    setParcelRecordQueryableForTests(null);
    const result = await loadParcelRecordCell("48021", "34137", "apn");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("store-not-configured");
  });

  it("returns no-such-parcel-or-rail when the cell row is absent entirely (not the same as unaccounted)", async () => {
    setParcelRecordQueryableForTests(memoryParcelRecordStore({ cells: [] }));
    const result = await loadParcelRecordCell("48021", "999999999", "apn");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("no-such-parcel-or-rail");
  });

  it("reads a real present value cell end to end through the fake store", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48021:34137",
            railKey: "apn",
            cellState: { kind: "value", value: "34137", source: "cad_property", vintage: "2025" },
          },
        ],
      }),
    );
    const result = await loadParcelRecordCell("48021", "34137", "apn");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.value).toBe("34137");
  });

  it("companion rows are fetched unconditionally and are empty for a scalar rail (no rail-metadata lookup needed)", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48021:34137",
            railKey: "apn",
            cellState: { kind: "value", value: "34137", source: "cad_property", vintage: "2025" },
          },
        ],
        companionRows: [],
      }),
    );
    const result = await loadParcelRecordCell("48021", "34137", "apn");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.companionRows).toEqual([]);
  });

  it("a store returning a row with no readable cell_state degrades to malformed-cell rather than throwing", async () => {
    const garbageStore = {
      async query() {
        return { rows: [{ unexpected: true }] };
      },
    };
    setParcelRecordQueryableForTests(garbageStore as never);
    const result = await loadParcelRecordCell("48021", "34137", "apn");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("malformed-cell");
  });

  it("memoryParcelRecordStore itself refuses a query shape it does not recognize", async () => {
    const store = memoryParcelRecordStore({ cells: [] });
    await expect(store.query("SELECT * FROM some_other_table", ["a", "b"])).rejects.toThrow();
  });
});
