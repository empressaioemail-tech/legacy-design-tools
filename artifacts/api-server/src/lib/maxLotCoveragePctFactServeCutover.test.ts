/**
 * The serve-layer integration point for maxLotCoveragePct (F-01, OPS-21
 * P-148 / P-133). NOT SLATED by this card -- every county resolves to
 * not-cut-over today.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  memoryParcelGateVerdicts,
  memoryParcelGateVerdictsThatFails,
} from "./parcelGateVerdictRead";
import {
  resetParcelRecordQueryableForTests,
} from "./parcelRecordCellRead";
import {
  loadMaxLotCoveragePctFactForServe,
  resetMaxLotCoveragePctVerdictStoreForTests,
  setMaxLotCoveragePctVerdictStoreForTests,
} from "./maxLotCoveragePctFactServeCutover";

const TRAVIS = "48453:141689"; // real program county, never slated for this rail.

afterEach(() => {
  resetMaxLotCoveragePctVerdictStoreForTests();
  resetParcelRecordQueryableForTests();
});

describe("loadMaxLotCoveragePctFactForServe — no county is slated for this rail yet", () => {
  it("a real program county resolves to the typed not-cut-over refusal, never a store call", async () => {
    setMaxLotCoveragePctVerdictStoreForTests(null);
    const result = await loadMaxLotCoveragePctFactForServe(TRAVIS);
    expect(result).toEqual({
      state: "refused",
      code: "not-cut-over",
      source: "max-lot-coverage-pct-fact",
      entityId: TRAVIS,
      reason:
        "maxLotCoveragePct has no legacy serve path -- it is served only from parcel_record, and only once this (county, rail) pair is slated with a passing gate verdict. Not there yet for this parcel.",
    });
  });

  it("FALSIFIER: even a fabricated PASS verdict has no effect — the slate check short-circuits first", async () => {
    setMaxLotCoveragePctVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48453", railKey: "maxLotCoveragePct", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-11T00:00:00Z", runId: "test" },
      ]),
    );
    const result = await loadMaxLotCoveragePctFactForServe(TRAVIS);
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
    const result = await loadMaxLotCoveragePctFactForServe(TRAVIS);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });
});
