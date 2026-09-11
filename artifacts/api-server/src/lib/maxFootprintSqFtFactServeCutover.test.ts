/**
 * The serve-layer integration point for maxFootprintSqFt (F-01, OPS-21
 * P-148 built the wrapper; OPS-21 P-150 slates it). GOLD is 48491, one of
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
  loadMaxFootprintSqFtFactForServe,
  resetMaxFootprintSqFtVerdictStoreForTests,
  setMaxFootprintSqFtVerdictStoreForTests,
} from "./maxFootprintSqFtFactServeCutover";

const HAYS_EXCLUDED = "48209:34137"; // real program county, deliberately never slated for this rail (P-145 not landed).
const GOLD = "48491:R391328"; // Williamson IS slated for maxFootprintSqFt.

afterEach(() => {
  resetMaxFootprintSqFtVerdictStoreForTests();
  resetParcelRecordQueryableForTests();
});

describe("loadMaxFootprintSqFtFactForServe — never-slated pairs", () => {
  it("Hays resolves to the typed not-cut-over refusal, never a store call", async () => {
    setMaxFootprintSqFtVerdictStoreForTests(null);
    const result = await loadMaxFootprintSqFtFactForServe(HAYS_EXCLUDED);
    expect(result).toEqual({
      state: "refused",
      code: "not-cut-over",
      source: "max-footprint-sqft-fact",
      entityId: HAYS_EXCLUDED,
      reason:
        "maxFootprintSqFt has no legacy serve path -- it is served only from parcel_record, and only once this (county, rail) pair is slated with a passing gate verdict. Not there yet for this parcel.",
    });
  });

  it("FALSIFIER: even a fabricated PASS verdict has no effect for a non-slated county (Hays, P-145 not landed) — the slate check short-circuits first", async () => {
    setMaxFootprintSqFtVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48209", railKey: "maxFootprintSqFt", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-11T00:00:00Z", runId: "test" },
      ]),
    );
    const result = await loadMaxFootprintSqFtFactForServe(HAYS_EXCLUDED);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });

  it("a malformed parcelNodeId resolves to not-cut-over without touching the verdict store", async () => {
    const malformed = "not-a-valid-id";
    const result = await loadMaxFootprintSqFtFactForServe(malformed);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
    expect(result.entityId).toBe(malformed);
  });

  it("a store failure still resolves to not-cut-over, not a thrown error", async () => {
    setMaxFootprintSqFtVerdictStoreForTests(memoryParcelGateVerdictsThatFails());
    const result = await loadMaxFootprintSqFtFactForServe(HAYS_EXCLUDED);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });
});

describe("loadMaxFootprintSqFtFactForServe — SLATED pairs (48021/48055/48309/48453/48491, OPS-21 P-150)", () => {
  it("a real PASS verdict on Williamson genuinely reaches the parcel_record adapter", async () => {
    setMaxFootprintSqFtVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48491", railKey: "maxFootprintSqFt", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-11T14:10:25Z", runId: "test" },
      ]),
    );
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: GOLD,
            railKey: "maxFootprintSqFt",
            cellState: {
              kind: "value",
              value: 2658.8,
              inputs: { parcelAreaSqFt: 5317.61, maxLotCoveragePct: 50 },
              method: "parcelAreaSqFt x maxLotCoveragePct / 100",
              source: "@empressaio/setback-corpus@1.1.0:round-rock-tx",
              vintage: "2026-09-11T01:14:13.820Z",
            },
          },
        ],
      }),
    );
    const result = await loadMaxFootprintSqFtFactForServe(GOLD);
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.sqFt).toBe(2658.8);
  });

  it("no verdict row on Williamson falls back to not-cut-over, not a thrown error or a fabricated present", async () => {
    setMaxFootprintSqFtVerdictStoreForTests(memoryParcelGateVerdicts([]));
    const result = await loadMaxFootprintSqFtFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });

  it("a REFUSE verdict on Williamson still falls back to not-cut-over -- attempted but refused, not record", async () => {
    setMaxFootprintSqFtVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48491", railKey: "maxFootprintSqFt", verdict: "refuse", unaccountedCount: 9, evaluatedAt: "2026-09-11T00:00:00Z", runId: "test" },
      ]),
    );
    const result = await loadMaxFootprintSqFtFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });

  it("a store failure on Williamson fails closed to not-cut-over, not a thrown error", async () => {
    setMaxFootprintSqFtVerdictStoreForTests(memoryParcelGateVerdictsThatFails());
    const result = await loadMaxFootprintSqFtFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });
});
