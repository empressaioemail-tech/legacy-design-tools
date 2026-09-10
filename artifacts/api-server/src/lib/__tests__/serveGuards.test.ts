import { describe, expect, it } from "vitest";
import { assertAccessPair, assertF06BakeAccessPair, assertSitusNotPunctuationOnly, normalizeAccessPair, refusePayloadAtServe, LEGACY_ACCESS_PAIRS } from "../serveGuards";

describe("serveGuards", () => {
  it("refuses access without both fields", () => {
    expect(() => assertAccessPair({ entitlement: "anyone-free" })).toThrow(
      expect.objectContaining({ code: "ACCESS_NOT_DEFAULTED" }),
    );
  });

  it("refuses punctuation-only situs", () => {
    expect(() => assertSitusNotPunctuationOnly(", ,")).toThrow(
      expect.objectContaining({ code: "SITUS_PUNCTUATION_ONLY" }),
    );
  });

  it("accepts valid access pair", () => {
    expect(
      assertAccessPair({ discoverability: "catalog-listed", entitlement: "anyone-free" }),
    ).toEqual({
      discoverability: "catalog-listed",
      entitlement: "anyone-free",
    });
  });

  it("retirement (A-023 card C closed): the legacy table is empty and a legacy pair reaching serve refuses again", () => {
    expect(Object.keys(LEGACY_ACCESS_PAIRS)).toEqual([]);
    expect(() => normalizeAccessPair({ discoverability: "public", entitlement: "anonymous" })).toThrow(
      expect.objectContaining({ code: "ACCESS_NOT_DEFAULTED" }),
    );
    expect(() => refusePayloadAtServe({ access: { discoverability: "public", entitlement: "anonymous" } })).toThrow(
      expect.objectContaining({ code: "ACCESS_NOT_DEFAULTED" }),
    );
    const p: Record<string, unknown> = { access: { discoverability: "catalog-listed", entitlement: "anyone-free" } };
    refusePayloadAtServe(p);
    expect(p.accessNormalizedFrom).toBeUndefined();
  });

  it("passes a canonical pair through untouched with no marker", () => {
    expect(normalizeAccessPair({ discoverability: "unlisted", entitlement: "owner-only" })).toEqual({
      access: { discoverability: "unlisted", entitlement: "owner-only" },
      normalizedFrom: null,
    });
  });

  it("still refuses a pair that is neither canonical nor in the legacy table (violation)", () => {
    expect(() => normalizeAccessPair({ discoverability: "public", entitlement: "identified" })).toThrow(
      expect.objectContaining({ code: "ACCESS_NOT_DEFAULTED" }),
    );
    expect(() => normalizeAccessPair({ discoverability: "tenant", entitlement: "anonymous" })).toThrow(
      expect.objectContaining({ code: "ACCESS_NOT_DEFAULTED" }),
    );
  });

  it("refusePayloadAtServe leaves a canonical pair untouched and refuses an unknown one", () => {
    const canonical: Record<string, unknown> = {
      access: { discoverability: "catalog-listed", entitlement: "anyone-free" },
    };
    refusePayloadAtServe(canonical);
    expect(canonical.accessNormalizedFrom).toBeUndefined();
    expect(() => refusePayloadAtServe({ access: { discoverability: "nope", entitlement: "anonymous" } })).toThrow(
      expect.objectContaining({ code: "ACCESS_NOT_DEFAULTED" }),
    );
  });

  it("accepts F-06 legacy bake access pair", () => {
    expect(
      assertF06BakeAccessPair({ discoverability: "public", entitlement: "anonymous" }),
    ).toEqual({
      discoverability: "public",
      entitlement: "anonymous",
    });
  });
});

describe("refusePayloadAtServe / A3 (operator ruling, 2026-09-10): earned retirement exempts the punctuation-only situs guard", () => {
  const wellFormedRetirement = {
    status: "retired",
    verdict: "absent-verified",
    authority: "48055 Caldwell CAD, declared vintage 2026",
    scopeSearched: "cad_property at the declared tax year",
    asOf: "2026-09-09T22:48:00.000Z",
    basis: "48055:1 has no row in the declared-vintage cad_property roll",
    lastSeenTaxYear: 2025,
  };

  it("an on-roll (non-retired) payload with a punctuation-only situs still refuses -- CTX-SITUS-SKIP's guard is untouched", () => {
    expect(() =>
      refusePayloadAtServe({
        recordRetirement: null,
        facets: { base: { situsAddress: ", ," } },
      }),
    ).toThrow(expect.objectContaining({ code: "SITUS_PUNCTUATION_ONLY" }));
  });

  it("required regression test: an earned retirement (Caldwell 48055:1 shape) with the raw punctuation-only last-known situs does NOT 422 at serve", () => {
    expect(() =>
      refusePayloadAtServe({
        recordRetirement: wellFormedRetirement,
        facets: { base: { situsAddress: ", ," } },
      }),
    ).not.toThrow();
  });

  it("a half-built retirement object (fails isEarnedRecordRetirement) buys no exemption -- the guard still refuses", () => {
    expect(() =>
      refusePayloadAtServe({
        recordRetirement: { status: "retired" }, // missing verdict/authority/etc.
        facets: { base: { situsAddress: ", ," } },
      }),
    ).toThrow(expect.objectContaining({ code: "SITUS_PUNCTUATION_ONLY" }));
  });

  it("an earned retirement with a well-formed situs is untouched (the exemption is not needed and changes nothing)", () => {
    expect(() =>
      refusePayloadAtServe({
        recordRetirement: wellFormedRetirement,
        facets: { base: { situsAddress: "308 W San Antonio St" } },
      }),
    ).not.toThrow();
  });
});
