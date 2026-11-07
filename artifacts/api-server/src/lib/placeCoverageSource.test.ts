/**
 * P-205 / P-210 (2026-09-14). `retrievalApiCoverageSource` is the
 * production default `searchPlaceByPrefix` falls back to when no
 * coverage source is injected. Its endpoint does not exist server-side
 * yet (P-210: no derivation source reachable from this repo, blocked on
 * an operator ruling and a follow-on hauska-engine lane) — these tests
 * prove the fail-closed contract that makes shipping it today safe: every
 * failure mode (no key, no locality signal, network error, non-200,
 * malformed body) resolves `indeterminate`, NEVER `covered` and NEVER a
 * thrown exception. See `txgioAddressResolveCoverage.test.ts` for how the
 * consumer (`searchPlaceByPrefix`) turns this into a `find_parcel`
 * response.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COVERAGE_FETCH_BUDGET_MS,
  fetchCoverageFromRetrievalApi,
  retrievalApiCoverageSource,
} from "./placeCoverageSource";
import { retrievalBaseUrlUnsetReason } from "./retrievalEndpoint";

const ENV_KEYS = [
  "HAUSKA_RETRIEVAL_API_URL",
  "RETRIEVAL_API_URL",
  "BRIEF_RETRIEVAL_API_URL",
  "HAUSKA_RETRIEVAL_API_KEY",
  "RETRIEVAL_API_KEY",
  "BRIEF_RETRIEVAL_API_KEY",
] as const;

/**
 * D-25 (OPS-25, 2026-09-23). WHY THESE TESTS NOW NAME THE ENDPOINT.
 *
 * `beforeEach` deletes all six names, and until this lane each test set only the
 * KEY -- the ADDRESS came from the module's hardcoded Google Cloud default, which
 * production never overrode. So every test in this file that reached the HTTP
 * path was silently reading a host no one had named, and nothing in the suite
 * could see that the variable was unset. That is the same trap the deployment
 * specs were in (register 2.4), one layer up.
 *
 * The address is therefore explicit wherever the test means to exercise the HTTP
 * path. `retrieval-base-url-unset` -- key mounted, address unset -- is asserted
 * deliberately in its own test at the bottom of this file, so removing the
 * default cannot be undone without a red test either way.
 */
function configureRetrievalEndpoint(): void {
  process.env.HAUSKA_RETRIEVAL_API_URL = "https://retrieval.test.invalid";
  process.env.HAUSKA_RETRIEVAL_API_KEY = "test-key";
}

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
});

