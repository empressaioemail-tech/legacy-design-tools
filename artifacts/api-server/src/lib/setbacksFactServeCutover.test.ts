/**
 * setbacksFactServeCutover.ts — OPS-16 A-096/A-097/A-098. Mirrors
 * zoningFactServeCutover.test.ts's own structure exactly for the sibling
 * setbacks group.
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
import { SETBACK_FRONT_FT_RAIL_KEY } from "./setbacksFactFromParcelRecord";
import {
  loadSetbacksFactForServe,
  resetSetbacksVerdictStoreForTests,
  setSetbacksVerdictStoreForTests,
} from "./setbacksFactServeCutover";

const GOLD = "48021:10001"; // 48021 IS slated for setbackFrontFt; real unincorporated sample.
const UNSLATED_COUNTY = "48103:100"; // 48103 is NOT a program county at all.

afterEach(() => {
  resetSetbacksVerdictStoreForTests();
  resetParcelRecordQueryableForTests();
});

describe("loadSetbacksFactForServe — UNSLATED pairs always resolve to null", () => {
  it("an unslated county resolves to null regardless of verdict store state", async () => {
    setSetbacksVerdictStoreForTests(null);
    const result = await loadSetbacksFactForServe(UNSLATED_COUNTY);
    expect(result).toBeNull();
  });

  it("FALSIFIER: even a fabricated verdict store with a PASS row has no effect for an UNSLATED county — the slate check short-circuits first", async () => {
    setSetbacksVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48103", railKey: SETBACK_FRONT_FT_RAIL_KEY, verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-04T00:00:00Z", runId: "test" },
      ]),
    );
    const result = await loadSetbacksFactForServe(UNSLATED_COUNTY);
    expect(result).toBeNull();
  });

  it("a malformed parcelNodeId (no county prefix) resolves to null", async () => {
    setSetbacksVerdictStoreForTests(null);
    const result = await loadSetbacksFactForServe("not-a-valid-id");
    expect(result).toBeNull();
  });
});

describe("loadSetbacksFactForServe — SLATED pairs (gold, 48021) genuinely reach the record adapter", () => {
  it("a real PASS verdict on a slated county serves the record's own not-applicable determination", async () => {
    setSetbacksVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48021", railKey: SETBACK_FRONT_FT_RAIL_KEY, verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-04T00:00:00Z", runId: "test" },
      ]),
    );
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: GOLD,
            railKey: SETBACK_FRONT_FT_RAIL_KEY,
            cellState: { kind: "not-applicable", reason: "unincorporated-no-municipal-setback-authority" },
          },
        ],
      }),
    );
    const result = await loadSetbacksFactForServe(GOLD);
    expect(result?.state).toBe("absent");
    if (result?.state !== "absent") throw new Error("unreachable");
    expect(result.absence.kind).toBe("not-applicable");
  });

  it("REFUSE verdict on a slated county resolves to null -- attempted but refused, caller keeps legacy", async () => {
    setSetbacksVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48021", railKey: SETBACK_FRONT_FT_RAIL_KEY, verdict: "refuse", unaccountedCount: 12, evaluatedAt: "2026-09-04T00:00:00Z", runId: "test" },
      ]),
    );
    const result = await loadSetbacksFactForServe(GOLD);
    expect(result).toBeNull();
  });

  it("a store failure on a slated county fails closed to null, not a thrown error", async () => {
    setSetbacksVerdictStoreForTests(memoryParcelGateVerdictsThatFails());
    const result = await loadSetbacksFactForServe(GOLD);
    expect(result).toBeNull();
  });

  it("a null verdict store (not configured) on a slated county fails closed to null", async () => {
    setSetbacksVerdictStoreForTests(null);
    const result = await loadSetbacksFactForServe(GOLD);
    expect(result).toBeNull();
  });
});
