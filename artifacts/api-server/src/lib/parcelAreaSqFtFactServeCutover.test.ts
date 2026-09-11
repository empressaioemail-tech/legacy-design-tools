/**
 * The serve-layer integration point for parcelAreaSqFt (F-01, OPS-21 P-148
 * / P-133). GOLD is 48021, one of the 5 counties this card slates (Bastrop,
 * Caldwell, McLennan, Travis, Williamson -- Hays excluded, P-145 not
 * landed).
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
  loadParcelAreaSqFtFactForServe,
  resetParcelAreaSqFtVerdictStoreForTests,
  setParcelAreaSqFtVerdictStoreForTests,
} from "./parcelAreaSqFtFactServeCutover";

const NOT_A_PROGRAM_COUNTY = "48103:301328";
const HAYS_EXCLUDED = "48209:34137"; // real program county, deliberately never slated for this rail (P-145 not landed).
const GOLD = "48021:34137"; // Bastrop IS slated for parcelAreaSqFt.

afterEach(() => {
  resetParcelAreaSqFtVerdictStoreForTests();
  resetParcelRecordQueryableForTests();
});

describe("loadParcelAreaSqFtFactForServe — never-slated pairs", () => {
  it("a non-program county resolves to the typed not-cut-over refusal, never a store call", async () => {
    setParcelAreaSqFtVerdictStoreForTests(null);
    const result = await loadParcelAreaSqFtFactForServe(NOT_A_PROGRAM_COUNTY);
    expect(result).toEqual({
      state: "refused",
      code: "not-cut-over",
      source: "parcel-area-sqft-fact",
      entityId: NOT_A_PROGRAM_COUNTY,
      reason:
        "parcelAreaSqFt has no legacy serve path -- it is served only from parcel_record, and only once this (county, rail) pair is slated with a passing gate verdict. Not there yet for this parcel.",
    });
  });

  it("Hays resolves to not-cut-over -- deliberately excluded (P-145 not landed), not an oversight", async () => {
    setParcelAreaSqFtVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48209", railKey: "parcelAreaSqFt", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-11T00:00:00Z", runId: "test" },
      ]),
    );
    const result = await loadParcelAreaSqFtFactForServe(HAYS_EXCLUDED);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });

  it("FALSIFIER: even a fabricated PASS verdict has no effect for a non-slated county — the slate check short-circuits first", async () => {
    setParcelAreaSqFtVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48103", railKey: "parcelAreaSqFt", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-11T00:00:00Z", runId: "test" },
      ]),
    );
    const result = await loadParcelAreaSqFtFactForServe(NOT_A_PROGRAM_COUNTY);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });

  it("a malformed parcelNodeId resolves to not-cut-over without touching the verdict store", async () => {
    const malformed = "not-a-valid-id";
    const result = await loadParcelAreaSqFtFactForServe(malformed);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
    expect(result.entityId).toBe(malformed);
  });
});

describe("loadParcelAreaSqFtFactForServe — SLATED pairs (48021/48055/48309/48453/48491)", () => {
  it("a real PASS verdict on Bastrop genuinely reaches the parcel_record adapter", async () => {
    setParcelAreaSqFtVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48021", railKey: "parcelAreaSqFt", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-11T11:52:00Z", runId: "test" },
      ]),
    );
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: GOLD,
            railKey: "parcelAreaSqFt",
            cellState: { kind: "value", value: 8712.3, method: "ST_Area(geography) over ST_MakeValid(ST_Union(...)) of all fragments for this prop_id", source: "txgio_parcel", vintage: "2026-09-11T01:14:13.820Z", fragmentCount: 1 },
          },
        ],
      }),
    );
    const result = await loadParcelAreaSqFtFactForServe(GOLD);
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.sqFt).toBe(8712.3);
  });

  it("no verdict row on Bastrop falls back to not-cut-over, not a thrown error or a fabricated present", async () => {
    setParcelAreaSqFtVerdictStoreForTests(memoryParcelGateVerdicts([]));
    const result = await loadParcelAreaSqFtFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });

  it("a REFUSE verdict on Bastrop still falls back to not-cut-over -- attempted but refused, not record", async () => {
    setParcelAreaSqFtVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48021", railKey: "parcelAreaSqFt", verdict: "refuse", unaccountedCount: 9, evaluatedAt: "2026-09-11T00:00:00Z", runId: "test" },
      ]),
    );
    const result = await loadParcelAreaSqFtFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });

  it("a store failure on Bastrop fails closed to not-cut-over, not a thrown error", async () => {
    setParcelAreaSqFtVerdictStoreForTests(memoryParcelGateVerdictsThatFails());
    const result = await loadParcelAreaSqFtFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });

  it("a null verdict store (not configured) on Bastrop fails closed to not-cut-over", async () => {
    setParcelAreaSqFtVerdictStoreForTests(null);
    const result = await loadParcelAreaSqFtFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });
});
