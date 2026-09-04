/**
 * setbacksFactFromParcelRecord.ts — the OPS-16 A-096/A-097/A-098 cutover
 * adapter. Mirrors zoningFactFromParcelRecord.test.ts's own structure for
 * the sibling four-key setbacks group.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  memoryParcelRecordStore,
  resetParcelRecordQueryableForTests,
  setParcelRecordQueryableForTests,
} from "./parcelRecordCellRead";
import { setbacksFactFromParcelRecord } from "./setbacksFactFromParcelRecord";
import {
  SETBACK_FRONT_FT_RAIL_KEY,
  SETBACK_SIDE_FT_RAIL_KEY,
  SETBACK_REAR_FT_RAIL_KEY,
  SETBACK_CORNER_FT_RAIL_KEY,
} from "./setbacksFactFromParcelRecord";

const UNINCORPORATED_PARCEL = "48021:10001"; // real sample, projection_recon.json

afterEach(() => {
  resetParcelRecordQueryableForTests();
});

describe("setbacksFactFromParcelRecord", () => {
  it("a malformed parcelNodeId refuses invalid-parcel-node-id without touching the store", async () => {
    const result = await setbacksFactFromParcelRecord("not-a-valid-id");
    expect(result).toEqual({
      state: "refused",
      code: "invalid-parcel-node-id",
      source: "setbacks-fact-parcel-record",
      entityId: null,
      reason:
        '"not-a-valid-id" is not a valid parcel node id (county_fips:prop_id). Refusing rather than guessing a place_key.',
    });
  });

  it("no store configured refuses parcel-record-store-not-configured", async () => {
    setParcelRecordQueryableForTests(null);
    const result = await setbacksFactFromParcelRecord("48021:34137");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-store-not-configured");
  });

  it("THE LOAD-BEARING CASE (kind: not-applicable): an unincorporated parcel's setbackFrontFt cell maps to a verified absence, not a fabricated unknown or a fabricated number", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: UNINCORPORATED_PARCEL,
            railKey: SETBACK_FRONT_FT_RAIL_KEY,
            cellState: {
              kind: "not-applicable",
              reason: "unincorporated parcel -- no municipal setback authority applies",
            },
          },
        ],
      }),
    );
    const result = await setbacksFactFromParcelRecord(UNINCORPORATED_PARCEL);
    expect(result.state).toBe("absent");
    if (result.state !== "absent") throw new Error("unreachable");
    expect(result.absence.kind).toBe("not-applicable");
    expect(result.verifiedAbsence).toBeNull();
  });

  it("a present frontFt also reads its sibling side/rear/corner cells", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48021:103387", railKey: SETBACK_FRONT_FT_RAIL_KEY, cellState: { kind: "value", value: 25, source: "bastrop_city_tx", vintage: "2026-09-04" } },
          { placeKey: "48021:103387", railKey: SETBACK_SIDE_FT_RAIL_KEY, cellState: { kind: "value", value: 5, source: "bastrop_city_tx", vintage: "2026-09-04" } },
          { placeKey: "48021:103387", railKey: SETBACK_REAR_FT_RAIL_KEY, cellState: { kind: "value", value: 10, source: "bastrop_city_tx", vintage: "2026-09-04" } },
          { placeKey: "48021:103387", railKey: SETBACK_CORNER_FT_RAIL_KEY, cellState: { kind: "value", value: 15, source: "bastrop_city_tx", vintage: "2026-09-04" } },
        ],
      }),
    );
    const result = await setbacksFactFromParcelRecord("48021:103387");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.frontFt).toBe(25);
    expect(result.sideFt).toBe(5);
    expect(result.rearFt).toBe(10);
    expect(result.cornerFt).toBe(15);
  });

  it("a present frontFt with no sibling cells at all is still present, with side/rear/corner honestly null -- never fabricated", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48453:103281", railKey: SETBACK_FRONT_FT_RAIL_KEY, cellState: { kind: "value", value: 25, source: "austin_tx", vintage: "2026-09-04" } },
        ],
      }),
    );
    const result = await setbacksFactFromParcelRecord("48453:103281");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.frontFt).toBe(25);
    expect(result.sideFt).toBeNull();
    expect(result.rearFt).toBeNull();
    expect(result.cornerFt).toBeNull();
  });

  it("unaccounted (not yet examined) refuses, never a fabricated absence or present", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [{ placeKey: "48021:999", railKey: SETBACK_FRONT_FT_RAIL_KEY, cellState: { kind: "unaccounted" } }],
      }),
    );
    const result = await setbacksFactFromParcelRecord("48021:999");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-unaccounted");
  });

  it("a value cell whose value is not a readable number refuses rather than inventing one", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [{ placeKey: "48021:1", railKey: SETBACK_FRONT_FT_RAIL_KEY, cellState: { kind: "value", value: "not-a-number", source: "x", vintage: "2026-09-04" } }],
      }),
    );
    const result = await setbacksFactFromParcelRecord("48021:1");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-malformed-cell");
  });

  it("no cell row at all (no-such-parcel-or-rail) maps to parcel-record-cell-miss, distinct from unaccounted", async () => {
    setParcelRecordQueryableForTests(memoryParcelRecordStore({ cells: [] }));
    const result = await setbacksFactFromParcelRecord("48021:999999");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-cell-miss");
  });
});
