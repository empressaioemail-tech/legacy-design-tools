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
    // P-270: this fixture's own `effectiveDate: null` is Round Rock's real
    // shape, so the pre-existing wire is unchanged and the declaration is
    // added beside it. Asserted here too, on the fixture as it always was.
    expect(result.effectiveDate).toBeNull();
    expect(result.citationVintage?.state).toBe("unreadable-absent-at-source");
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

/**
 * P-270 (OPS-24 scope X11) — this rail's citation is served WITH its vintage,
 * or with a declaration saying the vintage could not be read.
 *
 * WHAT THE DEFECT WAS HERE, in this file's own terms: the adapter read a
 * companion row's `effectiveDate` and collapsed a missing-or-unreadable value
 * into a bare `null` with no state beside it, so `effectiveDate: null` on this
 * wire meant three different situations and a customer (or the XD-11 probe)
 * could not tell them apart — 29 of the 31 cited subjects in the probe's run
 * were in exactly this state.
 *
 * The live fixture above carries `effectiveDate: null`, which is Round Rock's
 * real shape, so the first test below is asserted against the SAME fixture the
 * pre-existing live-shape test uses: the wire is unchanged and the declaration
 * is added.
 *
 * FALSIFIERS: `absent-at-source` and `unparseable` asserted apart off identical
 * rows differing only in the date field; the agreeing control (a readable date)
 * declares nothing; the date is never defaulted; and a row with no citation
 * declares nothing, because there is no instrument to qualify.
 */
describe("setbackRulesFactFromParcelRecord — citation vintage (P-270, OPS-24 X11)", () => {
  const VINTAGE_NOTE =
    "Setback rule vintage unknown — the rule is served undated, not as current. Verify with the city.";

  function storeWithRow(payload: Record<string, unknown>) {
    return memoryParcelRecordStore({
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
          payload: { matchKind: "matched", districtCode: "SF2", ...payload },
          source: "@empressaio/setback-corpus@1.1.0:round-rock-tx",
          vintage: "2026-09-10T22:36:30.509Z",
        },
      ],
    });
  }

  async function readWithRow(payload: Record<string, unknown>) {
    setParcelRecordQueryableForTests(storeWithRow(payload));
    const result = await setbackRulesFactFromParcelRecord("48491:R302477");
    if (result.state !== "present") throw new Error(`expected present, got ${result.state}`);
    return result;
  }

  const CITATION = "https://roundrock-tx.elaws.us/code/coor_ptiii_ch2_artii_sec2-26";

  it("THE DEFECT ITSELF: the live Round Rock shape (`effectiveDate: null`) declares `absent-at-source` on the wire", async () => {
    const result = await readWithRow({ citationUrl: CITATION, effectiveDate: null });

    expect(result.effectiveDate).toBeNull();
    expect(result.citationVintage).toBeDefined();
    expect(result.citationVintage!.state).toBe("unreadable-absent-at-source");
    expect(result.citationVintage!.note).toBe(VINTAGE_NOTE);
    expect(result.citationVintage!.citationUrl).toBe(CITATION);
    expect(result.citationVintage!.sourceLabel).toContain("parcel_record");
    // This rail is a LOOK — the read happens here, so the shrug state is gone.
    expect(result.citationVintage!.state).not.toBe("unreadable-never-looked");
  });

  it("KEEPS THE CAUSES APART: a row whose date key is MISSING versus one whose date key holds junk", async () => {
    const missing = await readWithRow({ citationUrl: CITATION });
    const junk = await readWithRow({ citationUrl: CITATION, effectiveDate: "Ord. 2026-06" });

    expect(missing.citationVintage!.state).toBe("unreadable-absent-at-source");
    expect(junk.citationVintage!.state).toBe("unreadable-unparseable");
    expect(missing.citationVintage!.state).not.toBe(junk.citationVintage!.state);
    // Both are `effectiveDate: null` on the wire — which is exactly why the
    // state beside it is the only place the distinction can live.
    expect(missing.effectiveDate).toBeNull();
    expect(junk.effectiveDate).toBeNull();
  });

  it("THE AGREEING CONTROL: a readable date is served as the date and declares nothing", async () => {
    const result = await readWithRow({ citationUrl: CITATION, effectiveDate: "2026-04-14" });

    expect(result.effectiveDate).toBe("2026-04-14");
    expect(result.citationVintage).toBeNull();
  });

  it("reads the snake_case spelling the parcel_record writer uses", async () => {
    const result = await readWithRow({ citationUrl: CITATION, effective_date: "2026-04-14" });
    expect(result.effectiveDate).toBe("2026-04-14");
    expect(result.citationVintage).toBeNull();
  });

  it("NEVER DEFAULTS THE DATE: an unreadable row yields null, never a placeholder", async () => {
    const result = await readWithRow({ citationUrl: CITATION, effectiveDate: "sometime in 2026" });
    expect(result.effectiveDate).toBeNull();
    expect(result.sourceVintage).toBe("2026-09-10T22:36:30.509Z");
    // The cell's write vintage is NOT the rule's effective date: it says when
    // the row was written, not when the law took effect. Reusing it here would
    // be exactly the assumed-from-source-kind date the ruling forbids.
    expect(result.effectiveDate).not.toBe(result.sourceVintage);
    expect(JSON.stringify(result)).not.toContain("1970-01-01");
    // ...and the row still declares, so a null date is never served bare.
    expect(result.citationVintage!.state).toBe("unreadable-unparseable");
  });

  it("INHERITS THE CORPUS'S SHAPE-ONLY NOTION OF A DATE, deliberately, rather than being stricter than the resolver", async () => {
    // `parseStrictIsoDate` (reached through `dateFromTableEffectiveDate`) is
    // shape-only, so `2026-13-99` IS a date to the module that ORDERS
    // candidates by date. Being stricter here would fire the vintage row on a
    // value the resolver was happy to compare, i.e. the surface would call
    // "undated" a rule the resolver had just ranked by its date. So this rail
    // accepts the same values the resolver does, and the nonsense is the
    // resolver's business, not a second opinion here.
    const result = await readWithRow({ citationUrl: CITATION, effectiveDate: "2026-13-99" });
    expect(result.effectiveDate).toBe("2026-13-99");
    expect(result.citationVintage).toBeNull();
  });

  it("a row serving NO citation declares nothing: there is no instrument to qualify", async () => {
    const result = await readWithRow({ effectiveDate: null });
    expect(result.citationUrl).toBeNull();
    expect(result.citationVintage).toBeNull();
  });
});
