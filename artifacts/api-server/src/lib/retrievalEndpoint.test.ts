/**
 * D-25 (OPS-25, 2026-09-23). NO RETRIEVAL OR BILLING-ORIGIN DEFAULT, VERIFIED
 * BY VIOLATION.
 *
 * The defect this file exists for: four retrieval readers and one billing URL
 * helper each ended their environment resolution with a hardcoded literal on the
 * closed Google Cloud estate, so a spec built from the GCP capture -- which
 * records only the variables production SET -- booted cleanly and silently
 * called a corpse. Deleting the literal is the change; these tests are the
 * control that the deletion is real and that the whole point of it holds, which
 * is that an unset variable REFUSES BY NAME rather than falling through.
 *
 * Read the assertions in the violation direction. Each one is written so that
 * putting the literal back makes it RED:
 *
 *   - `RetrievalBaseUrlUnsetError` is raised by the four readers when the key is
 *     mounted and the ADDRESS is unset. Restore a default host and the call
 *     succeeds against it instead of rejecting.
 *   - `BillingPublicBaseUrlUnsetError` is raised by the billing helper. Restore a
 *     default and it returns that host instead of throwing.
 *   - the coverage source keeps its three-valued vocabulary and reports
 *     `indeterminate` NAMING the variable -- never `covered`, never
 *     `not-covered`, and never a throw.
 *
 * The closed host's literal is deliberately absent from this file: every
 * assertion is made through the refusal's NAME, so this file keeps its meaning
 * if the host changes, and a repo-wide grep for the dead host returns only
 * tests that assert its ABSENCE rather than notes about it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* The two readers this lane's district test reaches are mocked to their
 * "no answer" values, so the ONLY thing left that can decide the outcome is the
 * environment resolution under test. */
vi.mock("../routes/brokerageNodeFacets", () => ({
  loadBakedNodeFacetSnapshot: vi.fn(async () => null),
}));
vi.mock("./zoningFactServeCutover", () => ({
  loadZoningFactForServe: vi.fn(async () => null),
}));

import { fetchPropertyAtomChain } from "./buildableEnvelope/fetchPropertyAtomChain";
import { resolveSpineZoningWhenGisAbsent } from "./buildableEnvelope/spineZoningDistrict";
import { fetchGateVerdict, fetchParcelRecord } from "./parcelRecordReaderClient";
import { retrievalApiCoverageSource } from "./placeCoverageSource";
import {
  RETRIEVAL_BASE_URL_ENV_NAMES,
  RetrievalBaseUrlUnsetError,
  requireRetrievalBaseUrl,
  retrievalBaseUrlFromEnv,
} from "./retrievalEndpoint";
import {
  BillingPublicBaseUrlUnsetError,
  brokerageBillingPublicBaseUrl,
  defaultCheckoutSuccessUrl,
} from "./brokerageBillingUrls";

const ENV_NAMES = [
  ...RETRIEVAL_BASE_URL_ENV_NAMES,
  "HAUSKA_RETRIEVAL_API_KEY",
  "RETRIEVAL_API_KEY",
  "BRIEF_RETRIEVAL_API_KEY",
  "BROKERAGE_BILLING_PUBLIC_BASE_URL",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const name of ENV_NAMES) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  vi.unstubAllGlobals();
});

describe("retrieval base URL resolution — no default", () => {
  it("an unset variable resolves to null, never to a host", () => {
    expect(retrievalBaseUrlFromEnv()).toBeNull();
  });

  it("requireRetrievalBaseUrl refuses by name, and the refusal carries the names to set", () => {
    let thrown: unknown;
    try {
      requireRetrievalBaseUrl();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RetrievalBaseUrlUnsetError);
    const err = thrown as RetrievalBaseUrlUnsetError;
    expect(err.name).toBe("RetrievalBaseUrlUnsetError");
    expect(err.refusal).toBe("retrieval-base-url-unset");
    for (const name of RETRIEVAL_BASE_URL_ENV_NAMES) expect(err.message).toContain(name);
  });

  it("the configured value is used verbatim, with trailing slashes trimmed, and still no default behind it", () => {
    process.env.BRIEF_RETRIEVAL_API_URL = "https://retrieval.test.invalid/";
    expect(retrievalBaseUrlFromEnv()).toBe("https://retrieval.test.invalid");
    expect(requireRetrievalBaseUrl()).toBe("https://retrieval.test.invalid");
  });
});

