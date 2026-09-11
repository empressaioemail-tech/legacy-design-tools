/**
 * The serve-layer integration point for maxLotCoveragePct (F-01, OPS-21
 * P-148 built the wrapper; OPS-21 P-150 slates it). GOLD is 48453, one of
 * the 5 counties P-150 slates (Bastrop, Caldwell, McLennan, Travis,
 * Williamson -- Hays excluded, P-145 not landed).
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
  loadMaxLotCoveragePctFactForServe,
  resetMaxLotCoveragePctVerdictStoreForTests,
  setMaxLotCoveragePctVerdictStoreForTests,
} from "./maxLotCoveragePctFactServeCutover";

const HAYS_EXCLUDED = "48209:34137"; // real program county, deliberately never slated for this rail (P-145 not landed).
const GOLD = "48453:141689"; // Travis IS slated for maxLotCoveragePct.

afterEach(() => {
  resetMaxLotCoveragePctVerdictStoreForTests();
  resetParcelRecordQueryableForTests();
});

describe("loadMaxLotCoveragePctFactForServe — never-slated pairs", () => {
  it("Hays resolves to the typed not-cut-over refusal, never a store call", async () => {
    setMaxLotCoveragePctVerdictStoreForTests(null);
    const result = await loadMaxLotCoveragePctFactForServe(HAYS_EXCLUDED);
    expect(result).toEqual({
      state: "refused",
      code: "not-cut-over",
      source: "max-lot-coverage-pct-fact",
      entityId: HAYS_EXCLUDED,
      reason:
        "maxLotCoveragePct has no legacy serve path -- it is served only from parcel_record, and only once this (county, rail) pair is slated with a passing gate verdict. Not there yet for this parcel.",
    });
  });

  it("FALSIFIER: even a fabricated PASS verdict has no effect for a non-slated county (Hays, P-145 not landed) — the slate check short-circuits first", async () => {
    setMaxLotCoveragePctVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48209", railKey: "maxLotCoveragePct", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-11T00:00:00Z", runId: "test" },
      ]),
    );
    const result = await loadMaxLotCoveragePctFactForServe(HAYS_EXCLUDED);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });

  it("a malformed parcelNodeId resolves to not-cut-over without touching the verdict store", async () => {
    const malformed = "not-a-valid-id";
    const result = await loadMaxLotCoveragePctFactForServe(malformed);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
    expect(result.entityId).toBe(malformed);
  });

  it("a store failure still resolves to not-cut-over, not a thrown error", async () => {
    setMaxLotCoveragePctVerdictStoreForTests(memoryParcelGateVerdictsThatFails());
    const result = await loadMaxLotCoveragePctFactForServe(HAYS_EXCLUDED);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });
});

describe("loadMaxLotCoveragePctFactForServe — SLATED pairs (48021/48055/48309/48453/48491, OPS-21 P-150)", () => {
  it("a real PASS verdict on Travis genuinely reaches the parcel_record adapter", async () => {
    setMaxLotCoveragePctVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48453", railKey: "maxLotCoveragePct", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-11T13:54:27Z", runId: "test" },
      ]),
    );
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: GOLD,
            railKey: "maxLotCoveragePct",
            cellState: {
              kind: "value",
              value: 40,
              source: "@empressaio/setback-corpus@1.1.0:austin-tx",
              vintage: "2026-09-11T03:14:06.335Z",
              citationUrl: "https://services.austintexas.gov/edims/document.cfm?id=419477",
              districtCode: "SF-3",
              districtName: "SF-3 Family Residence",
              jurisdictionKey: "austin-tx",
              resolvedTableKey: "austin-tx",
            },
          },
        ],
      }),
    );
    const result = await loadMaxLotCoveragePctFactForServe(GOLD);
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.percent).toBe(40);
  });

  it("no verdict row on Travis falls back to not-cut-over, not a thrown error or a fabricated present", async () => {
    setMaxLotCoveragePctVerdictStoreForTests(memoryParcelGateVerdicts([]));
    const result = await loadMaxLotCoveragePctFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });

  it("a REFUSE verdict on Travis still falls back to not-cut-over -- attempted but refused, not record", async () => {
    setMaxLotCoveragePctVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48453", railKey: "maxLotCoveragePct", verdict: "refuse", unaccountedCount: 9, evaluatedAt: "2026-09-11T00:00:00Z", runId: "test" },
      ]),
    );
    const result = await loadMaxLotCoveragePctFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });

  it("a store failure on Travis fails closed to not-cut-over, not a thrown error", async () => {
    setMaxLotCoveragePctVerdictStoreForTests(memoryParcelGateVerdictsThatFails());
    const result = await loadMaxLotCoveragePctFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });
});
