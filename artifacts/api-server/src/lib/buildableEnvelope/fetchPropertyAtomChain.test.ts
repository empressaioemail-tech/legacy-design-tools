/**
 * D-25 (OPS-25, 2026-09-23). `fetchPropertyAtomChain` was the fifth of the five
 * readers that ended their base-URL resolution on the retired Google Cloud Run
 * retrieval host, and it is the one reader whose refusal had no test of its own:
 * every consumer of this module MOCKS it (`brokeragePlaceBuildableEnvelope.test.ts`
 * replaces it wholesale), so the module's own body was executed by no test in this
 * package. A mock proves the CALLER's handling of an answer; it cannot prove that
 * the module refuses when it is misconfigured. The dispatch requires a test per
 * module proving the unset case refuses by name, so this file is that test.
 *
 * WHAT IS ASSERTED, and why each leg is here:
 *   1. UNARMED (no API key): returns `null` and calls nothing. This is the pre-
 *      existing contract -- "this reader is not armed on this deployment" is a
 *      soft skip, and D-25 deliberately left it alone. Without this leg, a change
 *      that turned every caller into a hard failure would still pass the rest.
 *   2. ARMED key, ADDRESS unset: refuses BY NAME and calls nothing -- and in
 *      particular does NOT return null. Null is the value callers read as "the
 *      retrieval service says this parcel has no atom chain", a real and verified
 *      absence; returning it for a missing address is a FABRICATED ABSENCE on a
 *      customer surface, and a throw cannot be laundered into a fact about a
 *      parcel. This is the whole argument for the change, so it is asserted
 *      rather than assumed.
 *   3. POSITIVE CONTROL: with the address configured, the call goes to exactly
 *      that host, carries the key as a bearer token, and returns the parsed wire.
 *      A control is required or leg 2 is unfalsifiable -- "no call happened"
 *      would be indistinguishable from a test that cannot see calls at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchPropertyAtomChain } from "./fetchPropertyAtomChain";
import {
  RETRIEVAL_BASE_URL_UNSET_REFUSAL,
  isRetrievalBaseUrlUnsetError,
} from "../retrievalEndpoint";

/** Names this module reads for its key, in its own precedence order. */
const KEY_NAMES = [
  "HAUSKA_RETRIEVAL_API_KEY",
  "RETRIEVAL_API_KEY",
  "BRIEF_RETRIEVAL_API_KEY",
] as const;

/** Names the shared resolver reads for the address, in their order. */
const URL_NAMES = [
  "HAUSKA_RETRIEVAL_API_URL",
  "RETRIEVAL_API_URL",
  "BRIEF_RETRIEVAL_API_URL",
] as const;

const ALL_NAMES = [...KEY_NAMES, ...URL_NAMES];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const name of ALL_NAMES) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  // Restore rather than merely delete: this file must not decide for any later
  // test in the same process what the environment holds.
  for (const name of ALL_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchPropertyAtomChain (D-25: no default retrieval host)", () => {
  it("unarmed reader (no API key anywhere): returns null and never calls fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await fetchPropertyAtomChain("48021:34049");

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("armed key with the ADDRESS unset: refuses by name, calls nothing, and never returns null", async () => {
    // The BRIEF_ name is the one the deployed cortex-api actually mounts, so it
    // is the realistic arming; the assertion below covers all three anyway.
    process.env.BRIEF_RETRIEVAL_API_KEY = "brief-key";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const outcome = await fetchPropertyAtomChain("48021:34049").then(
      (value) => ({ kind: "resolved" as const, value }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );

    // It must REJECT, and a null must be impossible: null means "no atom chain".
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("unreachable");
    expect(isRetrievalBaseUrlUnsetError(outcome.error)).toBe(true);
    expect((outcome.error as { refusal?: string }).refusal).toBe(
      RETRIEVAL_BASE_URL_UNSET_REFUSAL,
    );
    // The message names every knob that would have fixed it, so a reader of a 500
    // is told what to set rather than what is dead.
    for (const name of URL_NAMES) {
      expect((outcome.error as Error).message).toContain(name);
    }
    // And nothing reached the network: a corpse is never contacted.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("armed key with the address set: calls exactly that host with the bearer key, and returns the wire (positive control for the test above)", async () => {
    process.env.BRIEF_RETRIEVAL_API_KEY = "brief-key";
    process.env.BRIEF_RETRIEVAL_API_URL = "https://retrieval.test.invalid/";
    let capturedUrl = "";
    let capturedAuth = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
        capturedUrl = String(url);
        capturedAuth = init.headers.Authorization;
        return new Response(
          JSON.stringify({ zoningFact: { district: "SF-3" } }),
          { status: 200 },
        );
      }),
    );

    const wire = await fetchPropertyAtomChain("48021:34049");

    // Trailing slash on the configured address is removed, so the path is not doubled.
    expect(capturedUrl).toBe(
      "https://retrieval.test.invalid/property-nodes/48021%3A34049/atom-chain",
    );
    expect(capturedAuth).toBe("Bearer brief-key");
    expect(wire).toEqual({ zoningFact: { district: "SF-3" } });
  });
});
