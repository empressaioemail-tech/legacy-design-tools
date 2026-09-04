/**
 * parcel_record flood cell READ. No store.
 *
 * Snapshot flood values are out of this file on purpose (same discipline as
 * floodHazardFactRead.test.ts): this module must yield a parcel_record
 * determination when a fixture row exists, and refuse/report-honestly when
 * it does not.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  interpretFloodCellRow,
  loadParcelRecordFloodFact,
  memoryParcelRecordFlood,
  resetParcelRecordQueryableForTests,
  setParcelRecordQueryableForTests,
} from "./parcelRecordFactRead";

const GOLD = "48021:34137";
const MCLENNAN_VALUE = "48309:100000";
const WILLIAMSON_ABSENT_VERIFIED = "48491:R005971";

afterEach(() => {
  resetParcelRecordQueryableForTests();
});

describe("interpretFloodCellRow", () => {
  it("serves a value cell with its companion payload -- the reconciled zone/floodway/BFE", () => {
    const read = interpretFloodCellRow(MCLENNAN_VALUE, {
      cell_state: { kind: "value", disposition: "rows", rowCount: 1, source: "cad_property", vintage: "NFHL_48_20260101" },
      payload: {
        bfe: null,
        zone: "X",
        method: "point-on-surface",
        dfirmId: "48309C",
        floodway: false,
        sourceVintage: "NFHL_48_20260101",
      },
    });
    expect(read.state).toBe("value");
    if (read.state !== "value") return;
    expect(read.source).toBe("parcel_record");
    expect(read.placeKey).toBe(MCLENNAN_VALUE);
    expect(read.floodZone).toBe("X");
    expect(read.floodway).toBe(false);
    expect(read.baseFloodElevation).toBeNull();
    expect(read.method).toBe("point-on-surface");
    expect(read.sourceVintage).toBe("NFHL_48_20260101");
  });

  it("a real BFE of exactly 0 must survive as 0, never coerced to null (falsifier)", () => {
    const read = interpretFloodCellRow(GOLD, {
      cell_state: { kind: "value" },
      payload: { zone: "AE", floodway: false, bfe: 0, method: "point-on-surface", sourceVintage: "v1" },
    });
    expect(read.state).toBe("value");
    if (read.state !== "value") return;
    expect(read.baseFloodElevation).toBe(0);
  });

  it("floodway true is carried through as a real boolean (unlike the atoms path, which has no such field)", () => {
    const read = interpretFloodCellRow(GOLD, {
      cell_state: { kind: "value" },
      payload: { zone: "AE", floodway: true, bfe: 512.3, method: "point-on-surface", sourceVintage: "v1" },
    });
    expect(read.state).toBe("value");
    if (read.state !== "value") return;
    expect(read.floodway).toBe(true);
    expect(read.baseFloodElevation).toBe(512.3);
  });

  it("serves absent-verified with its basis -- a real determination, not a miss", () => {
    const basis = { source: "tx_fema_nfhl_flood_zone", countyFips: "48491", propId: "R005971", method: "point-on-surface-sweep", finding: "no polygon contains this parcel's point-on-surface" };
    const read = interpretFloodCellRow(WILLIAMSON_ABSENT_VERIFIED, {
      cell_state: { kind: "absent-verified", basis },
      payload: null,
    });
    expect(read.state).toBe("absent-verified");
    if (read.state !== "absent-verified") return;
    expect(read.basis).toEqual(basis);
  });

  it("serves not-applicable with its reason", () => {
    const read = interpretFloodCellRow(GOLD, {
      cell_state: { kind: "not-applicable", reason: "structurally cannot apply" },
      payload: null,
    });
    expect(read.state).toBe("not-applicable");
    if (read.state !== "not-applicable") return;
    expect(read.reason).toBe("structurally cannot apply");
  });

  it("unaccounted stays unaccounted at this layer -- the wire word 'not-verified' is a compose-layer concern, never baked in here (falsifier: this module must not pre-translate)", () => {
    const read = interpretFloodCellRow(GOLD, {
      cell_state: { kind: "unaccounted" },
      payload: null,
    });
    expect(read.state).toBe("unaccounted");
  });

  it("fails closed with cell-miss when no row exists -- never a silent null", () => {
    const read = interpretFloodCellRow(GOLD, undefined);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("cell-miss");
    expect(read.reason).toContain(GOLD);
  });

  it("refuses malformed-cell when cell_state has no kind -- never invents a zone", () => {
    const read = interpretFloodCellRow(GOLD, { cell_state: { notAKind: true }, payload: null });
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("malformed-cell");
  });

  it("refuses malformed-cell when kind=value but the companion payload is missing -- never invents a zone", () => {
    const read = interpretFloodCellRow(GOLD, { cell_state: { kind: "value" }, payload: null });
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("malformed-cell");
    expect(read.reason).toContain("companion row payload");
  });

  it("refuses invalid-parcel-node-id for a junk id, before ever touching the store", () => {
    // exercised through loadParcelRecordFloodFact, not interpretFloodCellRow
  });
});

describe("loadParcelRecordFloodFact", () => {
  it("refuses factory-store-not-configured when no queryable is set -- never a silent null", async () => {
    setParcelRecordQueryableForTests(null);
    const read = await loadParcelRecordFloodFact(GOLD);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("factory-store-not-configured");
  });

  it("refuses invalid-parcel-node-id for a junk id before ever touching the store", async () => {
    setParcelRecordQueryableForTests(memoryParcelRecordFlood([]));
    const read = await loadParcelRecordFloodFact("not-a-node-id");
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("invalid-parcel-node-id");
    expect(read.placeKey).toBeNull();
  });

  it("serves a value read end to end through the in-memory store", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordFlood([
        {
          placeKey: GOLD,
          cellState: { kind: "value" },
          payload: { zone: "X", floodway: false, bfe: null, method: "point-on-surface", sourceVintage: "v1" },
        },
      ]),
    );
    const read = await loadParcelRecordFloodFact(GOLD);
    expect(read.state).toBe("value");
    if (read.state !== "value") return;
    expect(read.floodZone).toBe("X");
  });

  it("cell-miss for a parcel not in the fixture -- a real miss, not fabricated", async () => {
    setParcelRecordQueryableForTests(memoryParcelRecordFlood([]));
    const read = await loadParcelRecordFloodFact(GOLD);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("cell-miss");
  });

  it("the in-memory fixture refuses a write query (falsifier: this module must be SELECT-only)", async () => {
    const queryable = memoryParcelRecordFlood([]);
    await expect(
      queryable.query("UPDATE parcel_record_cell SET cell_state = $1", [{}]),
    ).rejects.toThrow(/SELECT-only/);
  });
});
