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
import { retrievalApiCoverageSource } from "./placeCoverageSource";
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
