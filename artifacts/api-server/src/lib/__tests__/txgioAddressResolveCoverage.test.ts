/**
 * P-107 / OPS-16 A-072. `find_parcel` collapsed two honest opposites into
 * the same `no-hit`: an address genuinely outside Smart Site's coverage
 * (e.g. Phoenix, AZ) and an address inside coverage with no matching
 * parcel (e.g. a real Bastrop address). Measured live: the Phoenix query
 * returned `{"hits":[],"missClass":"no-hit"}`, indistinguishable from a
 * typo or a nonexistent address.
 *
 * These tests prove `searchPlaceByPrefix` fires `out_of_coverage` BEFORE
 * touching the store OR the coverage source for an out-of-state query (both
 * mocks below throw if invoked, proving the short-circuit), and that an
 * in-coverage query with nothing on file is unaffected when a coverage
 * source CONFIRMS coverage.
 *
 * P-205 / P-210 (2026-09-14) extend this file. The ORIGINAL bug this repo
 * still has: a Texas county absent from the six-county serving ledger
 * (measured example: Bell County / Killeen 76541) returns the same bare
 * `no-hit` an in-coverage genuine miss gets — `out_of_coverage` above is
 * STATE-scoped only and never fires for an unonboarded Texas county.
 * P-210 then found that no source reachable from this repo can DERIVE
 * county-level serving-ledger membership without either a hand-maintained
 * list (the exact anti-pattern P-205 exists to prevent) or a new
 * `hauska-engine` endpoint this lane does not own — so the real fix is
 * blocked pending that follow-on lane and an operator ruling on which of
 * three disagreeing coverage sets is canonical (P-210).
 *
 * Operator ruling (2026-09-14), unblocking the SAFE half of this work: the
 * coverage decision must be injected via `CoverageSource`
 * (`placeCoverageSource.ts`), and with no coverage source able to answer,
 * `searchPlaceByPrefix` MUST FAIL CLOSED — decline
 * (`coverage_check_unavailable`), never fall through to the positive claim
 * `no-hit`, and never assume covered. This changes the ORIGINAL "genuine
 * in-coverage no-match still returns plain no-hit — no regression" test
 * below: that guarantee now holds only when a coverage source actually
 * CONFIRMS coverage (tested explicitly with an injected fake), not
 * implicitly by default. A new describe block below tests the fail-closed
 * default itself — today's real production behavior, since no real
 * coverage source exists server-side yet.
 */

import { describe, it, expect, vi } from "vitest";
import type { CoverageSource, CoverageVerdict } from "../placeCoverageSource";

vi.mock("@workspace/db", () => ({
  db: {},
  txgioParcel: {
    countyFips: "county_fips",
    propId: "prop_id",
    situsAddress: "situs_address",
  },
  txgioAddress: {
    countyFips: "county_fips",
    fullAddr: "full_addr",
    postComm: "post_comm",
    state: "state",
    postCode: "post_code",
    latitude: "latitude",
    longitude: "longitude",
  },
}));

vi.mock("../brokerageTxParcels", () => ({
  allStoreCounties: () => [],
}));

const { searchPlaceByPrefix } = await import("../txgioAddressResolve");

/** A DB that fails the test if ANY query reaches it. */
function unreachableDb() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            throw new Error(
              "searchPlaceByPrefix must not query the store for an out-of-coverage address",
            );
          },
        }),
      }),
    }),
  };
}

/** A DB that always returns empty rows (genuine in-coverage no-match). */
function emptyDb() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [],
        }),
      }),
    }),
  };
}

/** Fails the test if the coverage source is invoked at all — proves a path short-circuits before ever needing a coverage answer (a real hit, an out-of-state query, or a budget exhaustion). */
function unreachableCoverageSource(): CoverageSource {
  return {
    checkCoverage: async () => {
      throw new Error(
        "searchPlaceByPrefix must not invoke the coverage source on this path",
      );
    },
  };
}

/** A coverage source that always resolves the given fixed verdict, ignoring its input. */
function fixedCoverageSource(verdict: CoverageVerdict): CoverageSource {
  return { checkCoverage: async () => verdict };
}

