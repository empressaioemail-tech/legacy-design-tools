/**
 * The serve-layer integration point for maxHeightFt (F-01, OPS-21 P-148 /
 * P-133). NOT SLATED by this card (fails the gate on every in-scope
 * county, blocked on the 3,376-parcel zoningDistrict residual Z1/P-147
 * owns) -- every county, including real program counties, resolves to
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
  loadMaxHeightFtFactForServe,
  resetMaxHeightFtVerdictStoreForTests,
  setMaxHeightFtVerdictStoreForTests,
} from "./maxHeightFtFactServeCutover";

const BASTROP = "48021:34137"; // real program county, never slated for this rail.

afterEach(() => {
  resetMaxHeightFtVerdictStoreForTests();
  resetParcelRecordQueryableForTests();
});

describe("loadMaxHeightFtFactForServe — no county is slated for this rail yet", () => {
  it("a real program county resolves to the typed not-cut-over refusal, never a store call", async () => {
    setMaxHeightFtVerdictStoreForTests(null);
    const result = await loadMaxHeightFtFactForServe(BASTROP);
    expect(result).toEqual({
      state: "refused",
      code: "not-cut-over",
      source: "max-height-ft-fact",
      entityId: BASTROP,
      reason:
        "maxHeightFt has no legacy serve path -- it is served only from parcel_record, and only once this (county, rail) pair is slated with a passing gate verdict. Not there yet for this parcel.",
    });
  });

  it("FALSIFIER: even a fabricated PASS verdict has no effect — the slate check short-circuits first", async () => {
    setMaxHeightFtVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48021", railKey: "maxHeightFt", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-11T00:00:00Z", runId: "test" },
      ]),
    );
    const result = await loadMaxHeightFtFactForServe(BASTROP);
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
    const result = await loadMaxHeightFtFactForServe(BASTROP);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });
});
