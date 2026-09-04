/**
 * The serve-layer integration point for utilityService (F-01, serve/prod
 * cutover for ACQUIRE-GIS wave 1 + PARCEL wave 2).
 *
 * Two load-bearing assertions:
 *   - Any pair NOT resolved to 'record' (unslated, no verdict, refused
 *     verdict, or a failing verdict store) resolves to the typed
 *     `not-cut-over` refusal -- there is no legacy reader to fall back to,
 *     so this IS the fail-closed floor for this rail, unlike
 *     wells/specialDistricts where the floor is a real atom read.
 *   - A slated pair with a real PASS verdict genuinely reaches the
 *     parcel_record adapter.
 * Every test injects an explicit verdict store, mirroring
 * specialDistrictFactServeCutover.test.ts.
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
  loadUtilityServiceFactForServe,
  resetUtilityServiceVerdictStoreForTests,
  setUtilityServiceVerdictStoreForTests,
} from "./utilityServiceFactServeCutover";

const UNSLATED = "48103:301328"; // Not a program county at all -- never slated for anything.

afterEach(() => {
  resetUtilityServiceVerdictStoreForTests();
  resetParcelRecordQueryableForTests();
});

describe("loadUtilityServiceFactForServe — no (county, rail) pair is slated yet", () => {
  it("an unslated pair resolves to the typed not-cut-over refusal, never a store call", async () => {
    setUtilityServiceVerdictStoreForTests(null);
    const result = await loadUtilityServiceFactForServe(UNSLATED);
    expect(result).toEqual({
      state: "refused",
      code: "not-cut-over",
      source: "utility-service-fact",
      entityId: UNSLATED,
      reason:
        "utilityService has no legacy serve path -- it is served only from parcel_record, and only once this (county, rail) pair is slated with a passing gate verdict. Not there yet for this parcel.",
    });
  });

  it("FALSIFIER: even a fabricated PASS verdict has no effect for an unslated county — the slate check short-circuits first", async () => {
    setUtilityServiceVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48103", railKey: "utilityService", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-04T00:00:00Z", runId: "test" },
      ]),
    );
    const result = await loadUtilityServiceFactForServe(UNSLATED);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });

  it("a malformed parcelNodeId resolves to not-cut-over without touching the verdict store", async () => {
    const malformed = "not-a-valid-id";
    const result = await loadUtilityServiceFactForServe(malformed);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
    expect(result.entityId).toBe(malformed);
  });
});

describe("loadUtilityServiceFactForServe — SLATED pairs (all 6 counties are slated; no gate verdict exists for this rail yet)", () => {
  const GOLD = "48021:34137"; // 48021 IS slated for utilityService.

  it("a real PASS verdict on a slated county genuinely reaches the parcel_record adapter, not the not-cut-over refusal", async () => {
    setUtilityServiceVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48021", railKey: "utilityService", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-04T00:00:00Z", runId: "test" },
      ]),
    );
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: GOLD, railKey: "utilityService", cellState: { kind: "value", disposition: "rows", rowCount: 1, source: "tx_puct_ccn", vintage: "2026-09-04T00:00:00.000Z" } },
        ],
        companionRows: [
          { placeKey: GOLD, railKey: "utilityService", rowIndex: 1, payload: { utilityType: "sewer", ccnNo: "20811", utility: "BASTROP COUNTY WCID", status: "REGULATED", ccnType: "MUNICIPAL" }, source: "tx_puct_ccn", vintage: "2026-09-04T00:00:00.000Z" },
        ],
      }),
    );
    const result = await loadUtilityServiceFactForServe(GOLD);
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.sewer?.ccnNo).toBe("20811");
    expect(result.water).toBeNull();
  });

  it("no verdict row on a slated county (the real, current live state — no gate evaluation for this rail exists yet) falls back to not-cut-over, not a thrown error or a fabricated present", async () => {
    setUtilityServiceVerdictStoreForTests(memoryParcelGateVerdicts([]));
    const result = await loadUtilityServiceFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });

  it("a REFUSE verdict on a slated county still falls back to not-cut-over -- attempted but refused, not record", async () => {
    setUtilityServiceVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48021", railKey: "utilityService", verdict: "refuse", unaccountedCount: 9, evaluatedAt: "2026-09-04T00:00:00Z", runId: "test" },
      ]),
    );
    const result = await loadUtilityServiceFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });

  it("a store failure on a slated county fails closed to not-cut-over, not a thrown error", async () => {
    setUtilityServiceVerdictStoreForTests(memoryParcelGateVerdictsThatFails());
    const result = await loadUtilityServiceFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });

  it("a null verdict store (not configured) on a slated county fails closed to not-cut-over", async () => {
    setUtilityServiceVerdictStoreForTests(null);
    const result = await loadUtilityServiceFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });
});
