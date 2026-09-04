/**
 * The serve-layer integration point for agValuation (F-01, serve/prod
 * cutover for ACQUIRE-GIS wave 1 + PARCEL wave 2). Williamson (48491) and
 * Travis (48453) only.
 *
 * Two load-bearing assertions:
 *   - Any pair NOT resolved to 'record' (including every non-target county)
 *     resolves to the typed not-cut-over refusal.
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
  loadAgValuationFactForServe,
  resetAgValuationVerdictStoreForTests,
  setAgValuationVerdictStoreForTests,
} from "./agValuationFactServeCutover";

const OUT_OF_SCOPE_COUNTY = "48021:34137"; // Bastrop -- a real program county but never slated for this rail.
const GOLD = "48491:34137"; // Williamson IS slated for agValuation.

afterEach(() => {
  resetAgValuationVerdictStoreForTests();
  resetParcelRecordQueryableForTests();
});

describe("loadAgValuationFactForServe — non-target counties are never slated", () => {
  it("a real program county outside {Williamson, Travis} resolves to the typed not-cut-over refusal, never a store call", async () => {
    setAgValuationVerdictStoreForTests(null);
    const result = await loadAgValuationFactForServe(OUT_OF_SCOPE_COUNTY);
    expect(result).toEqual({
      state: "refused",
      code: "not-cut-over",
      source: "ag-valuation-fact",
      entityId: OUT_OF_SCOPE_COUNTY,
      reason:
        "agValuation has no legacy serve path -- it is served only from parcel_record (Williamson and Travis counties only), and only once this (county, rail) pair is slated with a passing gate verdict. Not there yet for this parcel.",
    });
  });

  it("FALSIFIER: even a fabricated PASS verdict has no effect for a non-target county — the slate check short-circuits first", async () => {
    setAgValuationVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48021", railKey: "agValuation", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-04T00:00:00Z", runId: "test" },
      ]),
    );
    const result = await loadAgValuationFactForServe(OUT_OF_SCOPE_COUNTY);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });

  it("a malformed parcelNodeId resolves to not-cut-over without touching the verdict store", async () => {
    const malformed = "not-a-valid-id";
    const result = await loadAgValuationFactForServe(malformed);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
    expect(result.entityId).toBe(malformed);
  });

  it("no verdict row on a slated county (the real, current live state) falls back to not-cut-over", async () => {
    setAgValuationVerdictStoreForTests(memoryParcelGateVerdicts([]));
    const result = await loadAgValuationFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });
});

describe("loadAgValuationFactForServe — SLATED pairs (Williamson, Travis)", () => {
  it("a real PASS verdict on Williamson genuinely reaches the parcel_record adapter", async () => {
    setAgValuationVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48491", railKey: "agValuation", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-04T00:00:00Z", runId: "test" },
      ]),
    );
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: GOLD, railKey: "agValuation", cellState: { kind: "value", disposition: "rows", rowCount: 1, source: "tx_wcad_ag_valuation", vintage: "2026-09-04T00:00:00.000Z" } },
        ],
        companionRows: [
          { placeKey: GOLD, railKey: "agValuation", rowIndex: 0, payload: { landType: "Native Pasture", agFlag: true }, source: "tx_wcad_ag_valuation", vintage: "2026-09-04T00:00:00.000Z" },
        ],
      }),
    );
    const result = await loadAgValuationFactForServe(GOLD);
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.entries[0].landType).toBe("Native Pasture");
  });

  it("a real PASS verdict on Travis also genuinely reaches the parcel_record adapter", async () => {
    const travisParcel = "48453:998877";
    setAgValuationVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48453", railKey: "agValuation", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-04T00:00:00Z", runId: "test" },
      ]),
    );
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: travisParcel, railKey: "agValuation", cellState: { kind: "value", disposition: "rows", rowCount: 1, source: "tx_tcad_ag_valuation", vintage: "2026-09-04T00:00:00.000Z" } },
        ],
        companionRows: [
          { placeKey: travisParcel, railKey: "agValuation", rowIndex: 0, payload: { landType: "Dry Cropland", agFlag: true }, source: "tx_tcad_ag_valuation", vintage: "2026-09-04T00:00:00.000Z" },
        ],
      }),
    );
    const result = await loadAgValuationFactForServe(travisParcel);
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.entries[0].landType).toBe("Dry Cropland");
  });

  it("a REFUSE verdict on a slated county falls back to not-cut-over -- attempted but refused, not record", async () => {
    setAgValuationVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48491", railKey: "agValuation", verdict: "refuse", unaccountedCount: 9, evaluatedAt: "2026-09-04T00:00:00Z", runId: "test" },
      ]),
    );
    const result = await loadAgValuationFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });

  it("a store failure on a slated county fails closed to not-cut-over, not a thrown error", async () => {
    setAgValuationVerdictStoreForTests(memoryParcelGateVerdictsThatFails());
    const result = await loadAgValuationFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });
});
