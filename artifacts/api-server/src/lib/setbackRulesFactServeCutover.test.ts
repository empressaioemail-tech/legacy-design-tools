/**
 * The serve-layer integration point for setbackRules (F-01, OPS-21 P-148 /
 * P-132 built the wrapper; OPS-21 P-150 slates it). GOLD is 48491
 * (Williamson), one of the 5 counties P-150 slates (Bastrop, Caldwell,
 * McLennan, Travis, Williamson -- Hays excluded, P-145 not landed). Distinct
 * from setbacksFactServeCutover.ts (the Ft-suffixed siblings' wrapper),
 * which DOES have a legacy fallback; this rail has none.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  memoryParcelGateVerdicts,
  memoryParcelGateVerdictsThatFails,
} from "./parcelGateVerdictRead";
import {
  memoryParcelRecordStore,
  resetParcelRecordQueryableForTests,
  setParcelRecordQueryableForTests,
} from "./parcelRecordCellRead";
import {
  loadSetbackRulesFactForServe,
  resetSetbackRulesVerdictStoreForTests,
  setSetbackRulesVerdictStoreForTests,
} from "./setbackRulesFactServeCutover";

const HAYS_EXCLUDED = "48209:34137"; // real program county, deliberately never slated for this rail (P-145 not landed).
const GOLD = "48491:R302477"; // Williamson IS slated for setbackRules.

afterEach(() => {
  resetSetbackRulesVerdictStoreForTests();
  resetParcelRecordQueryableForTests();
});

describe("loadSetbackRulesFactForServe — never-slated pairs", () => {
  it("Hays resolves to the typed not-cut-over refusal, never a store call", async () => {
    setSetbackRulesVerdictStoreForTests(null);
    const result = await loadSetbackRulesFactForServe(HAYS_EXCLUDED);
    expect(result).toEqual({
      state: "refused",
      code: "not-cut-over",
      source: "setback-rules-fact",
      entityId: HAYS_EXCLUDED,
      reason:
        "setbackRules has no legacy serve path -- it is served only from parcel_record, and only once this (county, rail) pair is slated with a passing gate verdict. Not there yet for this parcel.",
    });
  });

  it("FALSIFIER: even a fabricated PASS verdict has no effect for a non-slated county (Hays, P-145 not landed) — the slate check short-circuits first", async () => {
    setSetbackRulesVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48209", railKey: "setbackRules", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-11T00:00:00Z", runId: "test" },
      ]),
    );
    const result = await loadSetbackRulesFactForServe(HAYS_EXCLUDED);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });

  it("a malformed parcelNodeId resolves to not-cut-over without touching the verdict store", async () => {
    const malformed = "not-a-valid-id";
    const result = await loadSetbackRulesFactForServe(malformed);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
    expect(result.entityId).toBe(malformed);
  });

  it("a store failure still resolves to not-cut-over, not a thrown error", async () => {
    setSetbackRulesVerdictStoreForTests(memoryParcelGateVerdictsThatFails());
    const result = await loadSetbackRulesFactForServe(HAYS_EXCLUDED);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });
});

describe("loadSetbackRulesFactForServe — SLATED pairs (48021/48055/48309/48453/48491, OPS-21 P-150)", () => {
  it("a real PASS verdict on Williamson genuinely reaches the companion-row parcel_record adapter", async () => {
    setSetbackRulesVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48491", railKey: "setbackRules", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-11T14:09:19Z", runId: "test" },
      ]),
    );
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: GOLD,
            railKey: "setbackRules",
            cellState: { kind: "value", source: "@empressaio/setback-corpus@1.1.0:round-rock-tx", vintage: "2026-09-10T22:36:30.509Z", rowCount: 1, disposition: "rows" },
          },
        ],
        companionRows: [
          {
            placeKey: GOLD,
            railKey: "setbackRules",
            rowIndex: 0,
            payload: {
              matchKind: "matched",
              citationUrl: "https://roundrock-tx.elaws.us/code/coor_ptiii_ch2_artii_sec2-26",
              districtCode: "SF2",
              districtName: "SF-2 Single-Family Residential 2 (Conventional)",
              effectiveDate: null,
              jurisdictionKey: "round-rock-tx",
              resolvedTableKey: "round-rock-tx",
              note: "RECONCILED 2026-09-07",
            },
            source: "@empressaio/setback-corpus@1.1.0:round-rock-tx",
            vintage: "2026-09-10T22:36:30.509Z",
          },
        ],
      }),
    );
    const result = await loadSetbackRulesFactForServe(GOLD);
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.districtCode).toBe("SF2");
    expect(result.matchKind).toBe("matched");
  });

  it("no verdict row on Williamson falls back to not-cut-over, not a thrown error or a fabricated present", async () => {
    setSetbackRulesVerdictStoreForTests(memoryParcelGateVerdicts([]));
    const result = await loadSetbackRulesFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });

  it("a REFUSE verdict on Williamson still falls back to not-cut-over -- attempted but refused, not record", async () => {
    setSetbackRulesVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48491", railKey: "setbackRules", verdict: "refuse", unaccountedCount: 9, evaluatedAt: "2026-09-11T00:00:00Z", runId: "test" },
      ]),
    );
    const result = await loadSetbackRulesFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });

  it("a store failure on Williamson fails closed to not-cut-over, not a thrown error", async () => {
    setSetbackRulesVerdictStoreForTests(memoryParcelGateVerdictsThatFails());
    const result = await loadSetbackRulesFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });
});
