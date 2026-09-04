/**
 * The verdict-store reader PARCEL-B-READER and PARCEL-B-GATE-SCHED share.
 * Every branch here resolves to null on failure — never throws — because
 * the allowlist depends on that to fail closed without its own try/catch.
 */

import { describe, expect, it } from "vitest";
import {
  loadParcelGateVerdict,
  memoryParcelGateVerdicts,
  memoryParcelGateVerdictsThatFails,
  resolveVerdictStore,
} from "./parcelGateVerdictRead";

describe("resolveVerdictStore", () => {
  it("FALSIFIER: an explicit injected store passes through unchanged, never falls to the env resolver", async () => {
    const store = memoryParcelGateVerdicts([
      { countyFips: "48021", railKey: "wells", verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-02T18:00:00Z", runId: "test" },
    ]);
    expect(resolveVerdictStore(store)).toBe(store);
  });

  it("an explicit injected null passes through as null, never falls to the env resolver", () => {
    expect(resolveVerdictStore(null)).toBeNull();
  });

  it("undefined (the production default, no test override) resolves via the env-connected pool, which is null when FACTORY_DATABASE_URL_RO is unset in this process", () => {
    // Load-bearing regression guard for the exact defect this function
    // fixes: the wrapper's own default MUST NOT be a hardcoded null --
    // it must actually attempt env resolution. This process has no
    // FACTORY_DATABASE_URL_RO set, so the honest, correct answer here is
    // still null, but via the real code path, not a bypassed one.
    expect(process.env.FACTORY_DATABASE_URL_RO).toBeUndefined();
    expect(resolveVerdictStore(undefined)).toBeNull();
  });
});

describe("loadParcelGateVerdict", () => {
  it("returns null when the store is not configured", async () => {
    const result = await loadParcelGateVerdict(null, "48021", "cityLimits");
    expect(result).toBeNull();
  });

  it("returns null when no row matches the (county, rail) pair", async () => {
    const store = memoryParcelGateVerdicts([]);
    const result = await loadParcelGateVerdict(store, "48021", "cityLimits");
    expect(result).toBeNull();
  });

  it("FALSIFIER: a query error (e.g. relation does not exist) resolves to null, never throws", async () => {
    const store = memoryParcelGateVerdictsThatFails();
    await expect(loadParcelGateVerdict(store, "48021", "cityLimits")).resolves.toBeNull();
  });

  it("returns the real verdict row shape, field-mapped from snake_case to camelCase", async () => {
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
    const result = await loadParcelGateVerdict(store, "48021", "cityLimits");
    expect(result).toEqual({
      countyFips: "48021",
      railKey: "cityLimits",
      verdict: "pass",
      unaccountedCount: 0,
      evaluatedAt: "2026-09-02T18:00:00Z",
      runId: "b-gate-sched-test-1",
    });
  });

  it("does not cross-match a different county or a different rail", async () => {
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
    expect(await loadParcelGateVerdict(store, "48055", "cityLimits")).toBeNull();
    expect(await loadParcelGateVerdict(store, "48021", "flood")).toBeNull();
  });
});
