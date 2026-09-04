/**
 * The serve-layer integration point for overlayDistricts (F-01, serve/prod
 * cutover for ACQUIRE-GIS wave 1 + PARCEL wave 2).
 *
 * Two load-bearing assertions:
 *   - Any pair NOT resolved to 'record' resolves to the typed not-cut-over
 *     refusal -- there is no legacy reader to fall back to.
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
  loadOverlayDistrictsFactForServe,
  resetOverlayDistrictsVerdictStoreForTests,
  setOverlayDistrictsVerdictStoreForTests,
} from "./overlayDistrictsFactServeCutover";

const UNSLATED = "48103:301328"; // Not a program county at all -- never slated for anything.
const GOLD = "48021:34137"; // 48021 IS slated for overlayDistricts.

afterEach(() => {
  resetOverlayDistrictsVerdictStoreForTests();
  resetParcelRecordQueryableForTests();
});

describe("loadOverlayDistrictsFactForServe — no (county, rail) pair has a gate verdict yet", () => {
  it("an unslated pair resolves to the typed not-cut-over refusal, never a store call", async () => {
    setOverlayDistrictsVerdictStoreForTests(null);
    const result = await loadOverlayDistrictsFactForServe(UNSLATED);
    expect(result).toEqual({
      state: "refused",
      code: "not-cut-over",
      source: "overlay-districts-fact",
      entityId: UNSLATED,
      reason:
        "overlayDistricts has no legacy serve path -- it is served only from parcel_record, and only once this (county, rail) pair is slated with a passing gate verdict. Not there yet for this parcel.",
    });
  });

  it("FALSIFIER: even a fabricated PASS verdict has no effect for an unslated county — the slate check short-circuits first", async () => {
    setOverlayDistrictsVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48103", railKey: "overlayDistricts", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-04T00:00:00Z", runId: "test" },
      ]),
    );
    const result = await loadOverlayDistrictsFactForServe(UNSLATED);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });

  it("a malformed parcelNodeId resolves to not-cut-over without touching the verdict store", async () => {
    const malformed = "not-a-valid-id";
    const result = await loadOverlayDistrictsFactForServe(malformed);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
    expect(result.entityId).toBe(malformed);
  });

  it("no verdict row on a slated county (the real, current live state) falls back to not-cut-over", async () => {
    setOverlayDistrictsVerdictStoreForTests(memoryParcelGateVerdicts([]));
    const result = await loadOverlayDistrictsFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });
});

describe("loadOverlayDistrictsFactForServe — SLATED pairs (all 6 counties are slated)", () => {
  it("a real PASS verdict on a slated county genuinely reaches the parcel_record adapter", async () => {
    setOverlayDistrictsVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48021", railKey: "overlayDistricts", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-04T00:00:00Z", runId: "test" },
      ]),
    );
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          { placeKey: GOLD, railKey: "overlayDistricts", cellState: { kind: "value", disposition: "rows", rowCount: 1, source: "tx_city_overlay", vintage: "2026-09-04T00:00:00.000Z" } },
        ],
        companionRows: [
          { placeKey: GOLD, railKey: "overlayDistricts", rowIndex: 0, payload: { city: "Bastrop", CD_Name: "Planned Development District" }, source: "tx_city_overlay", vintage: "2026-09-04T00:00:00.000Z" },
        ],
      }),
    );
    const result = await loadOverlayDistrictsFactForServe(GOLD);
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.districts[0].city).toBe("Bastrop");
  });

  it("a REFUSE verdict on a slated county falls back to not-cut-over -- attempted but refused, not record", async () => {
    setOverlayDistrictsVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48021", railKey: "overlayDistricts", verdict: "refuse", unaccountedCount: 9, evaluatedAt: "2026-09-04T00:00:00Z", runId: "test" },
      ]),
    );
    const result = await loadOverlayDistrictsFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });

  it("a store failure on a slated county fails closed to not-cut-over, not a thrown error", async () => {
    setOverlayDistrictsVerdictStoreForTests(memoryParcelGateVerdictsThatFails());
    const result = await loadOverlayDistrictsFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });

  it("a null verdict store (not configured) on a slated county fails closed to not-cut-over", async () => {
    setOverlayDistrictsVerdictStoreForTests(null);
    const result = await loadOverlayDistrictsFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });
});
