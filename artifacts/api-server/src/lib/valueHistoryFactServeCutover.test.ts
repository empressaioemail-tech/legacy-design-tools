/**
 * The serve-layer integration point for valueHistory (F-01, PARCEL-B-SLATE1
 * template, serve/prod cutover). All six program counties are slated
 * (parcel-value-history.mjs ingested all six, PARCEL-VALUE-HISTORY closed
 * 2026-09-02) -- unlike agValuation/maxImperviousCoverPct, there is no
 * writer-side county exclusion here, so this suite tests the verdict-gating
 * behavior rather than an out-of-scope-county case.
 *
 * Two load-bearing assertions:
 *   - Any pair not resolved to 'record' (no verdict row, a refuse/excluded
 *     verdict, a store failure, a malformed id) resolves to the typed
 *     not-cut-over refusal.
 *   - A slated pair with a real PASS verdict genuinely reaches the
 *     parcel_record adapter.
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
  loadValueHistoryFactForServe,
  resetValueHistoryVerdictStoreForTests,
  setValueHistoryVerdictStoreForTests,
} from "./valueHistoryFactServeCutover";

const GOLD = "48021:34137"; // Bastrop -- slated for valueHistory.

afterEach(() => {
  resetValueHistoryVerdictStoreForTests();
  resetParcelRecordQueryableForTests();
});

describe("loadValueHistoryFactForServe — every slated pair still fails closed without a passing verdict", () => {
  it("a malformed parcelNodeId resolves to not-cut-over without touching the verdict store", async () => {
    const malformed = "not-a-valid-id";
    const result = await loadValueHistoryFactForServe(malformed);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
    expect(result.entityId).toBe(malformed);
  });

  it("no verdict row on a slated county (the real, current live state -- no gate evaluation has run for this rail yet) falls back to not-cut-over", async () => {
    setValueHistoryVerdictStoreForTests(memoryParcelGateVerdicts([]));
    const result = await loadValueHistoryFactForServe(GOLD);
    expect(result).toEqual({
      state: "refused",
      code: "not-cut-over",
      source: "value-history-fact",
      entityId: GOLD,
      reason:
        "valueHistory has no legacy serve path -- it is served only from parcel_record, and only once this (county, rail) pair is slated with a passing gate verdict. Not there yet for this parcel.",
    });
  });

  it("a REFUSE verdict on a slated county falls back to not-cut-over -- attempted but refused, not record", async () => {
    setValueHistoryVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48021", railKey: "valueHistory", verdict: "refuse", unaccountedCount: 9, evaluatedAt: "2026-09-04T00:00:00Z", runId: "test" },
      ]),
    );
    const result = await loadValueHistoryFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });

  it("a store failure on a slated county fails closed to not-cut-over, not a thrown error", async () => {
    setValueHistoryVerdictStoreForTests(memoryParcelGateVerdictsThatFails());
    const result = await loadValueHistoryFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });
});

describe("loadValueHistoryFactForServe — a real PASS verdict genuinely reaches the parcel_record adapter", () => {
  it("Bastrop", async () => {
    setValueHistoryVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48021", railKey: "valueHistory", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-04T00:00:00Z", runId: "test" },
      ]),
    );
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: GOLD, railKey: "valueHistory", cellState: { kind: "value", disposition: "rows", rowCount: 1, source: "cad_property", vintage: "2025" } },
        ],
        companionRows: [
          { placeKey: GOLD, railKey: "valueHistory", rowIndex: 0, payload: { taxYear: 2025, marketValue: "404630", assessedValue: "404630", landValue: "85000", improvementValue: "319630", viaCrosswalk: false }, source: "cad_property", vintage: "2025" },
        ],
      }),
    );
    const result = await loadValueHistoryFactForServe(GOLD);
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.entries[0].taxYear).toBe(2025);
    expect(result.entries[0].marketValue).toBe(404630);
  });

  it("Williamson, via the R1B crosswalk (viaCrosswalk=true)", async () => {
    const williamsonParcel = "48491:R125831";
    setValueHistoryVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48491", railKey: "valueHistory", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-04T00:00:00Z", runId: "test" },
      ]),
    );
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: williamsonParcel, railKey: "valueHistory", cellState: { kind: "value", disposition: "rows", rowCount: 1, source: "cad_property", vintage: "2026" } },
        ],
        companionRows: [
          { placeKey: williamsonParcel, railKey: "valueHistory", rowIndex: 0, payload: { taxYear: 2026, marketValue: "500000", assessedValue: "500000", landValue: "100000", improvementValue: "400000", viaCrosswalk: true }, source: "cad_property", vintage: "2026" },
        ],
      }),
    );
    const result = await loadValueHistoryFactForServe(williamsonParcel);
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.entries[0].viaCrosswalk).toBe(true);
  });
});
