/**
 * The serve-layer integration point for maxHeightFt (F-01, OPS-21 P-148
 * built the wrapper; OPS-21 P-150 slates it). GOLD is 48021, one of the 5
 * counties P-150 slates (Bastrop, Caldwell, McLennan, Travis, Williamson --
 * Hays excluded, P-145 not landed).
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
  loadMaxHeightFtFactForServe,
  resetMaxHeightFtVerdictStoreForTests,
  setMaxHeightFtVerdictStoreForTests,
} from "./maxHeightFtFactServeCutover";

const HAYS_EXCLUDED = "48209:34137"; // real program county, deliberately never slated for this rail (P-145 not landed).
const GOLD = "48021:34137"; // Bastrop IS slated for maxHeightFt.

afterEach(() => {
  resetMaxHeightFtVerdictStoreForTests();
  resetParcelRecordQueryableForTests();
});

describe("loadMaxHeightFtFactForServe — never-slated pairs", () => {
  it("Hays resolves to the typed not-cut-over refusal, never a store call", async () => {
    setMaxHeightFtVerdictStoreForTests(null);
    const result = await loadMaxHeightFtFactForServe(HAYS_EXCLUDED);
    expect(result).toEqual({
      state: "refused",
      code: "not-cut-over",
      source: "max-height-ft-fact",
      entityId: HAYS_EXCLUDED,
      reason:
        "maxHeightFt has no legacy serve path -- it is served only from parcel_record, and only once this (county, rail) pair is slated with a passing gate verdict. Not there yet for this parcel.",
    });
  });

  it("FALSIFIER: even a fabricated PASS verdict has no effect for a non-slated county (Hays, P-145 not landed) — the slate check short-circuits first", async () => {
    setMaxHeightFtVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48209", railKey: "maxHeightFt", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-11T00:00:00Z", runId: "test" },
      ]),
    );
    const result = await loadMaxHeightFtFactForServe(HAYS_EXCLUDED);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });

  it("a malformed parcelNodeId resolves to not-cut-over without touching the verdict store", async () => {
    const malformed = "not-a-valid-id";
    const result = await loadMaxHeightFtFactForServe(malformed);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
    expect(result.entityId).toBe(malformed);
  });

  it("a store failure still resolves to not-cut-over, not a thrown error", async () => {
    setMaxHeightFtVerdictStoreForTests(memoryParcelGateVerdictsThatFails());
    const result = await loadMaxHeightFtFactForServe(HAYS_EXCLUDED);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });
});

describe("loadMaxHeightFtFactForServe — SLATED pairs (48021/48055/48309/48453/48491, OPS-21 P-150)", () => {
  it("a real PASS verdict on Bastrop genuinely reaches the parcel_record adapter", async () => {
    setMaxHeightFtVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48021", railKey: "maxHeightFt", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-11T14:03:45Z", runId: "test" },
      ]),
    );
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: GOLD,
            railKey: "maxHeightFt",
            cellState: {
              kind: "value",
              value: 35,
              source: "@empressaio/setback-corpus@1.1.0:bastrop-development-code",
              vintage: "2026-09-11T01:11:32.598Z",
              citationUrl: "https://www.cityofbastrop.org/page/open/18744/0/ORDINANCE.pdf",
              districtCode: "SF-1",
              districtName: "SF-1 Single-Family Residential",
              jurisdictionKey: "bastrop-development-code",
              resolvedTableKey: "bastrop-development-code",
            },
          },
        ],
      }),
    );
    const result = await loadMaxHeightFtFactForServe(GOLD);
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.feet).toBe(35);
  });

  it("no verdict row on Bastrop falls back to not-cut-over, not a thrown error or a fabricated present", async () => {
    setMaxHeightFtVerdictStoreForTests(memoryParcelGateVerdicts([]));
    const result = await loadMaxHeightFtFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });

  it("a REFUSE verdict on Bastrop still falls back to not-cut-over -- attempted but refused, not record", async () => {
    setMaxHeightFtVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48021", railKey: "maxHeightFt", verdict: "refuse", unaccountedCount: 9, evaluatedAt: "2026-09-11T00:00:00Z", runId: "test" },
      ]),
    );
    const result = await loadMaxHeightFtFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });

  it("a store failure on Bastrop fails closed to not-cut-over, not a thrown error", async () => {
    setMaxHeightFtVerdictStoreForTests(memoryParcelGateVerdictsThatFails());
    const result = await loadMaxHeightFtFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });
});
