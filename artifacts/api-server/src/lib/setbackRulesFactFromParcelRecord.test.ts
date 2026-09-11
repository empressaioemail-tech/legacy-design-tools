/**
 * setbackRulesFactFromParcelRecord.ts — the serve/prod-cutover adapter.
 * UNLIKE its Ft-suffixed siblings, this rail's content lives on a
 * companion row (rowIndex 0), not the cell's own `value` field -- see
 * setbackRulesFactRead.ts's module doc for the live-verified reason.
 * Fixture mirrors the real writer shape in hauska-factory's
 * parcel-setback-cells.mjs (live sample: 48491:R302477, round-rock-tx
 * SF2 district citation).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  memoryParcelRecordStore,
  resetParcelRecordQueryableForTests,
  setParcelRecordQueryableForTests,
} from "./parcelRecordCellRead";
import { setbackRulesFactFromParcelRecord } from "./setbackRulesFactFromParcelRecord";
import { SETBACK_RULES_RAIL_KEY } from "./setbackRulesFactRead";

afterEach(() => {
  resetParcelRecordQueryableForTests();
});

describe("setbackRulesFactFromParcelRecord", () => {
  it("a malformed parcelNodeId refuses invalid-parcel-node-id without touching the store", async () => {
    const result = await setbackRulesFactFromParcelRecord("not-a-valid-id");
    expect(result).toEqual({
      state: "refused",
      code: "invalid-parcel-node-id",
      source: "setback-rules-fact",
      entityId: null,
      reason:
        '"not-a-valid-id" is not a valid parcel node id (county_fips:prop_id). Refusing rather than guessing a place_key.',
    });
  });

  it("no store configured refuses parcel-record-store-not-configured", async () => {
    setParcelRecordQueryableForTests(null);
    const result = await setbackRulesFactFromParcelRecord("48491:R302477");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-store-not-configured");
  });

  it("LIVE-SHAPE: a real Round Rock SF-2 cell reads its rule citation off the companion row, not cell.value (which is null on this rail)", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48491:R302477",
            railKey: SETBACK_RULES_RAIL_KEY,
            cellState: {
              kind: "value",
              source: "@empressaio/setback-corpus@1.1.0:round-rock-tx",
              vintage: "2026-09-10T22:36:30.509Z",
              rowCount: 1,
              disposition: "rows",
            },
          },
        ],
        companionRows: [
          {
            placeKey: "48491:R302477",
            railKey: SETBACK_RULES_RAIL_KEY,
            rowIndex: 0,
            payload: {
              matchKind: "matched",
              citationUrl: "https://roundrock-tx.elaws.us/code/coor_ptiii_ch2_artii_sec2-26",
              districtCode: "SF2",
              districtName: "SF-2 Single-Family Residential 2 (Conventional)",
              effectiveDate: null,
              jurisdictionKey: "round-rock-tx",
              resolvedTableKey: "round-rock-tx",
              note: "RECONCILED 2026-09-07 ...",
            },
            source: "@empressaio/setback-corpus@1.1.0:round-rock-tx",
            vintage: "2026-09-10T22:36:30.509Z",
          },
        ],
      }),
    );
    const result = await setbackRulesFactFromParcelRecord("48491:R302477");
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.districtCode).toBe("SF2");
    expect(result.matchKind).toBe("matched");
    expect(result.citationUrl).toContain("coor_ptiii_ch2_artii_sec2-26");
    expect(result.jurisdictionKey).toBe("round-rock-tx");
  });

  it("a present cell with no rowIndex-0 companion row refuses malformed-cell rather than inventing a citation", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48021:1", railKey: SETBACK_RULES_RAIL_KEY, cellState: { kind: "value", source: "corpus", vintage: "2026-09-10", rowCount: 1, disposition: "rows" } },
        ],
        companionRows: [],
      }),
    );
    const result = await setbackRulesFactFromParcelRecord("48021:1");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-malformed-cell");
  });

  it("not-applicable (unincorporated parcel) carries its reason string honestly", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48055:1", railKey: SETBACK_RULES_RAIL_KEY, cellState: { kind: "not-applicable", reason: "unincorporated parcel — county does not zone land outside city limits" } },
        ],
      }),
    );
    const result = await setbackRulesFactFromParcelRecord("48055:1");
    expect(result.state).toBe("absent");
    if (result.state !== "absent") throw new Error("unreachable");
    expect(result.absence?.kind).toBe("not-applicable");
  });

  it("absent-verified (SETBACK_ROUTER_NOT_A_DISTRICT) carries its basis honestly", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: "48453:1",
            railKey: SETBACK_RULES_RAIL_KEY,
            cellState: { kind: "absent-verified", basis: { method: "setback-table-router.resolveSetbackForParcel", source: "@empressaio/setback-corpus", finding: "SETBACK_ROUTER_NOT_A_DISTRICT", districtCode: "PUD", corpusVersion: "1.1.0", jurisdictionKey: "pflugerville-tx" } },
          },
        ],
      }),
    );
    const result = await setbackRulesFactFromParcelRecord("48453:1");
    expect(result.state).toBe("absent");
    if (result.state !== "absent") throw new Error("unreachable");
    expect(result.absence?.reason).toBe("SETBACK_ROUTER_NOT_A_DISTRICT");
  });

  it("deferred/unaccounted (the zoningDistrict-blocked residual) refuses, never a fabricated absence or present", async () => {
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: "48309:1", railKey: SETBACK_RULES_RAIL_KEY, cellState: { kind: "unaccounted" } },
        ],
      }),
    );
    const result = await setbackRulesFactFromParcelRecord("48309:1");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-unaccounted");
  });

  it("no cell row at all (no-such-parcel-or-rail) maps to parcel-record-cell-miss, distinct from unaccounted", async () => {
    setParcelRecordQueryableForTests(memoryParcelRecordStore({ cells: [] }));
    const result = await setbackRulesFactFromParcelRecord("48021:999999");
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("parcel-record-cell-miss");
  });
});
