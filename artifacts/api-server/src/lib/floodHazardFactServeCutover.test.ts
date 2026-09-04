/**
 * The serve-layer integration point PARCEL-FLOOD-CUTOVER built and
 * activated for ALL SIX program counties, including Caldwell (deliberately
 * slated so its own 'excluded' gate verdict resolves to the allowlist's
 * visible 'refused' state, not a silent 'legacy' default).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  memoryParcelGateVerdicts,
  memoryParcelGateVerdictsThatFails,
} from "./parcelGateVerdictRead";
import {
  memoryParcelRecordFlood,
  resetParcelRecordQueryableForTests,
  setParcelRecordQueryableForTests,
} from "./parcelRecordFactRead";
import {
  memoryFloodHazardAtoms,
  resetFloodHazardAtomQueryableForTests,
  setFloodHazardAtomQueryableForTests,
} from "./floodHazardFactRead";
import {
  loadFloodHazardFactForServe,
  resetFloodVerdictStoreForTests,
  setFloodVerdictStoreForTests,
} from "./floodHazardFactServeCutover";

const GOLD = "48021:34137"; // 48021 IS slated for flood.
const CALDWELL_PARCEL = "48055:10068"; // 48055 IS slated for flood (unlike wells/specialDistricts).
const UNSLATED = "48103:100"; // 48103 is NOT a program county.
const UNSLATED_BODY = {
  entityType: "flood-hazard-fact",
  inSpecialFloodHazardArea: false,
  floodZone: "X",
  zoneSubtype: null,
  baseFloodElevation: null,
  sourceAdapter: "fema-nfhl-bulk-v1",
  sourceVintage: "NFHL_48_20260101",
  sourceCitation: "test fixture",
  evaluatedAt: "2026-08-15T00:00:00Z",
};

afterEach(() => {
  resetFloodHazardAtomQueryableForTests();
  resetFloodVerdictStoreForTests();
  resetParcelRecordQueryableForTests();
});

describe("loadFloodHazardFactForServe — UNSLATED county stays byte-identical to loadFloodHazardFactAtom", () => {
  it("a present zone-X fixture: identical shape via the wrapper and the direct call", async () => {
    setFloodHazardAtomQueryableForTests(
      memoryFloodHazardAtoms([{ entityId: UNSLATED, body: UNSLATED_BODY }]),
    );
    setFloodVerdictStoreForTests(null);
    const direct = await import("./floodHazardFactRead").then((m) => m.loadFloodHazardFactAtom(UNSLATED));
    const viaWrapper = await loadFloodHazardFactForServe(UNSLATED);
    expect(viaWrapper).toEqual(direct);
  });

  it("FALSIFIER: even a fabricated PASS verdict has no effect for an unslated county", async () => {
    setFloodHazardAtomQueryableForTests(
      memoryFloodHazardAtoms([{ entityId: UNSLATED, body: UNSLATED_BODY }]),
    );
    setFloodVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48103", railKey: "flood", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-02T18:00:00Z", runId: "test" },
      ]),
    );
    const direct = await import("./floodHazardFactRead").then((m) => m.loadFloodHazardFactAtom(UNSLATED));
    const viaWrapper = await loadFloodHazardFactForServe(UNSLATED);
    expect(viaWrapper).toEqual(direct);
  });

  it("a malformed parcelNodeId falls through to loadFloodHazardFactAtom's own existing refusal, unchanged", async () => {
    setFloodHazardAtomQueryableForTests(memoryFloodHazardAtoms([]));
    setFloodVerdictStoreForTests(null);
    const direct = await import("./floodHazardFactRead").then((m) => m.loadFloodHazardFactAtom("not-a-valid-id"));
    const viaWrapper = await loadFloodHazardFactForServe("not-a-valid-id");
    expect(viaWrapper).toEqual(direct);
  });
});

describe("loadFloodHazardFactForServe — SLATED counties (gold + Caldwell) genuinely reach the record adapter", () => {
  it("a real PASS verdict on gold (48021) serves from parcel_record, not the legacy atom", async () => {
    setFloodHazardAtomQueryableForTests(
      memoryFloodHazardAtoms([{ entityId: GOLD, body: { ...UNSLATED_BODY, floodZone: "X" } }]), // legacy fixture claims zone X
    );
    setFloodVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48021", railKey: "flood", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-02T18:00:00Z", runId: "test" },
      ]),
    );
    setParcelRecordQueryableForTests(
      memoryParcelRecordFlood([
        {
          placeKey: GOLD,
          cellState: { kind: "value", source: "tx_fema_nfhl_flood_zone", vintage: "NFHL_48_20260101" },
          payload: { zone: "AE", floodway: false, bfe: 512.3, method: "point-on-surface", sourceVintage: "NFHL_48_20260101" }, // record claims AE, a real divergence from the legacy fixture
        },
      ]),
    );
    const result = await loadFloodHazardFactForServe(GOLD);
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.floodZone).toBe("AE");
    expect(result.sourceAdapter).toBe("parcel_record");
  });

  it("CALDWELL (48055): an EXCLUDED verdict on a slated county resolves the allowlist to 'refused' -- serves legacy at the wire (same as a REFUSE would), but is the visible, attempted state this card's own premise names", async () => {
    setFloodHazardAtomQueryableForTests(
      memoryFloodHazardAtoms([{ entityId: CALDWELL_PARCEL, body: UNSLATED_BODY }]),
    );
    setFloodVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48055", railKey: "flood", verdict: "excluded", unaccountedCount: 0, evaluatedAt: "2026-09-02T21:42:16Z", runId: "real-b-gate-sched-run" },
      ]),
    );
    const direct = await import("./floodHazardFactRead").then((m) => m.loadFloodHazardFactAtom(CALDWELL_PARCEL));
    const viaWrapper = await loadFloodHazardFactForServe(CALDWELL_PARCEL);
    // Wire behavior is identical to legacy (excluded -> 'refused' state ->
    // same fallback as legacy/unslated) -- the DISTINCTION lives in the
    // allowlist's own resolveAllowlistState (see parcelRecordAllowlist.test.ts),
    // not in this wrapper's own output shape.
    expect(viaWrapper).toEqual(direct);
  });

  it("REFUSE verdict on gold still falls back to legacy -- attempted but refused, not record", async () => {
    setFloodHazardAtomQueryableForTests(memoryFloodHazardAtoms([]));
    setFloodVerdictStoreForTests(
      memoryParcelGateVerdicts([
        { countyFips: "48021", railKey: "flood", verdict: "refuse", unaccountedCount: 7, evaluatedAt: "2026-09-02T18:00:00Z", runId: "test" },
      ]),
    );
    const direct = await import("./floodHazardFactRead").then((m) => m.loadFloodHazardFactAtom(GOLD));
    const viaWrapper = await loadFloodHazardFactForServe(GOLD);
    expect(viaWrapper).toEqual(direct);
  });

  it("a store failure on gold fails closed to legacy, not a thrown error", async () => {
    setFloodHazardAtomQueryableForTests(memoryFloodHazardAtoms([]));
    setFloodVerdictStoreForTests(memoryParcelGateVerdictsThatFails());
    const direct = await import("./floodHazardFactRead").then((m) => m.loadFloodHazardFactAtom(GOLD));
    const viaWrapper = await loadFloodHazardFactForServe(GOLD);
    expect(viaWrapper).toEqual(direct);
  });

  it("a null verdict store (not configured) on gold fails closed to legacy", async () => {
    setFloodHazardAtomQueryableForTests(memoryFloodHazardAtoms([]));
    setFloodVerdictStoreForTests(null);
    const direct = await import("./floodHazardFactRead").then((m) => m.loadFloodHazardFactAtom(GOLD));
    const viaWrapper = await loadFloodHazardFactForServe(GOLD);
    expect(viaWrapper).toEqual(direct);
  });
});
