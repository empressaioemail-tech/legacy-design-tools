/**
 * The serve-layer integration point for schoolDistrict (F-01, serve/prod
 * cutover for ACQUIRE-GIS wave 1 + PARCEL wave 2).
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
  loadSchoolDistrictFactForServe,
  resetSchoolDistrictVerdictStoreForTests,
  setSchoolDistrictVerdictStoreForTests,
} from "./schoolDistrictFactServeCutover";

const UNSLATED = "48103:301328"; // Not a program county at all -- never slated for anything.
const GOLD = "48309:135397"; // 48309 IS slated for schoolDistrict (real McGregor ISD sample).

afterEach(() => {
  resetSchoolDistrictVerdictStoreForTests();
  resetParcelRecordQueryableForTests();
});

describe("loadSchoolDistrictFactForServe — no (county, rail) pair has a gate verdict yet", () => {
  it("an unslated pair resolves to the typed not-cut-over refusal, never a store call", async () => {
    setSchoolDistrictVerdictStoreForTests(null);
    const result = await loadSchoolDistrictFactForServe(UNSLATED);
    expect(result).toEqual({
      state: "refused",
      code: "not-cut-over",
      source: "school-district-fact",
      entityId: UNSLATED,
      reason:
        "schoolDistrict has no legacy serve path -- it is served only from parcel_record, and only once this (county, rail) pair is slated with a passing gate verdict. Not there yet for this parcel.",
    });
  });

  it("FALSIFIER: even a fabricated PASS verdict has no effect for an unslated county — the slate check short-circuits first", async () => {
    setSchoolDistrictVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48103", railKey: "schoolDistrict", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-04T00:00:00Z", runId: "test" },
      ]),
    );
    const result = await loadSchoolDistrictFactForServe(UNSLATED);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });

  it("a malformed parcelNodeId resolves to not-cut-over without touching the verdict store", async () => {
    const malformed = "not-a-valid-id";
    const result = await loadSchoolDistrictFactForServe(malformed);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
    expect(result.entityId).toBe(malformed);
  });

  it("no verdict row on a slated county (the real, current live state) falls back to not-cut-over", async () => {
    setSchoolDistrictVerdictStoreForTests(memoryParcelGateVerdicts([]));
    const result = await loadSchoolDistrictFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });
});

describe("loadSchoolDistrictFactForServe — SLATED pairs (all 6 counties are slated)", () => {
  it("a real PASS verdict on a slated county genuinely reaches the parcel_record adapter", async () => {
    setSchoolDistrictVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48309", railKey: "schoolDistrict", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-04T00:00:00Z", runId: "test" },
      ]),
    );
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [
          {
            placeKey: GOLD,
            railKey: "schoolDistrict",
            cellState: {
              kind: "value",
              value: "McGregor ISD",
              districtCode: "161-909",
              geoid: "4829820",
              source: "tx_school_district",
              vintage: "2026-09-03T16:50:31.471Z",
            },
          },
        ],
      }),
    );
    const result = await loadSchoolDistrictFactForServe(GOLD);
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.districtName).toBe("McGregor ISD");
    expect(result.districtCode).toBe("161-909");
  });

  it("a REFUSE verdict on a slated county falls back to not-cut-over -- attempted but refused, not record", async () => {
    setSchoolDistrictVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48309", railKey: "schoolDistrict", verdict: "refuse", unaccountedCount: 9, evaluatedAt: "2026-09-04T00:00:00Z", runId: "test" },
      ]),
    );
    const result = await loadSchoolDistrictFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });

  it("a store failure on a slated county fails closed to not-cut-over, not a thrown error", async () => {
    setSchoolDistrictVerdictStoreForTests(memoryParcelGateVerdictsThatFails());
    const result = await loadSchoolDistrictFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });

  it("a null verdict store (not configured) on a slated county fails closed to not-cut-over", async () => {
    setSchoolDistrictVerdictStoreForTests(null);
    const result = await loadSchoolDistrictFactForServe(GOLD);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("not-cut-over");
  });
});
