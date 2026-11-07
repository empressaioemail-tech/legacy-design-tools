/**
 * A-062 — the portal `return_url` allowlist, as a pure rule.
 *
 * Separated from the route suite because it is a decision about a string and
 * needs no database, no Express and no Stripe. It runs in milliseconds, which
 * matters: the DB-backed route file costs about thirteen seconds per test
 * locally, and a rule this fiddly deserves more cases than that budget buys.
 *
 * WHAT THE RULE IS FOR. The customer clicks "Manage billing", goes to Stripe,
 * cancels, and Stripe sends them to `return_url`. The client sends that value,
 * so it is caller-controlled, so it is an open redirect unless something says
 * no. It is REFUSED rather than rewritten: silently sending somebody somewhere
 * other than where the request asked is the same class of defect as the stale
 * hardcoded default this card removes.
 *
 * `@workspace/db` is factory-mocked so this file runs without DATABASE_URL.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {},
  peUserEntitlements: {},
}));

const { isAllowedPeReturnUrl, peAllowedReturnHosts } = await import(
  "./pePaywallStripe"
);

const ENV_KEYS = [
  "PE_PORTAL_RETURN_HOSTS",
  "PE_WEB_APP_BASE_URL",
  "NODE_ENV",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("the default host set", () => {
  it("carries the Smart Site production hosts with no configuration at all", () => {
    expect(peAllowedReturnHosts()).toEqual(
      expect.arrayContaining(["smartsite.cloud", "www.smartsite.cloud"]),
    );
  });

  it("adds the configured web-app host when one is set", () => {
    process.env.PE_WEB_APP_BASE_URL = "https://app.example.gov/";
    expect(peAllowedReturnHosts()).toContain("app.example.gov");
  });

  it("VIOLATION: a malformed PE_WEB_APP_BASE_URL contributes NOTHING", () => {
    // A guessed host from an unparseable config is a fabricated value. The
    // two production entries survive; nothing is invented beside them.
    process.env.PE_WEB_APP_BASE_URL = "not a url at all";
    const hosts = peAllowedReturnHosts();
    expect(hosts).toEqual(
      expect.arrayContaining(["smartsite.cloud", "www.smartsite.cloud"]),
    );
    expect(hosts).not.toContain("not a url at all");
    expect(hosts).toHaveLength(2);
  });

  it("an explicit PE_PORTAL_RETURN_HOSTS REPLACES the defaults, never widens them", () => {
    // Replace, not merge. An operator narrowing the set must actually get a
    // narrower set, or the control is broader than its claim.
    process.env.PE_PORTAL_RETURN_HOSTS = "only.example.com";
    expect(peAllowedReturnHosts()).toEqual(["only.example.com"]);
    expect(isAllowedPeReturnUrl("https://smartsite.cloud/")).toBe(false);
    expect(isAllowedPeReturnUrl("https://only.example.com/x")).toBe(true);
  });
});

describe("what is admitted", () => {
  it("the Smart Site production hosts over https", () => {
    expect(isAllowedPeReturnUrl("https://smartsite.cloud/?billing=portal-return")).toBe(
      true,
    );
    expect(isAllowedPeReturnUrl("https://www.smartsite.cloud/")).toBe(true);
  });

  it("Vercel preview deployments, because checkout already returns to them", () => {
    // PE checkout sends window.location.origin. A portal stricter than the
    // checkout beside it would refuse a flow the product already permits, and
    // a control that blocks work it was never meant to reach teaches people
    // to route around it.
    expect(isAllowedPeReturnUrl("https://property-explorer-xi.vercel.app/")).toBe(true);
    expect(isAllowedPeReturnUrl("https://pe-git-branch-empressa.vercel.app/x")).toBe(
      true,
    );
  });

  it("loopback over http OUTSIDE production only", () => {
    process.env.NODE_ENV = "development";
    expect(isAllowedPeReturnUrl("http://localhost:5175/")).toBe(true);
    expect(isAllowedPeReturnUrl("http://127.0.0.1:5175/")).toBe(true);
    process.env.NODE_ENV = "production";
    expect(isAllowedPeReturnUrl("http://localhost:5175/")).toBe(false);
    // And https loopback is refused in production too — the arm is about the
    // host being loopback, not about the scheme.
    expect(isAllowedPeReturnUrl("https://localhost:5175/")).toBe(false);
  });
});

describe("VIOLATIONS — what is refused", () => {
  it("a foreign host, however plausible", () => {
    expect(isAllowedPeReturnUrl("https://evil.example.com/collect")).toBe(false);
    expect(isAllowedPeReturnUrl("https://smartsite.cloud.evil.com/")).toBe(false);
    // Suffix matching is EXACT on the label boundary: this is the classic
    // near-miss that a naive `includes("smartsite.cloud")` would admit.
    expect(isAllowedPeReturnUrl("https://notsmartsite.cloud/")).toBe(false);
  });

  it("`vercel.app` itself, and a lookalike suffix", () => {
    // The check is `.endsWith('.vercel.app')`, so the apex and a host merely
    // ending in the same letters are both out.
    expect(isAllowedPeReturnUrl("https://vercel.app/")).toBe(false);
    expect(isAllowedPeReturnUrl("https://notvercel.app/")).toBe(false);
    expect(isAllowedPeReturnUrl("https://evil.com/x.vercel.app")).toBe(false);
  });

  it("http on a non-loopback host, even an allowlisted one", () => {
    expect(isAllowedPeReturnUrl("http://smartsite.cloud/")).toBe(false);
  });

  it("non-http schemes, including the ones that execute", () => {
    expect(isAllowedPeReturnUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedPeReturnUrl("data:text/html,<script>1</script>")).toBe(false);
    expect(isAllowedPeReturnUrl("file:///etc/passwd")).toBe(false);
  });

  it("anything that is not an absolute URL at all", () => {
    // A relative path has no host to check, so it cannot be admitted. Empty
    // string, whitespace and a bare path all refuse rather than throw.
    for (const bad of ["", "   ", "/", "/?billing=portal-return", "smartsite.cloud"]) {
      expect(isAllowedPeReturnUrl(bad)).toBe(false);
    }
  });

  it("IS NOT VACUOUS — the function does return true for something", () => {
    // A predicate that refuses everything would pass every VIOLATION case
    // above while making the route unusable. This is the case that says the
    // refusals mean something.
    expect(isAllowedPeReturnUrl("https://smartsite.cloud/")).toBe(true);
  });
});
