/**
 * valueHistoryFactFromParcelRecord.ts — the serve/prod-cutover adapter.
 * Fixtures mirror the real writer shape in hauska-factory's
 * parcel-value-history.mjs: historyPayload
 * ({taxYear, marketValue, assessedValue, landValue, improvementValue,
 * viaCrosswalk}), one companion row per distinct tax_year, shared across
 * all six counties by the writer itself. Dollar fields are fixtures as
 * STRINGS, matching the live-confirmed wire shape off cad_property's bigint
 * columns (cadRollFactFromParcelRecord.ts's own module doc).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  memoryParcelRecordStore,
  resetParcelRecordQueryableForTests,
  setParcelRecordQueryableForTests,
} from "./parcelRecordCellRead";
import { valueHistoryFactFromParcelRecord } from "./valueHistoryFactFromParcelRecord";
import { VALUE_HISTORY_RAIL_KEY } from "./valueHistoryFactRead";

afterEach(() => {
  resetParcelRecordQueryableForTests();
});

describe("valueHistoryFactFromParcelRecord", () => {
  it("a malformed parcelNodeId refuses invalid-parcel-node-id without touching the store", async () => {
    const result = await valueHistoryFactFromParcelRecord("not-a-valid-id");
    expect(result).toEqual({
      state: "refused",
      code: "invalid-parcel-node-id",
      source: "value-history-fact",
      entityId: null,
      reason:
        '"not-a-valid-id" is not a valid parcel node id (county_fips:prop_id). Refusing rather than guessing a place_key.',
    });
  });

  it("no store configured refuses parcel-record-store-not-configured", async () => {
    setParcelRecordQueryableForTests(null);
    const result = await valueHistoryFactFromParcelRecord("48021:34137");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-store-not-configured");
  });

  it("LIVE-SHAPE: a non-Williamson county (Bastrop), one direct tax_year, dollar strings coerced to numbers", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48021:34137",
            railKey: VALUE_HISTORY_RAIL_KEY,
            cellState: { kind: "value", disposition: "rows", rowCount: 1, source: "cad_property", vintage: "2025" },
          },
        ],
        companionRows: [
          {
            placeKey: "48021:34137",
            railKey: VALUE_HISTORY_RAIL_KEY,
            rowIndex: 0,
            payload: {
              taxYear: 2025,
              marketValue: "404630",
              assessedValue: "404630",
              landValue: "85000",
              improvementValue: "319630",
              viaCrosswalk: false,
            },
            source: "cad_property",
            vintage: "2025",
          },
        ],
      }),
    );
    const result = await valueHistoryFactFromParcelRecord("48021:34137");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.entries).toEqual([
      {
        taxYear: 2025,
        marketValue: 404630,
        assessedValue: 404630,
        landValue: 85000,
        improvementValue: 319630,
        viaCrosswalk: false,
      },
    ]);
  });

  it("multiple distinct tax years carry every entry, ordered ascending, none dropped", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48491:R664999",
            railKey: VALUE_HISTORY_RAIL_KEY,
            cellState: { kind: "value", disposition: "rows", rowCount: 2, source: "cad_property", vintage: "2026" },
          },
        ],
        companionRows: [
          { placeKey: "48491:R664999", railKey: VALUE_HISTORY_RAIL_KEY, rowIndex: 0, payload: { taxYear: 2025, marketValue: "739956", assessedValue: "739956", landValue: "126000", improvementValue: "613956", viaCrosswalk: false }, source: "cad_property", vintage: "2025" },
          { placeKey: "48491:R664999", railKey: VALUE_HISTORY_RAIL_KEY, rowIndex: 1, payload: { taxYear: 2026, marketValue: "751200", assessedValue: "751200", landValue: "128000", improvementValue: "623200", viaCrosswalk: false }, source: "cad_property", vintage: "2026" },
        ],
      }),
    );
    const result = await valueHistoryFactFromParcelRecord("48491:R664999");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.entries.map((e) => e.taxYear)).toEqual([2025, 2026]);
  });

  it("viaCrosswalk=true (Williamson R1B situs crosswalk) is preserved, not dropped or coerced away", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48491:R125831",
            railKey: VALUE_HISTORY_RAIL_KEY,
            cellState: { kind: "value", disposition: "rows", rowCount: 1, source: "cad_property", vintage: "2026" },
          },
        ],
        companionRows: [
          { placeKey: "48491:R125831", railKey: VALUE_HISTORY_RAIL_KEY, rowIndex: 0, payload: { taxYear: 2026, marketValue: "500000", assessedValue: "500000", landValue: "100000", improvementValue: "400000", viaCrosswalk: true }, source: "cad_property", vintage: "2026" },
        ],
      }),
    );
    const result = await valueHistoryFactFromParcelRecord("48491:R125831");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.entries[0].viaCrosswalk).toBe(true);
  });

  it("a negative dollar string refuses that field to null rather than serving a negative amount", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48021:1",
            railKey: VALUE_HISTORY_RAIL_KEY,
            cellState: { kind: "value", disposition: "rows", rowCount: 1, source: "cad_property", vintage: "2025" },
          },
        ],
        companionRows: [
          { placeKey: "48021:1", railKey: VALUE_HISTORY_RAIL_KEY, rowIndex: 0, payload: { taxYear: 2025, marketValue: "-5", assessedValue: "100", landValue: "50", improvementValue: "50", viaCrosswalk: false }, source: "cad_property", vintage: "2025" },
        ],
      }),
    );
    const result = await valueHistoryFactFromParcelRecord("48021:1");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.entries[0].marketValue).toBeNull();
    expect(result.entries[0].assessedValue).toBe(100);
  });

  it("THE LOAD-BEARING CASE: unaccounted (a parcel not yet examined by the ingest) refuses, never a fabricated absence or present", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48021:493738", railKey: VALUE_HISTORY_RAIL_KEY, cellState: { kind: "unaccounted" } },
        ],
      }),
    );
    const result = await valueHistoryFactFromParcelRecord("48021:493738");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-unaccounted");
  });

  it("a value cell with no readable companion rows refuses rather than inventing a history year", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48021:1",
            railKey: VALUE_HISTORY_RAIL_KEY,
            cellState: { kind: "value", disposition: "rows", rowCount: 1, source: "cad_property", vintage: "2025" },
          },
        ],
        companionRows: [],
      }),
    );
    const result = await valueHistoryFactFromParcelRecord("48021:1");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-malformed-cell");
  });

  it("no cell row at all (no-such-parcel-or-rail) maps to parcel-record-cell-miss, distinct from unaccounted -- this is the writer's own documented behavior for a zero-history parcel, not an error", async () => {
    setParcelRecordQueryableForTests(memoryParcelRecordStore({ cells: [] }));
    const result = await valueHistoryFactFromParcelRecord("48021:999999");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-cell-miss");
  });
});
