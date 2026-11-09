/**
 * Re-walk 2026-11-09: 1102 Pecan St, Bastrop (48021:33977) and its MU neighbours refused with "parcel_record_cell
 * 48021:33977/setbackSideFt is not a readable number". The city's per-parcel GIS record (layer 23) says the MU side
 * setback is "None - Reference Building Code/Fire Code" (repealed B3 code wording); the factory refuses that cell and
 * quotes it. The envelope now says so, in the city's words, with the 2026 Bastrop Development Code rule.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  memoryParcelRecordStore,
  resetParcelRecordQueryableForTests,
  setParcelRecordQueryableForTests,
} from "../parcelRecordCellRead";
import {
  SETBACK_FRONT_FT_RAIL_KEY,
  SETBACK_REAR_FT_RAIL_KEY,
  SETBACK_SIDE_FT_RAIL_KEY,
  setbacksFactFromParcelRecord,
} from "../setbacksFactFromParcelRecord";
import { BASTROP_2026_SIDE_RULE, cityStatedText, setbackRefusalWords } from "./setbackRefusalWords";

// The factory's refusal for 33977's side cell (hauska-factory bastrop-layer23-cells.mjs, case "nonnumeric").
const FACTORY_SIDE_REASON =
  'the city\'s per-parcel GIS record for this MU parcel in Bastrop states the side setback as "None - Reference Building Code/Fire Code" (numeric column 0), ' +
  "which names no number of feet, so no side setback is served; verify the setback with the City of Bastrop";

afterEach(() => {
  resetParcelRecordQueryableForTests();
});

describe("setback refusals in the city's words", () => {
  it("the setbacks fact keeps the side cell's own refusal (33977's shape: front and rear 15 ft, side refused)", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48021:33977", railKey: SETBACK_FRONT_FT_RAIL_KEY, cellState: { kind: "value", value: 15 } },
          { placeKey: "48021:33977", railKey: SETBACK_REAR_FT_RAIL_KEY, cellState: { kind: "value", value: 15 } },
          { placeKey: "48021:33977", railKey: SETBACK_SIDE_FT_RAIL_KEY, cellState: { kind: "refused", reason: FACTORY_SIDE_REASON } },
        ],
      }),
    );
    const fact = await setbacksFactFromParcelRecord("48021:33977");
    expect(fact.state).toBe("present");
    if (fact.state !== "present") throw new Error("unreachable");
    expect(fact.frontFt).toBe(15);
    expect(fact.rearFt).toBe(15);
    expect(fact.sideFt).toBeNull();
    expect(fact.refusals).toEqual({ side: FACTORY_SIDE_REASON });
  });

  it("a fact with every dimension served carries no refusals key", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48021:33985", railKey: SETBACK_FRONT_FT_RAIL_KEY, cellState: { kind: "value", value: 20 } },
          { placeKey: "48021:33985", railKey: SETBACK_SIDE_FT_RAIL_KEY, cellState: { kind: "value", value: 5 } },
          { placeKey: "48021:33985", railKey: SETBACK_REAR_FT_RAIL_KEY, cellState: { kind: "value", value: 20 } },
        ],
      }),
    );
    const fact = await setbacksFactFromParcelRecord("48021:33985");
    if (fact.state !== "present") throw new Error("expected present");
    expect(fact.sideFt).toBe(5);
    expect("refusals" in fact).toBe(false);
  });

  it("Bastrop MU: the city's own words, the repealed code, and the 2026 rule; never a number served", () => {
    const words = setbackRefusalWords({ dimension: "side", entityId: "48021:33977", district: "MU", refusal: FACTORY_SIDE_REASON });
    expect(words).toBe(
      'Bastrop\'s parcel GIS record gives no side setback for this MU lot ("None - Reference Building Code/Fire Code", ' +
        "from the repealed Bastrop Building Block (B3) code). " +
        BASTROP_2026_SIDE_RULE.MU,
    );
    expect(words).toContain("5 ft minimum");
    expect(words).toContain("10 ft where the lot abuts an RR or SF district");
    expect(words).not.toMatch(/parcel_record_cell|setbackSideFt|not a readable number/);
  });

  it("a Bastrop district with no transcribed 2026 rule gets the city's words only", () => {
    const words = setbackRefusalWords({ dimension: "rear", entityId: "48021:1", district: "GC", refusal: FACTORY_SIDE_REASON.replace(/side/g, "rear") });
    expect(words).toBe('Bastrop\'s parcel GIS record gives no rear setback for this GC lot ("None - Reference Building Code/Fire Code", from the repealed Bastrop Building Block (B3) code).');
  });

  it("elsewhere, the cell's own reason; with no reason, a plain sentence (never a raw rail id)", () => {
    expect(setbackRefusalWords({ dimension: "side", entityId: "48055:9", district: "R-1", refusal: "the county record lists no side yard" })).toBe(
      "The parcel record gives no side setback for this lot: The county record lists no side yard.",
    );
    const none = setbackRefusalWords({ dimension: "side", entityId: "48055:9", district: "R-1", refusal: null });
    expect(none).toBe("The parcel record gives no readable side setback for this lot, so none is drawn rather than inventing one.");
    expect(none).not.toMatch(/parcel_record_cell|setbackSideFt/);
  });

  it("reads the city's text out of the factory's reason", () => {
    expect(cityStatedText(FACTORY_SIDE_REASON)).toBe("None - Reference Building Code/Fire Code");
    expect(cityStatedText("the city's record states the corner side setback as \"15 ft\"")).toBe("15 ft");
    expect(cityStatedText(null)).toBeNull();
  });
});