describe("searchPlaceByPrefix out-of-coverage vs in-coverage no-match (P-107 / OPS-16 A-072)", () => {
  it("an out-of-coverage address (Phoenix, AZ) returns out_of_coverage without touching the store or the coverage source", async () => {
    const result = await searchPlaceByPrefix({
      query: "1600 E Camelback Rd, Phoenix, AZ",
      database: unreachableDb() as never,
      coverageSource: unreachableCoverageSource(),
    });
    expect(result).toEqual({
      hits: [],
      missClass: "out_of_coverage",
      outOfCoverageState: "AZ",
    });
    // The exact defect measured: this must never collapse to the bare
    // no-hit an out-of-coverage query used to get.
    expect(result.missClass).not.toBe("no-hit");
  });

  it("an out-of-coverage address with a ZIP still resolves the state, not the ZIP", async () => {
    const result = await searchPlaceByPrefix({
      query: "1600 E Camelback Rd, Phoenix, AZ 85016",
      database: unreachableDb() as never,
      coverageSource: unreachableCoverageSource(),
    });
    expect(result).toEqual({
      hits: [],
      missClass: "out_of_coverage",
      outOfCoverageState: "AZ",
    });
  });

  it("a genuine in-coverage no-match still returns plain no-hit when a coverage source CONFIRMS coverage — no regression", async () => {
    const result = await searchPlaceByPrefix({
      query: "147 Kahana Ln, Bastrop, TX",
      database: emptyDb() as never,
      coverageSource: fixedCoverageSource({ status: "covered" }),
    });
    expect(result).toEqual({ hits: [], missClass: "no-hit" });
  });

  it("an in-coverage query naming TX explicitly is not treated as out of coverage, when coverage is confirmed", async () => {
    const result = await searchPlaceByPrefix({
      query: "908 Pine St, Bastrop, TX 78602",
      database: emptyDb() as never,
      coverageSource: fixedCoverageSource({ status: "covered" }),
    });
    expect(result.missClass).toBe("no-hit");
    expect(result).not.toHaveProperty("outOfCoverageState");
  });

  it("a query with no parsed state at all still runs the ordinary search (no false positive), when coverage is confirmed", async () => {
    const result = await searchPlaceByPrefix({
      query: "147 Kahana Ln, Bastrop",
      database: emptyDb() as never,
      coverageSource: fixedCoverageSource({ status: "covered" }),
    });
    expect(result).toEqual({ hits: [], missClass: "no-hit" });
  });

  it("a real hit short-circuits before the coverage source is ever invoked", async () => {
    const hitDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                countyFips: "48021",
                propId: "31358",
                situsAddress: "147 KAHANA LN, BASTROP, TX, 78602",
              },
            ],
          }),
        }),
      }),
    };
    const result = await searchPlaceByPrefix({
      query: "147 Kahana Ln, Bastrop, TX",
      database: hitDb as never,
      coverageSource: unreachableCoverageSource(),
    });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.missClass).toBeUndefined();
  });
});

/**
 * P-205 / P-210 (2026-09-14). The fail-closed contract itself: absent a
 * coverage source that can positively confirm or deny coverage,
 * `searchPlaceByPrefix` must decline rather than claim `no-hit` (a false
 * "looked, in coverage, found nothing") or silently proceed as if covered.
 * Falsifiers named in the P-205 dispatch, each proven here in both
 * directions: (1) the decline must never fire when coverage IS confirmed
 * (tested above — still plain no-hit); (2) it must fire whenever coverage
 * cannot be determined, for ANY reason a real source can fail — no
 * configuration, an explicit ambiguous/indeterminate verdict, or the
 * source itself misbehaving.
 */
describe("P-205 / P-210: fail-closed coverage decline (operator ruling, 2026-09-14)", () => {
  it("no coverage source injected — today's real production default before the follow-on hauska-engine endpoint exists — declines rather than claims no-hit", async () => {
    const result = await searchPlaceByPrefix({
      query: "301 W Avenue B, Killeen, TX 76541",
      database: emptyDb() as never,
      // No coverageSource passed: falls back to the real
      // retrievalApiCoverageSource, which has no key configured in this
      // test environment and resolves indeterminate WITHOUT a network call
      // (see placeCoverageSource.test.ts for that guarantee tested
      // directly).
    });
    expect(result.hits).toEqual([]);
    expect(result.missClass).toBe("coverage_check_unavailable");
    expect(result.missClass).not.toBe("no-hit");
    expect(typeof result.coverageCheckUnavailableReason).toBe("string");
  });

  it("an explicit indeterminate verdict (e.g. a real source that cannot resolve an ambiguous locality) declines, never no-hit, never covered", async () => {
    const result = await searchPlaceByPrefix({
      query: "1 Main St, 75001",
      database: emptyDb() as never,
      coverageSource: fixedCoverageSource({
        status: "indeterminate",
        reason: "ZIP 75001 spans two counties",
      }),
    });
    expect(result).toEqual({
      hits: [],
      missClass: "coverage_check_unavailable",
      coverageCheckUnavailableReason: "ZIP 75001 spans two counties",
    });
  });

  it("a coverage source that throws also fails closed rather than crashing the request or defaulting to no-hit", async () => {
    const throwingSource: CoverageSource = {
      checkCoverage: async () => {
        throw new Error("simulated coverage source outage");
      },
    };
    const result = await searchPlaceByPrefix({
      query: "301 W Avenue B, Killeen, TX 76541",
      database: emptyDb() as never,
      coverageSource: throwingSource,
    });
    expect(result.hits).toEqual([]);
    expect(result.missClass).toBe("coverage_check_unavailable");
    expect(result.coverageCheckUnavailableReason).toMatch(/simulated coverage source outage/);
  });

  it("a real, confirmed NOT-COVERED verdict names the county — the fix this lane cannot ship yet, proven ready for the day a real source exists", async () => {
    const result = await searchPlaceByPrefix({
      query: "301 W Avenue B, Killeen, TX 76541",
      database: emptyDb() as never,
      coverageSource: fixedCoverageSource({
        status: "not-covered",
        countyFips: "48027",
        countyName: "Bell",
        state: "TX",
      }),
    });
    expect(result).toEqual({
      hits: [],
      missClass: "county_out_of_coverage",
      outOfCoverageCounty: { countyFips: "48027", countyName: "Bell", state: "TX" },
    });
    expect(result.missClass).not.toBe("no-hit");
  });

  it("budget exhaustion still short-circuits before the coverage source is ever invoked", async () => {
    const neverResolvingDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => new Promise(() => {}), // never resolves
          }),
        }),
      }),
    };
    const result = await searchPlaceByPrefix({
      query: "908 Pine St, Bastrop, TX 78602",
      database: neverResolvingDb as never,
      budgetMs: 1,
      coverageSource: unreachableCoverageSource(),
    });
    expect(result.missClass).not.toBe("coverage_check_unavailable");
  });
});
