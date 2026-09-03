/**
 * The serve-layer integration point PARCEL-B-SLATE1 built for cityLimits
 * and activated for ALL SIX program counties, including Caldwell (48055) --
 * unlike wells/specialDistricts, cityLimits has no txgio-geometry
 * dependency, so Caldwell's known geometry gap does not exclude it here.
 *
 * Two load-bearing assertions, both proven here at the unit level:
 *   - UNSLATED pairs (any county outside the six-county program, e.g.
 *     48103) still produce byte-identical output to loadCityLimitsFact,
 *     regardless of what the verdict store says.
 *   - SLATED pairs (all six program counties, including Caldwell) genuinely
 *     reach the record adapter on a real pass verdict, and genuinely fall
 *     back to legacy on refuse/no-verdict/store-failure.
 */

import { afterEach, describe, expect, it } from "vitest";
import { buildCityBoundaryIndex } from "@workspace/cad-ingest/boundary";
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
  loadCityLimitsFact,
  resetCityLimitsIndexForTests,
  setCityLimitsIndexForTests,
} from "./cityLimitsFactRead";
import {
  loadCityLimitsFactForServe,
  resetCityLimitsVerdictStoreForTests,
  setCityLimitsVerdictStoreForTests,
} from "./cityLimitsFactServeCutover";

const GOLD = "48021:34137"; // 48021 IS slated for cityLimits.
const CALDWELL_PARCEL = "48055:10068"; // 48055 IS slated for cityLimits (unlike wells/specialDistricts).
const UNSLATED = "48103:100"; // 48103 is NOT a program county at all.
const POINT = { longitude: -97.75, latitude: 30.26 }; // inside the AUSTIN fixture polygon below

const AUSTIN = buildCityBoundaryIndex([
  {
    geoId: "4805000",
    cityName: "Austin",
    gnis: "1389879",
    geometry: {
      type: "Polygon",
      coordinates: [[[-97.78, 30.24], [-97.72, 30.24], [-97.72, 30.28], [-97.78, 30.28], [-97.78, 30.24]]],
    },
  },
]);

afterEach(() => {
  resetCityLimitsIndexForTests();
  resetCityLimitsVerdictStoreForTests();
  resetParcelRecordQueryableForTests();
});

describe("loadCityLimitsFactForServe — UNSLATED county stays byte-identical to loadCityLimitsFact", () => {
  it("incorporated fixture: identical shape via the wrapper and the direct call", async () => {
    setCityLimitsIndexForTests({ tablePopulated: true, entries: AUSTIN });
    setCityLimitsVerdictStoreForTests(null);
    const direct = await loadCityLimitsFact(POINT);
    const viaWrapper = await loadCityLimitsFactForServe(UNSLATED, POINT);
    expect(viaWrapper).toEqual(direct);
    expect(direct.status).toBe("incorporated");
  });

  it("FALSIFIER: even a fabricated PASS verdict has no effect for an unslated county", async () => {
    setCityLimitsIndexForTests({ tablePopulated: true, entries: AUSTIN });
    setCityLimitsVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48103", railKey: "cityLimits", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-02T18:00:00Z", runId: "test" },
      ]),
    );
    const direct = await loadCityLimitsFact(POINT);
    const viaWrapper = await loadCityLimitsFactForServe(UNSLATED, POINT);
    expect(viaWrapper).toEqual(direct);
  });

  it("a malformed parcelNodeId falls through to loadCityLimitsFact's own point-only logic, unchanged", async () => {
    setCityLimitsIndexForTests({ tablePopulated: true, entries: AUSTIN });
    setCityLimitsVerdictStoreForTests(null);
    const direct = await loadCityLimitsFact(POINT);
    const viaWrapper = await loadCityLimitsFactForServe("not-a-valid-id", POINT);
    expect(viaWrapper).toEqual(direct);
  });
});

describe("loadCityLimitsFactForServe — SLATED counties (gold + Caldwell) genuinely reach the record adapter", () => {
  it("a real PASS verdict on gold (48021) serves from parcel_record, not tx_city_boundary PIP", async () => {
    setCityLimitsIndexForTests({ tablePopulated: true, entries: AUSTIN }); // legacy fixture would say incorporated/Austin
    setCityLimitsVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48021", railKey: "cityLimits", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-02T18:00:00Z", runId: "test" },
      ]),
    );
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [{ placeKey: GOLD, railKey: "cityLimits", cellState: { kind: "value", value: "Bastrop", source: "landing_parcel_jurisdiction", vintage: "2026-09-02" } }],
      }),
    );
    const result = await loadCityLimitsFactForServe(GOLD, POINT);
    // The legacy fixture above claims "Austin" -- this result must say
    // "Bastrop" (the parcel_record value), proving it never touched the fixture.
    expect(result.status).toBe("incorporated");
    expect(result.cityName).toBe("Bastrop");
    expect(result.queryPoint).toEqual(POINT);
  });

  it("a real PASS verdict on CALDWELL (48055) serves from parcel_record too -- Caldwell is slated here, unlike wells/specialDistricts", async () => {
    setCityLimitsIndexForTests({ tablePopulated: false, entries: [] }); // legacy fixture would say unmeasured (empty index)
    setCityLimitsVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48055", railKey: "cityLimits", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-02T18:00:00Z", runId: "test" },
      ]),
    );
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [{ placeKey: CALDWELL_PARCEL, railKey: "cityLimits", cellState: { kind: "absent-verified", basis: { disposition: "unincorporated", source: "landing_parcel_jurisdiction" } } }],
      }),
    );
    const result = await loadCityLimitsFactForServe(CALDWELL_PARCEL, POINT);
    // The legacy fixture above (empty index) would say "unmeasured" -- this
    // result must say "unincorporated" (a real determination), proving it
    // never touched the fixture.
    expect(result.status).toBe("unincorporated");
  });

  it("REFUSE verdict on gold still falls back to legacy -- attempted but refused, not record", async () => {
    setCityLimitsIndexForTests({ tablePopulated: true, entries: AUSTIN });
    setCityLimitsVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48021", railKey: "cityLimits", verdict: "refuse", unaccountedCount: 4, evaluatedAt: "2026-09-02T18:00:00Z", runId: "test" },
      ]),
    );
    const direct = await loadCityLimitsFact(POINT);
    const viaWrapper = await loadCityLimitsFactForServe(GOLD, POINT);
    expect(viaWrapper).toEqual(direct);
  });

  it("a store failure on gold fails closed to legacy, not a thrown error", async () => {
    setCityLimitsIndexForTests({ tablePopulated: true, entries: AUSTIN });
    setCityLimitsVerdictStoreForTests(memoryParcelGateVerdictsThatFails());
    const direct = await loadCityLimitsFact(POINT);
    const viaWrapper = await loadCityLimitsFactForServe(GOLD, POINT);
    expect(viaWrapper).toEqual(direct);
  });

  it("a null verdict store (not configured) on gold fails closed to legacy", async () => {
    setCityLimitsIndexForTests({ tablePopulated: true, entries: AUSTIN });
    setCityLimitsVerdictStoreForTests(null);
    const direct = await loadCityLimitsFact(POINT);
    const viaWrapper = await loadCityLimitsFactForServe(GOLD, POINT);
    expect(viaWrapper).toEqual(direct);
  });
});
