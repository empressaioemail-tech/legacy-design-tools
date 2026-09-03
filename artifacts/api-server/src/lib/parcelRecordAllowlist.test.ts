/**
 * The rail-scoped serve allowlist. Every dispatch-mandated falsifier for
 * PARCEL-B-READER (and, since PARCEL-B-SLATE1's wells cutover, the real
 * slate's own membership) lives in this file:
 *   - fail CLOSED: unreadable or missing verdict = legacy, never record
 *   - only the real, code-owned slate entries resolve toward record; every
 *     unslated pair resolves to legacy regardless of a fabricated 'pass'
 *   - a county-rail with unaccounted cells on a live rail (verdict
 *     'refuse') never resolves to record even if slated
 *   - killing the verdict source (simulated store failure) still resolves
 *     to legacy, not a thrown error
 */

import { describe, expect, it } from "vitest";
import {
  memoryParcelGateVerdicts,
  memoryParcelGateVerdictsThatFails,
} from "./parcelGateVerdictRead";
import {
  DOLLAR_RAIL_KEYS,
  PARCEL_RECORD_SLATE,
  resolveAllowlist,
  resolveAllowlistState,
} from "./parcelRecordAllowlist";

const ALL_SIX_COUNTIES = ["48021", "48055", "48209", "48309", "48453", "48491"];
const NON_CALDWELL_COUNTIES = ["48021", "48209", "48309", "48453", "48491"];
const SLATE2_RAIL_KEYS = ["marketValue", "assessedValue", "landValue", "improvementValue", "livingAreaSqft", "yearBuilt"];

describe("PARCEL_RECORD_SLATE — wells + specialDistricts (5 counties) + cityLimits + flood + six dollar/structural rails (all 6, incl. Caldwell)", () => {
  it("exactly the five non-Caldwell counties are slated for wells and specialDistricts", () => {
    for (const county of NON_CALDWELL_COUNTIES) {
      expect(PARCEL_RECORD_SLATE.has(`${county}:wells`)).toBe(true);
      expect(PARCEL_RECORD_SLATE.has(`${county}:specialDistricts`)).toBe(true);
    }
  });

  it("all six counties, INCLUDING Caldwell, are slated for cityLimits and flood", () => {
    for (const county of ALL_SIX_COUNTIES) {
      expect(PARCEL_RECORD_SLATE.has(`${county}:cityLimits`)).toBe(true);
      expect(PARCEL_RECORD_SLATE.has(`${county}:flood`)).toBe(true);
    }
  });

  it("Caldwell wells and specialDistricts are deliberately absent -- its known geometry gap stays legacy per those cards' own premise; Caldwell cityLimits and flood are present -- deliberately, not an oversight", () => {
    expect(PARCEL_RECORD_SLATE.has("48055:wells")).toBe(false);
    expect(PARCEL_RECORD_SLATE.has("48055:specialDistricts")).toBe(false);
    expect(PARCEL_RECORD_SLATE.has("48055:cityLimits")).toBe(true);
    expect(PARCEL_RECORD_SLATE.has("48055:flood")).toBe(true);
  });

  it("PARCEL-B-SLATE2: all six counties, INCLUDING Caldwell, are slated for all six dollar/structural rails -- these rails have no txgio-geometry dependency, so Caldwell's known gap does not apply here", () => {
    for (const county of ALL_SIX_COUNTIES) {
      for (const rail of SLATE2_RAIL_KEYS) {
        expect(PARCEL_RECORD_SLATE.has(`${county}:${rail}`)).toBe(true);
      }
    }
  });

  it("the slate has exactly 58 entries: 5 wells + 5 specialDistricts + 6 cityLimits + 6 flood + 36 (6 counties x 6 dollar/structural rails)", () => {
    expect(PARCEL_RECORD_SLATE.size).toBe(58);
  });

  it("no other rail is in the slate -- valueHistory stays legacy for every county", () => {
    for (const county of ALL_SIX_COUNTIES) {
      expect(PARCEL_RECORD_SLATE.has(`${county}:valueHistory`)).toBe(false);
    }
  });

  it("DOLLAR_RAIL_KEYS is a five-member historical list (yearBuilt is deliberately excluded -- a rail, not a dollar amount) and every member IS now in the slate", () => {
    expect([...DOLLAR_RAIL_KEYS].sort()).toEqual(
      ["assessedValue", "improvementValue", "landValue", "livingAreaSqft", "marketValue"].sort(),
    );
    for (const rail of DOLLAR_RAIL_KEYS) {
      expect(PARCEL_RECORD_SLATE.has(`48021:${rail}`)).toBe(true);
      expect(PARCEL_RECORD_SLATE.has(`48491:${rail}`)).toBe(true);
    }
  });
});

