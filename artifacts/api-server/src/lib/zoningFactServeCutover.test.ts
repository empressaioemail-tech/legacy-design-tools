/**
 * zoningFactServeCutover.ts — OPS-16 A-096/A-097/A-098. On the falsifier
 * pattern wellFactServeCutover.test.ts established, adapted for this
 * wrapper's own contract: `null` ("caller keeps its own bake-derived zoning
 * section") instead of a live legacy loader call, since zoning has none.
 *
 * Two load-bearing assertions, both proven here:
 *   - UNSLATED pairs (any county not carrying a zoningDistrict slate entry)
 *     always resolve to null, regardless of what the verdict store says.
 *   - SLATED pairs (all six program counties) genuinely reach the record
 *     adapter on a real pass verdict, and genuinely resolve to null on
 *     refuse/no-verdict/store-failure -- fail closed even when slated.
 * Every test injects an explicit verdict store (never relies on the
 * env-resolved default being absent) so this suite is deterministic
 * regardless of what FACTORY_DATABASE_URL_RO happens to be in the running
 * process.
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
import { ZONING_DISTRICT_RAIL_KEY } from "./zoningFactFromParcelRecord";
import {
  loadZoningFactForServe,
  resetZoningVerdictStoreForTests,
  setZoningVerdictStoreForTests,
} from "./zoningFactServeCutover";

const GOLD = "48021:10001"; // 48021 IS slated for zoningDistrict; real unincorporated sample.
const UNSLATED_COUNTY = "48103:100"; // 48103 is NOT a program county at all.

afterEach(() => {
  resetZoningVerdictStoreForTests();
  resetParcelRecordQueryableForTests();
});

describe("loadZoningFactForServe — UNSLATED pairs always resolve to null", () => {
  it("an unslated county resolves to null regardless of verdict store state", async () => {
    setZoningVerdictStoreForTests(null);
    const result = await loadZoningFactForServe(UNSLATED_COUNTY);
    expect(result).toBeNull();
  });

  it("FALSIFIER: even a fabricated verdict store with a PASS row has no effect for an UNSLATED county — the slate check short-circuits first", async () => {
    setZoningVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48103", railKey: ZONING_DISTRICT_RAIL_KEY, verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-04T00:00:00Z", runId: "test" },
      ]),
    );
    const result = await loadZoningFactForServe(UNSLATED_COUNTY);
    expect(result).toBeNull();
  });

  it("a malformed parcelNodeId (no county prefix) resolves to null", async () => {
    setZoningVerdictStoreForTests(null);
    const result = await loadZoningFactForServe("not-a-valid-id");
    expect(result).toBeNull();
  });
});

describe("loadZoningFactForServe — SLATED pairs (gold, 48021) genuinely reach the record adapter", () => {
  it("a real PASS verdict on a slated county serves the record's own not-applicable determination", async () => {
    setZoningVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48021", railKey: ZONING_DISTRICT_RAIL_KEY, verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-04T00:00:00Z", runId: "test" },
      ]),
    );
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: GOLD,
            railKey: ZONING_DISTRICT_RAIL_KEY,
            cellState: { kind: "not-applicable", reason: "unincorporated-no-municipal-zoning" },
          },
        ],
      }),
    );
    const result = await loadZoningFactForServe(GOLD);
    expect(result?.state).toBe("absent");
    if (result?.state !== "absent") throw new Error("unreachable");
    expect(result.absence.kind).toBe("not-applicable");
  });

  it("REFUSE verdict on a slated county resolves to null -- attempted but refused, caller keeps legacy", async () => {
    setZoningVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48021", railKey: ZONING_DISTRICT_RAIL_KEY, verdict: "refuse", unaccountedCount: 12, evaluatedAt: "2026-09-04T00:00:00Z", runId: "test" },
      ]),
    );
    const result = await loadZoningFactForServe(GOLD);
    expect(result).toBeNull();
  });

  it("a store failure on a slated county fails closed to null, not a thrown error", async () => {
    setZoningVerdictStoreForTests(memoryParcelGateVerdictsThatFails());
    const result = await loadZoningFactForServe(GOLD);
    expect(result).toBeNull();
  });

  it("a null verdict store (not configured) on a slated county fails closed to null", async () => {
    setZoningVerdictStoreForTests(null);
    const result = await loadZoningFactForServe(GOLD);
    expect(result).toBeNull();
  });
});
