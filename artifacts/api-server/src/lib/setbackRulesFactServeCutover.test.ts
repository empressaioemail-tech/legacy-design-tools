/**
 * The serve-layer integration point for setbackRules (F-01, OPS-21 P-148 /
 * P-132). NOT SLATED by this card -- every county resolves to not-cut-over
 * today. Distinct from setbacksFactServeCutover.ts (the Ft-suffixed
 * siblings' wrapper), which DOES have a legacy fallback; this rail has
 * none.
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
  loadSetbackRulesFactForServe,
  resetSetbackRulesVerdictStoreForTests,
  setSetbackRulesVerdictStoreForTests,
} from "./setbackRulesFactServeCutover";

const BASTROP = "48021:34137"; // real program county, slated for setbackFrontFt but never for setbackRules.

afterEach(() => {
  resetSetbackRulesVerdictStoreForTests();
  resetParcelRecordQueryableForTests();
});

describe("loadSetbackRulesFactForServe — no county is slated for this rail yet", () => {
  it("a real program county (even one slated for setbackFrontFt) resolves to the typed not-cut-over refusal, never a store call", async () => {
    setSetbackRulesVerdictStoreForTests(null);
    const result = await loadSetbackRulesFactForServe(BASTROP);
    expect(result).toEqual({
      state: "refused",
      code: "not-cut-over",
      source: "setback-rules-fact",
      entityId: BASTROP,
      reason:
        "setbackRules has no legacy serve path -- it is served only from parcel_record, and only once this (county, rail) pair is slated with a passing gate verdict. Not there yet for this parcel.",
    });
  });

  it("FALSIFIER: even a fabricated PASS verdict has no effect — the slate check short-circuits first", async () => {
    setSetbackRulesVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48021", railKey: "setbackRules", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-11T00:00:00Z", runId: "test" },
      ]),
    );
    const result = await loadSetbackRulesFactForServe(BASTROP);
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
    const result = await loadSetbackRulesFactForServe(BASTROP);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });
});
