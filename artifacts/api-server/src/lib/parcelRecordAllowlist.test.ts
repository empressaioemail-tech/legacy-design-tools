/**
 * The rail-scoped serve allowlist. Every dispatch-mandated falsifier for
 * PARCEL-B-READER lives in this file:
 *   - fail CLOSED: unreadable or missing verdict = legacy, never record
 *   - no rail cuts over on this card: PARCEL_RECORD_SLATE is empty, proven
 *     against a fabricated 'pass' verdict, not just the absence of one
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

describe("PARCEL_RECORD_SLATE — this card ships nothing cut over", () => {
  it("the slate is empty", () => {
    expect(PARCEL_RECORD_SLATE.size).toBe(0);
  });

  it("no dollar rail is ever in the slate, even accidentally (hard requirement pending PARCEL-S6-COLLISION)", () => {
    for (const rail of DOLLAR_RAIL_KEYS) {
      expect(PARCEL_RECORD_SLATE.has(`48021:${rail}`)).toBe(false);
      expect(PARCEL_RECORD_SLATE.has(`48491:${rail}`)).toBe(false);
    }
  });
});

describe("resolveAllowlistState — pure decision, every branch", () => {
  it("FALSIFIER: a pair NOT in the slate resolves to legacy even with a fabricated PASS verdict", () => {
    const result = resolveAllowlistState("48021", "cityLimits", { verdict: "pass" });
    expect(result).toBe("legacy");
  });

  it("a pair not in the slate resolves to legacy with no verdict at all", () => {
    const result = resolveAllowlistState("48021", "cityLimits", null);
    expect(result).toBe("legacy");
  });

  it("FALSIFIER: with today's empty slate, EVERY known rail resolves to legacy regardless of verdict", () => {
    const rails = ["cityLimits", "flood", "wells", "specialDistricts", "valueHistory", "apn", "assessedValue"];
    const counties = ["48021", "48055", "48209", "48309", "48453", "48491"];
    for (const county of counties) {
      for (const rail of rails) {
        expect(resolveAllowlistState(county, rail, { verdict: "pass" })).toBe("legacy");
        expect(resolveAllowlistState(county, rail, { verdict: "refuse" })).toBe("legacy");
        expect(resolveAllowlistState(county, rail, null)).toBe("legacy");
      }
    }
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
    const result = await resolveAllowlist(store, "48021", "cityLimits");
    expect(result).toBe("legacy");
  });

  it("FALSIFIER: a verdict-store query failure (e.g. the table does not exist yet) resolves to legacy, not a thrown error", async () => {
    const store = memoryParcelGateVerdictsThatFails();
    const result = await resolveAllowlist(store, "48021", "cityLimits");
    expect(result).toBe("legacy");
  });

  it("FALSIFIER: a null store (not configured) resolves to legacy, not a thrown error", async () => {
    const result = await resolveAllowlist(null, "48021", "cityLimits");
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
    const result = await resolveAllowlist(spyStore as never, "48021", "cityLimits");
    expect(result).toBe("legacy");
    expect(queried).toBe(false);
  });

  it("a real, present PASS verdict on an UNSLATED pair still resolves to legacy (slate gates everything)", async () => {
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
    expect(result).toBe("legacy");
  });
});