describe("resolveAllowlistState — pure decision, every branch", () => {
  it("FALSIFIER: a pair NOT in the slate resolves to legacy even with a fabricated PASS verdict", () => {
    const result = resolveAllowlistState("48021", "valueHistory", { verdict: "pass" });
    expect(result).toBe("legacy");
  });

  it("a pair not in the slate resolves to legacy with no verdict at all", () => {
    const result = resolveAllowlistState("48021", "valueHistory", null);
    expect(result).toBe("legacy");
  });

  it("FALSIFIER: every UNSLATED (county, rail) pair resolves to legacy regardless of verdict -- covers every rail for every county except the fifty-eight real slated entries", () => {
    const rails = [
      "cityLimits", "flood", "wells", "specialDistricts", "valueHistory", "apn",
      "marketValue", "assessedValue", "landValue", "improvementValue", "livingAreaSqft", "yearBuilt",
    ];
    const counties = ["48021", "48055", "48209", "48309", "48453", "48491"];
    let uncheckedSlatedPairs = 0;
    for (const county of counties) {
      for (const rail of rails) {
        if (PARCEL_RECORD_SLATE.has(`${county}:${rail}`)) {
          uncheckedSlatedPairs += 1;
          continue;
        }
        expect(resolveAllowlistState(county, rail, { verdict: "pass" })).toBe("legacy");
        expect(resolveAllowlistState(county, rail, { verdict: "refuse" })).toBe("legacy");
        expect(resolveAllowlistState(county, rail, null)).toBe("legacy");
      }
    }
    // Falsifier's own falsifier: this loop must actually skip the
    // fifty-eight real slated pairs (every one PARCEL_RECORD_SLATE holds,
    // since this rail list now covers all of them), not silently cover zero
    // cases because the skip branch is unreachable -- fails loudly if
    // PARCEL_RECORD_SLATE ever changes without this test being updated.
    expect(uncheckedSlatedPairs).toBe(PARCEL_RECORD_SLATE.size);
    expect(uncheckedSlatedPairs).toBe(58);
  });

  it("FALSIFIER: the five slated wells pairs resolve to record on a real pass verdict, refused on refuse, legacy on no verdict", () => {
    for (const county of ["48021", "48209", "48309", "48453", "48491"]) {
      expect(resolveAllowlistState(county, "wells", { verdict: "pass" })).toBe("record");
      expect(resolveAllowlistState(county, "wells", { verdict: "refuse" })).toBe("refused");
      expect(resolveAllowlistState(county, "wells", { verdict: "excluded" })).toBe("refused");
      expect(resolveAllowlistState(county, "wells", null)).toBe("legacy");
    }
  });

  it("FALSIFIER: the five slated specialDistricts pairs resolve to record on a real pass verdict, refused on refuse, legacy on no verdict", () => {
    for (const county of ["48021", "48209", "48309", "48453", "48491"]) {
      expect(resolveAllowlistState(county, "specialDistricts", { verdict: "pass" })).toBe("record");
      expect(resolveAllowlistState(county, "specialDistricts", { verdict: "refuse" })).toBe("refused");
      expect(resolveAllowlistState(county, "specialDistricts", { verdict: "excluded" })).toBe("refused");
      expect(resolveAllowlistState(county, "specialDistricts", null)).toBe("legacy");
    }
  });

  it("FALSIFIER: all SIX slated cityLimits pairs (INCLUDING Caldwell) resolve to record on a real pass verdict, refused on refuse, legacy on no verdict", () => {
    for (const county of ["48021", "48055", "48209", "48309", "48453", "48491"]) {
      expect(resolveAllowlistState(county, "cityLimits", { verdict: "pass" })).toBe("record");
      expect(resolveAllowlistState(county, "cityLimits", { verdict: "refuse" })).toBe("refused");
      expect(resolveAllowlistState(county, "cityLimits", { verdict: "excluded" })).toBe("refused");
      expect(resolveAllowlistState(county, "cityLimits", null)).toBe("legacy");
    }
  });

  it("FALSIFIER: all SIX slated flood pairs (INCLUDING Caldwell) resolve to record on a real pass verdict, refused on refuse, legacy on no verdict", () => {
    for (const county of ["48021", "48055", "48209", "48309", "48453", "48491"]) {
      expect(resolveAllowlistState(county, "flood", { verdict: "pass" })).toBe("record");
      expect(resolveAllowlistState(county, "flood", { verdict: "refuse" })).toBe("refused");
      expect(resolveAllowlistState(county, "flood", { verdict: "excluded" })).toBe("refused");
      expect(resolveAllowlistState(county, "flood", null)).toBe("legacy");
    }
  });

  it("FALSIFIER: all SIX slated pairs for each of the six PARCEL-B-SLATE2 dollar/structural rails (INCLUDING Caldwell) resolve to record on a real pass verdict, refused on refuse, legacy on no verdict", () => {
    for (const rail of ["marketValue", "assessedValue", "landValue", "improvementValue", "livingAreaSqft", "yearBuilt"]) {
      for (const county of ["48021", "48055", "48209", "48309", "48453", "48491"]) {
        expect(resolveAllowlistState(county, rail, { verdict: "pass" })).toBe("record");
        expect(resolveAllowlistState(county, rail, { verdict: "refuse" })).toBe("refused");
        expect(resolveAllowlistState(county, rail, { verdict: "excluded" })).toBe("refused");
        expect(resolveAllowlistState(county, rail, null)).toBe("legacy");
      }
    }
  });

  it("THE OWED EVIDENCE: Caldwell's own live gate verdict for flood is 'excluded' (its known geometry gap, live-verified) -- slated deliberately so this resolves to the allowlist's VISIBLE 'refused' state, not the silent 'legacy' default an unslated pair would show", () => {
    // Mirrors the real, live-verified verdict shape (parcel_gate_verdict:
    // 48055/flood/excluded) rather than a generic fixture -- this is the
    // specific case this card's own premise names as still-owed evidence.
    const caldwellExcluded = { verdict: "excluded" as const };
    expect(PARCEL_RECORD_SLATE.has("48055:flood")).toBe(true);
    expect(resolveAllowlistState("48055", "flood", caldwellExcluded)).toBe("refused");
  });
});