describe("retrievalApiCoverageSource (P-205 / P-210 fail-closed default)", () => {
  it("no locality signal at all resolves indeterminate WITHOUT a network call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    configureRetrievalEndpoint();

    const verdict = await retrievalApiCoverageSource.checkCoverage({
      city: null,
      state: null,
      zip: null,
      rawQuery: "some unparseable garbage",
    });

    expect(verdict.status).toBe("indeterminate");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no API key configured resolves indeterminate WITHOUT a network call — today's real default, since no follow-on endpoint is configured anywhere yet", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const verdict = await retrievalApiCoverageSource.checkCoverage({
      city: "KILLEEN",
      state: "TX",
      zip: "76541",
      rawQuery: "301 W Avenue B, Killeen, TX 76541",
    });

    expect(verdict.status).toBe("indeterminate");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a network error resolves indeterminate, never throws", async () => {
    configureRetrievalEndpoint();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );

    const verdict = await retrievalApiCoverageSource.checkCoverage({
      city: "KILLEEN",
      state: "TX",
      zip: "76541",
      rawQuery: "301 W Avenue B, Killeen, TX 76541",
    });

    expect(verdict).toEqual({
      status: "indeterminate",
      reason: "coverage endpoint call failed: ECONNREFUSED",
    });
  });

  it("a non-200 response resolves indeterminate, never covered", async () => {
    configureRetrievalEndpoint();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404 })),
    );

    const verdict = await retrievalApiCoverageSource.checkCoverage({
      city: "KILLEEN",
      state: "TX",
      zip: "76541",
      rawQuery: "301 W Avenue B, Killeen, TX 76541",
    });

    expect(verdict).toEqual({
      status: "indeterminate",
      reason: "coverage endpoint returned HTTP 404",
    });
  });

  it("a malformed body (no recognised status) resolves indeterminate", async () => {
    configureRetrievalEndpoint();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ garbage: true }) })),
    );

    const verdict = await retrievalApiCoverageSource.checkCoverage({
      city: "KILLEEN",
      state: "TX",
      zip: "76541",
      rawQuery: "301 W Avenue B, Killeen, TX 76541",
    });

    expect(verdict.status).toBe("indeterminate");
  });

  it("a not-covered body missing county fields resolves indeterminate rather than an incomplete claim", async () => {
    configureRetrievalEndpoint();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ status: "not-covered" }) })),
    );

    const verdict = await retrievalApiCoverageSource.checkCoverage({
      city: "KILLEEN",
      state: "TX",
      zip: "76541",
      rawQuery: "301 W Avenue B, Killeen, TX 76541",
    });

    expect(verdict.status).toBe("indeterminate");
  });

  it("a well-formed covered response is honored — proves the client is not permanently indeterminate by construction, only until a real endpoint exists", async () => {
    configureRetrievalEndpoint();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ status: "covered" }) })),
    );

    const verdict = await retrievalApiCoverageSource.checkCoverage({
      city: "BASTROP",
      state: "TX",
      zip: "78602",
      rawQuery: "147 Kahana Ln, Bastrop, TX 78602",
    });

    expect(verdict).toEqual({ status: "covered" });
  });

  it("a well-formed county-unconfirmed response is honored — never remapped to indeterminate / outage", async () => {
    configureRetrievalEndpoint();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          status: "county-unconfirmed",
          reason: "we can't confirm the county for this ZIP; add the full address",
        }),
      })),
    );

    const verdict = await retrievalApiCoverageSource.checkCoverage({
      city: "Georgetown",
      state: "TX",
      zip: "78633",
      rawQuery: "Georgetown, TX 78633",
    });

    expect(verdict).toEqual({
      status: "county-unconfirmed",
      reason: "we can't confirm the county for this ZIP; add the full address",
    });
    expect(verdict.status).not.toBe("indeterminate");
  });

  it("a well-formed not-covered response is honored", async () => {
    configureRetrievalEndpoint();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          status: "not-covered",
          countyFips: "48027",
          countyName: "Bell",
          state: "TX",
        }),
      })),
    );

    const verdict = await retrievalApiCoverageSource.checkCoverage({
      city: "KILLEEN",
      state: "TX",
      zip: "76541",
      rawQuery: "301 W Avenue B, Killeen, TX 76541",
    });

    expect(verdict).toEqual({
      status: "not-covered",
      countyFips: "48027",
      countyName: "Bell",
      state: "TX",
    });
  });

  it("D-25: key mounted but the ADDRESS unset resolves indeterminate whose reason NAMES the variable — never covered, never not-covered, never a throw, and no network call", async () => {
    // The state production was actually in for all four retrieval URL names
    // (register 2.4). Before D-25 this read the retired Google Cloud host.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    process.env.HAUSKA_RETRIEVAL_API_KEY = "test-key";

    const verdict = await retrievalApiCoverageSource.checkCoverage({
      city: "BASTROP",
      state: "TX",
      zip: "78602",
      rawQuery: "147 Kahana Ln, Bastrop, TX 78602",
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(verdict).toEqual({
      status: "indeterminate",
      reason: retrievalBaseUrlUnsetReason(),
    });
    const reason = (verdict as { reason: string }).reason;
    for (const name of ["HAUSKA_RETRIEVAL_API_URL", "RETRIEVAL_API_URL", "BRIEF_RETRIEVAL_API_URL"]) {
      expect(reason).toContain(name);
    }
    // "the address is unset" must not read as "a call failed": no call was
    // attempted, and the two send a reader after different things.
    expect(reason).not.toMatch(/call failed/);
  });
});