describe("fetchPropertyAtomChain — refuses by name when the address is unset", () => {
  it("VIOLATION: key mounted, address unset -> named refusal, and NO network call", async () => {
    process.env.BRIEF_RETRIEVAL_API_KEY = "brief-key";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(fetchPropertyAtomChain("48021:34049")).rejects.toThrowError(
      RetrievalBaseUrlUnsetError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("CONTROL: no key at all still resolves null, the module's pre-existing unarmed-reader contract", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(fetchPropertyAtomChain("48021:34049")).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("CONTROL: both mounted still reads the configured host, so the refusal did not eat the real path", async () => {
    process.env.BRIEF_RETRIEVAL_API_KEY = "brief-key";
    process.env.BRIEF_RETRIEVAL_API_URL = "https://retrieval.test.invalid";
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await fetchPropertyAtomChain("48021:34049");
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(
      "https://retrieval.test.invalid/property-nodes/48021%3A34049/atom-chain",
    );
  });
});

describe("spineZoningDistrict — refuses by name when the address is unset", () => {
  it("VIOLATION: key mounted, address unset -> named refusal, never a null that reads as 'no district'", async () => {
    process.env.BRIEF_RETRIEVAL_API_KEY = "brief-key";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      resolveSpineZoningWhenGisAbsent("48209:150937", null),
    ).rejects.toThrowError(RetrievalBaseUrlUnsetError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("CONTROL: no key still resolves null (the unarmed-reader contract is untouched)", async () => {
    await expect(resolveSpineZoningWhenGisAbsent("48209:150937", null)).resolves.toBeNull();
  });
});

describe("parcelRecordReaderClient — refuses by name when the address is unset", () => {
  it("VIOLATION: fetchParcelRecord rejects by name rather than resolving null ('the store says no')", async () => {
    process.env.RETRIEVAL_API_KEY = "test-key";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(fetchParcelRecord("48021:34049")).rejects.toThrowError(
      RetrievalBaseUrlUnsetError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("VIOLATION: fetchGateVerdict rejects by name rather than resolving undefined ('the query failed')", async () => {
    process.env.RETRIEVAL_API_KEY = "test-key";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(fetchGateVerdict("48021", "cityLimits")).rejects.toThrowError(
      RetrievalBaseUrlUnsetError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("CONTROL: no key still resolves null / undefined, unchanged", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(fetchParcelRecord("48021:34049")).resolves.toBeNull();
    await expect(fetchGateVerdict("48021", "cityLimits")).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("placeCoverageSource — a structured refusal, still indeterminate, never a verdict", () => {
  it("VIOLATION: address unset -> indeterminate whose reason NAMES the variable; never covered, never not-covered, never a throw", async () => {
    process.env.BRIEF_RETRIEVAL_API_KEY = "brief-key";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const verdict = await retrievalApiCoverageSource.checkCoverage({
      city: "BASTROP",
      state: "TX",
      zip: "78602",
      rawQuery: "251 Cool Water Dr, Bastrop, TX 78602",
    });

    expect(verdict.status).toBe("indeterminate");
    expect(verdict).toHaveProperty("reason");
    const reason = (verdict as { reason: string }).reason;
    for (const name of RETRIEVAL_BASE_URL_ENV_NAMES) expect(reason).toContain(name);
    // The refusal says the address is unset, NOT that a call failed: no call was
    // attempted, and conflating the two sends a reader after the wrong thing.
    expect(reason).not.toMatch(/call failed/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("brokerageBillingUrls — the Stripe return origin has no default", () => {
  it("VIOLATION: unset -> named refusal, and it is raised when the return URL is built", () => {
    expect(() => brokerageBillingPublicBaseUrl()).toThrowError(
      BillingPublicBaseUrlUnsetError,
    );
    let thrown: unknown;
    try {
      defaultCheckoutSuccessUrl();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BillingPublicBaseUrlUnsetError);
    expect((thrown as BillingPublicBaseUrlUnsetError).refusal).toBe(
      "billing_public_base_url_unset",
    );
    expect((thrown as BillingPublicBaseUrlUnsetError).message).toContain(
      "BROKERAGE_BILLING_PUBLIC_BASE_URL",
    );
  });

  it("CONTROL: configured -> the configured origin, trailing slashes trimmed", () => {
    process.env.BROKERAGE_BILLING_PUBLIC_BASE_URL = "https://api.test.invalid/";
    expect(brokerageBillingPublicBaseUrl()).toBe("https://api.test.invalid");
    expect(defaultCheckoutSuccessUrl()).toBe(
      "https://api.test.invalid/api/brokerage/v1/billing/checkout-complete",
    );
  });

  it("VIOLATION: blank is unset, not a value", () => {
    process.env.BROKERAGE_BILLING_PUBLIC_BASE_URL = "   ";
    expect(() => brokerageBillingPublicBaseUrl()).toThrowError(
      BillingPublicBaseUrlUnsetError,
    );
  });
});
