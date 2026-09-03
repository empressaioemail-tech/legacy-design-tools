/**
 * The serve-layer integration point PARCEL-B-SLATE1 built for
 * specialDistricts and activated for 5 counties (48021/48209/48309/48453/
 * 48491; Caldwell 48055 stays legacy, its own known geometry gap).
 *
 * Two load-bearing assertions, both proven here at the unit level:
 *   - UNSLATED pairs (any other county) still produce byte-identical
 *     output to loadSpecialDistrictFactAtom, regardless of what the
 *     verdict store says -- the slate gates everything.
 *   - SLATED pairs (the five specialDistricts counties) genuinely reach
 *     the record adapter on a real pass verdict, and genuinely fall back
 *     to legacy on refuse/no-verdict/store-failure -- fail closed even
 *     when slated.
 * Every test injects an explicit verdict store (never relies on the
 * env-resolved default being absent), mirroring wellFactServeCutover.test.ts.
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
  memorySpecialDistrictFactAtoms,
  resetSpecialDistrictFactAtomQueryableForTests,
  setSpecialDistrictFactAtomQueryableForTests,
} from "./specialDistrictFactRead";
import {
  loadSpecialDistrictFactForServe,
  resetSpecialDistrictsVerdictStoreForTests,
  setSpecialDistrictsVerdictStoreForTests,
} from "./specialDistrictFactServeCutover";

const GOLD = "48021:34137"; // 48021 IS slated for specialDistricts.
const OATMAN = "48103:301328"; // 48103 is NOT slated.
const OATMAN_BODY = {
  entityType: "special-district-fact",
  districtId: "6186000",
  districtType: "MUD",
  districtName: "Oatman Hill MUD",
  evaluatedAt: "2026-08-13T09:07:29.732Z",
};

afterEach(() => {
  resetSpecialDistrictFactAtomQueryableForTests();
  resetSpecialDistrictsVerdictStoreForTests();
  resetParcelRecordQueryableForTests();
});

describe("loadSpecialDistrictFactForServe — UNSLATED pairs stay byte-identical to loadSpecialDistrictFactAtom", () => {
  it("a present district: identical shape via the wrapper and the direct call", async () => {
    setSpecialDistrictFactAtomQueryableForTests(
      memorySpecialDistrictFactAtoms([{ entityId: `${OATMAN}:sd:6186000`, body: OATMAN_BODY }]),
    );
    setSpecialDistrictsVerdictStoreForTests(null);
    const direct = await import("./specialDistrictFactRead").then((m) => m.loadSpecialDistrictFactAtom(OATMAN));
    const viaWrapper = await loadSpecialDistrictFactForServe(OATMAN);
    expect(viaWrapper).toEqual(direct);
  });

  it("a parcel with no special-district atom at all, in an unslated county: identical atom-miss refusal via both paths", async () => {
    setSpecialDistrictFactAtomQueryableForTests(memorySpecialDistrictFactAtoms([]));
    setSpecialDistrictsVerdictStoreForTests(null);
    const direct = await import("./specialDistrictFactRead").then((m) => m.loadSpecialDistrictFactAtom(OATMAN));
    const viaWrapper = await loadSpecialDistrictFactForServe(OATMAN);
    expect(viaWrapper).toEqual(direct);
    expect(direct.state).toBe("refused");
  });

  it("FALSIFIER: even a fabricated verdict store with a PASS row has no effect for an UNSLATED county — the slate check short-circuits first", async () => {
    setSpecialDistrictFactAtomQueryableForTests(
      memorySpecialDistrictFactAtoms([{ entityId: `${OATMAN}:sd:6186000`, body: OATMAN_BODY }]),
    );
    setSpecialDistrictsVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48103", railKey: "specialDistricts", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-02T18:00:00Z", runId: "test" },
      ]),
    );
    const direct = await import("./specialDistrictFactRead").then((m) => m.loadSpecialDistrictFactAtom(OATMAN));
    const viaWrapper = await loadSpecialDistrictFactForServe(OATMAN);
    expect(viaWrapper).toEqual(direct);
  });

  it("a malformed parcelNodeId (no county prefix) falls through to loadSpecialDistrictFactAtom's own existing refusal, unchanged", async () => {
    setSpecialDistrictFactAtomQueryableForTests(memorySpecialDistrictFactAtoms([]));
    setSpecialDistrictsVerdictStoreForTests(null);
    const malformed = "not-a-valid-id";
    const direct = await import("./specialDistrictFactRead").then((m) => m.loadSpecialDistrictFactAtom(malformed));
    const viaWrapper = await loadSpecialDistrictFactForServe(malformed);
    expect(viaWrapper).toEqual(direct);
  });
});

describe("loadSpecialDistrictFactForServe — SLATED pairs (gold, 48021) genuinely reach the record adapter", () => {
  it("a real PASS verdict on a slated county serves from parcel_record, not the legacy atom store", async () => {
    setSpecialDistrictFactAtomQueryableForTests(
      memorySpecialDistrictFactAtoms([{ entityId: `${GOLD}:sd:6186000`, body: { ...OATMAN_BODY, districtId: "9999999" } }]),
    );
    setSpecialDistrictsVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48021", railKey: "specialDistricts", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-02T18:00:00Z", runId: "test" },
      ]),
    );
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [{ placeKey: GOLD, railKey: "specialDistricts", cellState: { kind: "value", disposition: "rows", rowCount: 1, source: "tx_special_district", vintage: "2026-09-02" } }],
        companionRows: [{ placeKey: GOLD, railKey: "specialDistricts", rowIndex: 0, payload: { districtId: "6186000", districtType: "MUD", districtName: "Oatman Hill MUD" }, source: "tx_special_district", vintage: "2026-08-10" }],
      }),
    );
    const result = await loadSpecialDistrictFactForServe(GOLD);
    // The atom fixture above claims a DIFFERENT districtId (9999999) than
    // the parcel_record fixture (6186000) -- proves this response came from
    // parcel_record, not a legacy read that happened to match by luck.
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.districtId).toBe("6186000");
  });

  it("REFUSE verdict on a slated county still falls back to legacy -- attempted but refused, not record", async () => {
    setSpecialDistrictFactAtomQueryableForTests(memorySpecialDistrictFactAtoms([]));
    setSpecialDistrictsVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48021", railKey: "specialDistricts", verdict: "refuse", unaccountedCount: 9, evaluatedAt: "2026-09-02T18:00:00Z", runId: "test" },
      ]),
    );
    const direct = await import("./specialDistrictFactRead").then((m) => m.loadSpecialDistrictFactAtom(GOLD));
    const viaWrapper = await loadSpecialDistrictFactForServe(GOLD);
    expect(viaWrapper).toEqual(direct);
  });

  it("a store failure on a slated county fails closed to legacy, not a thrown error", async () => {
    setSpecialDistrictFactAtomQueryableForTests(memorySpecialDistrictFactAtoms([]));
    setSpecialDistrictsVerdictStoreForTests(memoryParcelGateVerdictsThatFails());
    const direct = await import("./specialDistrictFactRead").then((m) => m.loadSpecialDistrictFactAtom(GOLD));
    const viaWrapper = await loadSpecialDistrictFactForServe(GOLD);
    expect(viaWrapper).toEqual(direct);
  });

  it("a null verdict store (not configured) on a slated county fails closed to legacy", async () => {
    setSpecialDistrictFactAtomQueryableForTests(memorySpecialDistrictFactAtoms([]));
    setSpecialDistrictsVerdictStoreForTests(null);
    const direct = await import("./specialDistrictFactRead").then((m) => m.loadSpecialDistrictFactAtom(GOLD));
    const viaWrapper = await loadSpecialDistrictFactForServe(GOLD);
    expect(viaWrapper).toEqual(direct);
  });
});