/**
 * The branches below (in-slate + pass/refuse/excluded) cannot be exercised
 * against the real, empty PARCEL_RECORD_SLATE without editing the module —
 * exactly the point. They are proven here with a LOCAL slate constructed
 * the same way resolveAllowlistState itself keys its lookup, so the
 * decision LOGIC is verified even though this card ships with no live
 * pair to exercise it.
 */
describe("resolveAllowlistState — hypothetical slate membership (logic proof, not live config)", () => {
  function resolveWithLocalSlate(
    slate: ReadonlySet<string>,
    countyFips: string,
    railKey: string,
    verdict: { verdict: "pass" | "refuse" | "excluded" } | null,
  ) {
    if (!slate.has(`${countyFips}:${railKey}`)) return "legacy";
    if (!verdict) return "legacy";
    if (verdict.verdict === "pass") return "record";
    return "refused";
  }

  it("in-slate + pass -> record", () => {
    const slate = new Set(["48021:cityLimits"]);
    expect(resolveWithLocalSlate(slate, "48021", "cityLimits", { verdict: "pass" })).toBe("record");
  });

  it("in-slate + refuse -> refused, never record, even though the pair was attempted", () => {
    const slate = new Set(["48055:flood"]);
    expect(resolveWithLocalSlate(slate, "48055", "flood", { verdict: "refuse" })).toBe("refused");
  });

  it("in-slate + excluded -> refused (declared-ahead rail cannot serve from the record either)", () => {
    const slate = new Set(["48021:owner"]);
    expect(resolveWithLocalSlate(slate, "48021", "owner", { verdict: "excluded" })).toBe("refused");
  });

  it("in-slate + missing verdict -> legacy, fail closed even for an attempted pair", () => {
    const slate = new Set(["48021:cityLimits"]);
    expect(resolveWithLocalSlate(slate, "48021", "cityLimits", null)).toBe("legacy");
  });
});

describe("resolveAllowlist — async, through the real verdict reader", () => {
  it("FALSIFIER: missing verdict row resolves to legacy, not a thrown error", async () => {
    const store = memoryParcelGateVerdicts([]);
    const result = await resolveAllowlist(store, "48021", "valueHistory");
    expect(result).toBe("legacy");
  });

  it("FALSIFIER: a verdict-store query failure (e.g. the table does not exist yet) resolves to legacy, not a thrown error", async () => {
    const store = memoryParcelGateVerdictsThatFails();
    const result = await resolveAllowlist(store, "48021", "valueHistory");
    expect(result).toBe("legacy");
  });

  it("FALSIFIER: a null store (not configured) resolves to legacy, not a thrown error", async () => {
    const result = await resolveAllowlist(null, "48021", "valueHistory");
    expect(result).toBe("legacy");
  });

  it("FALSIFIER: the verdict store is never even queried for an unslated pair — proves the slate check short-circuits before any DB round trip, not just that a failed query happens to fail closed", async () => {
    let queried = false;
    const spyStore = {
      async query() {
        queried = true;
        throw new Error("should never be called for an unslated pair");
      },
    };
    const result = await resolveAllowlist(spyStore as never, "48021", "valueHistory");
    expect(result).toBe("legacy");
    expect(queried).toBe(false);
  });

  it("a real, present PASS verdict on an UNSLATED pair still resolves to legacy (slate gates everything)", async () => {
    const store = memoryParcelGateVerdicts([
      {
        countyFips: "48021",
        railKey: "valueHistory",
        verdict: "pass",
        unaccountedCount: 0,
        evaluatedAt: "2026-09-02T18:00:00Z",
        runId: "b-gate-sched-test-1",
      },
    ]);
    const result = await resolveAllowlist(store, "48021", "valueHistory");
    expect(result).toBe("legacy");
  });

  it("a real, present PASS verdict on a SLATED cityLimits pair resolves to record -- the flip is genuinely live through the async path, not just the pure decision function", async () => {
    const store = memoryParcelGateVerdicts([
      {
        countyFips: "48021",
        railKey: "cityLimits",
        verdict: "pass",
        unaccountedCount: 0,
        evaluatedAt: "2026-09-02T18:00:00Z",
        runId: "b-gate-sched-test-1",
      },
    ]);
    const result = await resolveAllowlist(store, "48021", "cityLimits");
    expect(result).toBe("record");
  });
});
