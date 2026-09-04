/**
 * The serve-layer integration point PARCEL-B-READER shipped and
 * PARCEL-B-SLATE1 activated for wells (5 counties: 48021/48209/48309/
 * 48453/48491; Caldwell 48055 stays legacy, its own known geometry gap).
 *
 * Two load-bearing assertions, both proven here at the unit level:
 *   - UNSLATED pairs (any other county, e.g. 48103) still produce
 *     byte-identical output to loadWellFactAtom, regardless of what the
 *     verdict store says -- the slate gates everything.
 *   - SLATED pairs (the five wells counties) genuinely reach the record
 *     adapter on a real pass verdict, and genuinely fall back to legacy on
 *     refuse/no-verdict/store-failure -- fail closed even when slated.
 * Every test injects an explicit verdict store (never relies on the
 * env-resolved default being absent) so this suite is deterministic
 * regardless of what FACTORY_DATABASE_URL_RO happens to be in the
 * running process.
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
  interpretWellFactRows,
  memoryWellFactAtoms,
  resetWellFactAtomQueryableForTests,
  setWellFactAtomQueryableForTests,
} from "./wellFactRead";
import {
  loadWellFactForServe,
  resetWellsVerdictStoreForTests,
  setWellsVerdictStoreForTests,
} from "./wellFactServeCutover";

const GOLD = "48021:34137"; // 48021 IS slated for wells.
const CRANE = "48103:100"; // 48103 is NOT slated for wells.
const CRANE_LEAD_BODY = {
  entityType: "well-fact",
  parcelNodeId: CRANE,
  wellKey: "42000001030000",
  apiNumber14: "42000001030000",
  wellStatus: "dry",
  wellType: "unknown",
  orphaned: false,
  parcelRelation: "on-parcel" as const,
  proximityRadiusMeters: 152,
  surfaceLocation: { lat: 31.48020694, lng: -102.75930581 },
  sourceTier: "texas-rrc-gis",
  sourceAdapter: "tx-rrc-well-staged-v1",
  evaluatedAt: "2026-08-16T09:57:36.576Z",
};

afterEach(() => {
  resetWellFactAtomQueryableForTests();
  resetWellsVerdictStoreForTests();
  resetParcelRecordQueryableForTests();
});

describe("loadWellFactForServe — UNSLATED pairs stay byte-identical to loadWellFactAtom", () => {
  it("a present on-parcel well: identical shape via the wrapper and the direct call", async () => {
    setWellFactAtomQueryableForTests(
      memoryWellFactAtoms([{ entityId: `${CRANE}:42000001030000`, body: CRANE_LEAD_BODY }]),
    );
    setWellsVerdictStoreForTests(null);
    const direct = await import("./wellFactRead").then((m) => m.loadWellFactAtom(CRANE));
    const viaWrapper = await loadWellFactForServe(CRANE);
    expect(viaWrapper).toEqual(direct);
  });

  it("a parcel with no well-fact atom at all, in an unslated county: identical atom-miss refusal via both paths", async () => {
    setWellFactAtomQueryableForTests(memoryWellFactAtoms([]));
    setWellsVerdictStoreForTests(null);
    const direct = await import("./wellFactRead").then((m) => m.loadWellFactAtom(CRANE));
    const viaWrapper = await loadWellFactForServe(CRANE);
    expect(viaWrapper).toEqual(direct);
    expect(direct.state).toBe("refused");
  });

  it("FALSIFIER: even a fabricated verdict store with a PASS row has no effect for an UNSLATED county — the slate check short-circuits first", async () => {
    setWellFactAtomQueryableForTests(
      memoryWellFactAtoms([{ entityId: `${CRANE}:42000001030000`, body: CRANE_LEAD_BODY }]),
    );
    setWellsVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48103", railKey: "wells", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-02T18:00:00Z", runId: "test" },
      ]),
    );
    const direct = await import("./wellFactRead").then((m) => m.loadWellFactAtom(CRANE));
    const viaWrapper = await loadWellFactForServe(CRANE);
    expect(viaWrapper).toEqual(direct);
  });

  it("a malformed parcelNodeId (no county prefix) falls through to loadWellFactAtom's own existing refusal, unchanged", async () => {
    setWellFactAtomQueryableForTests(memoryWellFactAtoms([]));
    setWellsVerdictStoreForTests(null);
    const malformed = "not-a-valid-id";
    const direct = await import("./wellFactRead").then((m) => m.loadWellFactAtom(malformed));
    const viaWrapper = await loadWellFactForServe(malformed);
    expect(viaWrapper).toEqual(direct);
  });
});

describe("loadWellFactForServe — SLATED pairs (gold, 48021) genuinely reach the record adapter", () => {
  it("a real PASS verdict on a slated county serves from parcel_record, not the legacy atom store", async () => {
    setWellFactAtomQueryableForTests(
      memoryWellFactAtoms([{ entityId: `${GOLD}:42000001030000`, body: { ...CRANE_LEAD_BODY, parcelNodeId: GOLD } }]),
    );
    setWellsVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48021", railKey: "wells", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-02T18:00:00Z", runId: "test" },
      ]),
    );
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [{ placeKey: GOLD, railKey: "wells", cellState: { kind: "absent-verified", basis: { method: "zone-major-sweep", finding: "no tx_rrc_well point falls within this parcel's geometry" } } }],
      }),
    );
    const result = await loadWellFactForServe(GOLD);
    // The record adapter's own absence shape, NOT the legacy atom's -- proves
    // this request never touched the atom store's fixture at all (it was
    // seeded with a PRESENT well above; a legacy read would have found it).
    expect(result.state).toBe("absent");
    if (result.state !== "absent") throw new Error("unreachable");
    expect(result.sourceAdapter).toBe("parcel_record");
  });

  it("REFUSE verdict on a slated county still falls back to legacy -- attempted but refused, not record", async () => {
    setWellFactAtomQueryableForTests(memoryWellFactAtoms([]));
    setWellsVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48021", railKey: "wells", verdict: "refuse", unaccountedCount: 12, evaluatedAt: "2026-09-02T18:00:00Z", runId: "test" },
      ]),
    );
    const direct = await import("./wellFactRead").then((m) => m.loadWellFactAtom(GOLD));
    const viaWrapper = await loadWellFactForServe(GOLD);
    expect(viaWrapper).toEqual(direct);
  });

  it("a store failure on a slated county fails closed to legacy, not a thrown error", async () => {
    setWellFactAtomQueryableForTests(memoryWellFactAtoms([]));
    setWellsVerdictStoreForTests(memoryParcelGateVerdictsThatFails());
    const direct = await import("./wellFactRead").then((m) => m.loadWellFactAtom(GOLD));
    const viaWrapper = await loadWellFactForServe(GOLD);
    expect(viaWrapper).toEqual(direct);
  });

  it("a null verdict store (not configured) on a slated county fails closed to legacy", async () => {
    setWellFactAtomQueryableForTests(memoryWellFactAtoms([]));
    setWellsVerdictStoreForTests(null);
    const direct = await import("./wellFactRead").then((m) => m.loadWellFactAtom(GOLD));
    const viaWrapper = await loadWellFactForServe(GOLD);
    expect(viaWrapper).toEqual(direct);
  });
});

describe("interpretWellFactRows sanity (unchanged, confirms the sibling module was not edited)", () => {
  it("still refuses atom-miss the same way", () => {
    const result = interpretWellFactRows(GOLD, []);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("atom-miss");
  });
});
