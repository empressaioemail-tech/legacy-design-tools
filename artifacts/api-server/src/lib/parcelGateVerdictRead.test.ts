/**
 * The verdict-store reader PARCEL-B-READER and PARCEL-B-GATE-SCHED share.
 * Every branch here resolves to null on failure — never throws — because
 * the allowlist depends on that to fail closed without its own try/catch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadParcelGateVerdict,
  memoryParcelGateVerdicts,
  memoryParcelGateVerdictsThatFails,
  resetUnrecognisedVerdictLogForTests,
  resolveVerdictStore,
} from "./parcelGateVerdictRead";
import { PARCEL_RECORD_SLATE, resolveAllowlist } from "./parcelRecordAllowlist";

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

  it("undefined (the production default, no test override) resolves via the env-connected adapter, which is null when no retrieval API key is set in this process", () => {
    // Load-bearing regression guard for the exact defect this function
    // fixes: the wrapper's own default MUST NOT be a hardcoded null --
    // it must actually attempt env resolution. P-152 repointed the real
    // resolver from a Postgres pool (FACTORY_DATABASE_URL_RO) to an HTTP
    // adapter over the Hauska retrieval service (RETRIEVAL_API_KEY /
    // HAUSKA_RETRIEVAL_API_KEY); this process has neither set, so the
    // honest, correct answer here is still null, but via the real code
    // path, not a bypassed one.
    expect(process.env.RETRIEVAL_API_KEY).toBeUndefined();
    expect(process.env.HAUSKA_RETRIEVAL_API_KEY).toBeUndefined();
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

/**
 * P-293: the factory's P-201 vocabulary (migration 0011a). Before this card
 * all three `excluded-*` strings failed `isVerdictKind`, so a slated pair on
 * one of them resolved 'legacy' instead of the 'refused' the bare 'excluded'
 * has always given -- a serve-state change nobody decided, and silent.
 */
describe("the factory's excluded-* verdict kinds (P-293)", () => {
  const EXCLUDED_KINDS = [
    "excluded-not-applicable",
    "excluded-mid-cutover",
    "excluded-no-acquisition-path",
  ] as const;

  /** A real slated pair, taken from the slate itself so this cannot pass against a slate that no longer holds it. */
  const [countyFips, railKey] = [...PARCEL_RECORD_SLATE][0].split(":").slice(0, 2);

  const rowWith = (verdict: string) => ({
    countyFips,
    railKey,
    verdict,
    unaccountedCount: 0,
    evaluatedAt: "2026-09-16T00:00:00Z",
    runId: "p293-test",
  });

  let warnSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    resetUnrecognisedVerdictLogForTests();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy?.mockRestore();
    warnSpy = null;
    resetUnrecognisedVerdictLogForTests();
  });

  it("FALSIFIER 1a: the reader READS an excluded-* row instead of dropping it as 'no usable verdict', and carries the kind through unchanged", async () => {
    for (const kind of EXCLUDED_KINDS) {
      const store = memoryParcelGateVerdicts([rowWith(kind)]);
      const result = await loadParcelGateVerdict(store, countyFips, railKey);
      expect(result).not.toBeNull();
      expect(result?.verdict).toBe(kind);
    }
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("FALSIFIER 1b: end to end through resolveAllowlist, a slated pair on an excluded-* verdict resolves 'refused' -- and pass/refuse are untouched", async () => {
    for (const kind of EXCLUDED_KINDS) {
      const store = memoryParcelGateVerdicts([rowWith(kind)]);
      expect(await resolveAllowlist(store, countyFips, railKey)).toBe("refused");
    }
    expect(await resolveAllowlist(memoryParcelGateVerdicts([rowWith("pass")]), countyFips, railKey)).toBe(
      "record",
    );
    expect(
      await resolveAllowlist(memoryParcelGateVerdicts([rowWith("refuse")]), countyFips, railKey),
    ).toBe("refused");
    expect(
      await resolveAllowlist(memoryParcelGateVerdicts([rowWith("excluded")]), countyFips, railKey),
    ).toBe("refused");
  });

  it("FALSIFIER 2: an unrecognised string still fails closed to 'legacy', and is now LOUD -- logging the county, the rail and the raw string, once", async () => {
    const raw = "excluded-made-up-state";
    const store = memoryParcelGateVerdicts([rowWith(raw)]);

    expect(await resolveAllowlist(store, countyFips, railKey)).toBe("legacy");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = (warnSpy?.mock.calls[0] ?? []).map((part) => String(part)).join(" ");
    expect(logged).toContain(countyFips);
    expect(logged).toContain(railKey);
    expect(logged).toContain(raw);
    expect(logged).toContain("9171279");

    // Loud once per finding, not once per request: the same triple stays quiet...
    expect(await resolveAllowlist(store, countyFips, railKey)).toBe("legacy");
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // ...while a different unrecognised string is a different finding.
    const other = memoryParcelGateVerdicts([rowWith("excluded-other-invention")]);
    expect(await loadParcelGateVerdict(other, countyFips, railKey)).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(2);
    const secondLogged = (warnSpy?.mock.calls[1] ?? []).map((part) => String(part)).join(" ");
    expect(secondLogged).toContain("excluded-other-invention");
  });

  it("stays quiet for the accepted vocabulary -- no new noise on the happy path", async () => {
    const store = memoryParcelGateVerdicts([rowWith("excluded-no-acquisition-path")]);
    expect((await loadParcelGateVerdict(store, countyFips, railKey))?.verdict).toBe(
      "excluded-no-acquisition-path",
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