/**
 * P-479. THE BUDGET THIS CLIENT DID NOT HAVE.
 *
 * `fetch` was called with no `signal`, so this tier waited as long as the server
 * wanted -- and the server's own deadline was 150_000 ms while the PE Find box
 * that calls it aborts at 9_000. The customer-visible result on `coverage:austin`
 * was `coverage_check_unavailable: cortex timed out after 9000ms`, which blames
 * cortex for a 71-second sequential scan two tiers below it.
 *
 * Both tests below FAIL on main: the first hangs until vitest kills it (there is
 * no abort to observe), the second cannot import a constant that does not exist.
 */
describe("retrievalApiCoverageSource budget (P-479)", () => {
  it("a server that never answers resolves indeterminate at the budget, naming the budget (FAILS ON MAIN: no timeout, so this hangs)", async () => {
    // A fetch that settles only when aborted. On main nothing aborts it, so this
    // promise never resolves and the test times out instead of asserting -- which
    // is exactly the production behaviour being fixed.
    vi.stubGlobal("fetch", (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      }),
    );
    configureRetrievalEndpoint();

    const started = Date.now();
    const verdict = await fetchCoverageFromRetrievalApi(
      { city: "AUSTIN", state: "TX", zip: "78701", rawQuery: "99999 ZZYZX RD, AUSTIN, TX 78701" },
      40, // a 40ms budget, so the abort path is tested in milliseconds
    );
    const elapsed = Date.now() - started;

    expect(verdict.status).toBe("indeterminate");
    if (verdict.status === "indeterminate") {
      // The reason must name the BUDGET, not a bare transport error: "did not
      // answer within 40ms" and "could not be reached" send a reader to two
      // different tiers, and collapsing them is how this cause stayed hidden.
      expect(verdict.reason).toContain("did not answer within 40ms");
      expect(verdict.reason).not.toMatch(/call failed/);
    }
    // It really did give up at the budget rather than at some later ceiling.
    expect(elapsed).toBeLessThan(2_000);
  });

  it("the budget is smaller than the PE Find box ceiling that aborts this whole call", () => {
    // hauska-map `apps/property-explorer/api/pe-situs-search.ts` UPSTREAM_TIMEOUT_MS.
    // Asserted as an inequality with its reason, not as a second copy of 9_000
    // pretending to be a source of truth.
    const PE_FIND_BOX_UPSTREAM_TIMEOUT_MS = 9_000;
    expect(COVERAGE_FETCH_BUDGET_MS).toBeLessThan(PE_FIND_BOX_UPSTREAM_TIMEOUT_MS);
    expect(COVERAGE_FETCH_BUDGET_MS).toBeGreaterThan(0);
  });

  it("a real transport failure is still reported as itself, not as a budget expiry", async () => {
    // The two branches must stay distinguishable in both directions: proving the
    // new one fires is worth nothing if it swallows the old one.
    vi.stubGlobal("fetch", () => Promise.reject(new Error("ECONNREFUSED")));
    configureRetrievalEndpoint();

    const verdict = await fetchCoverageFromRetrievalApi(
      { city: "AUSTIN", state: "TX", zip: "78701", rawQuery: "x" },
      40,
    );

    expect(verdict.status).toBe("indeterminate");
    if (verdict.status === "indeterminate") {
      expect(verdict.reason).toContain("call failed");
      expect(verdict.reason).toContain("ECONNREFUSED");
      expect(verdict.reason).not.toMatch(/did not answer within/);
    }
  });

  it("a fast, well-formed answer is unaffected by the budget existing", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve({ ok: true, status: 200, json: async () => ({ status: "covered" }) }),
    );
    configureRetrievalEndpoint();

    const verdict = await fetchCoverageFromRetrievalApi(
      { city: "AUSTIN", state: "TX", zip: "78701", rawQuery: "x" },
      40,
    );

    expect(verdict).toEqual({ status: "covered" });
  });
});
