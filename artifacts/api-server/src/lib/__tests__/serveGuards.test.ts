import { describe, expect, it } from "vitest";
import { assertAccessPair, assertF06BakeAccessPair, assertSitusNotPunctuationOnly, normalizeAccessPair, refusePayloadAtServe, retiredRecordAtServe, shouldDeclineRetiredRecordAtServe, LEGACY_ACCESS_PAIRS } from "../serveGuards";

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

describe("P-180 shouldDeclineRetiredRecordAtServe (the missing retirement consumer)", () => {
  const wellFormedRetirement = {
    status: "retired",
    verdict: "absent-verified",
    authority: "48209 Hays CAD, declared vintage 2026",
    scopeSearched: "cad_property at the declared tax year",
    asOf: "2026-09-13T00:00:00.000Z",
    basis: "hollow account-keyed node; not a TxGIO parcel node",
    lastSeenTaxYear: 2026,
  };

  it("declines a retired record in a gate-blocked county (48209:84639)", () => {
    expect(
      shouldDeclineRetiredRecordAtServe("48209:84639", {
        recordRetirement: wellFormedRetirement,
      }),
    ).toBe(true);
    expect(
      shouldDeclineRetiredRecordAtServe("48491:1", {
        recordRetirement: wellFormedRetirement,
      }),
    ).toBe(true);
  });

  it("does NOT decline the same retirement outside the gate-blocked set (control: non-blocked county unchanged)", () => {
    expect(
      shouldDeclineRetiredRecordAtServe("48055:1", {
        recordRetirement: wellFormedRetirement,
      }),
    ).toBe(false);
    expect(
      shouldDeclineRetiredRecordAtServe("48021:34137", {
        recordRetirement: wellFormedRetirement,
      }),
    ).toBe(false);
  });

  it("does NOT decline a live (non-retired) gate-blocked node", () => {
    expect(
      shouldDeclineRetiredRecordAtServe("48209:97658", {
        recordRetirement: null,
      }),
    ).toBe(false);
  });

  it("a half-built retirement object buys no decline", () => {
    expect(
      shouldDeclineRetiredRecordAtServe("48209:84639", {
        recordRetirement: { status: "retired" },
      }),
    ).toBe(false);
  });

  it("honours a caller-supplied ledger set rather than a hardcoded county", () => {
    expect(
      shouldDeclineRetiredRecordAtServe(
        "48999:1",
        { recordRetirement: wellFormedRetirement },
        new Set(["48999"]),
      ),
    ).toBe(true);
  });
});

/**
 * P-206 (2026-09-16). The decline above used to return a bare boolean, so every
 * caller was forced into reading `true` as "no baked snapshot" -- and the
 * brokerage route answered the generic `404 no_coverage/not_baked`, which the
 * property-explorer route then reported as `parcel_not_found` and the MCP as
 * `parcelExists: false`. Measured live on production: 48209:84629 (retired) and
 * 48209:999999 (fabricated) gave the byte-identical answer. These tests are
 * two-directional -- the negative controls below show a non-blocked county, a
 * live node and a half-built retirement all still return null, so a passing
 * case here is not passing by accident -- and they include a DIVERGENCE test:
 * the boolean and the record must never disagree, because they are the same
 * rule and must have exactly one implementation.
 */
describe("P-206 retiredRecordAtServe (the decline keeps its reason)", () => {
  const retirement = {
    status: "retired" as const,
    verdict: "absent-verified" as const,
    authority: "48209 Hays CAD, declared vintage 2026",
    scopeSearched: "cad_property at the declared tax year",
    asOf: "2026-09-14T03:31:56Z",
    basis: "hollow account-keyed node; not a TxGIO parcel node",
    lastSeenTaxYear: 2025,
  };

  it("returns the retirement itself, not a token, for a gate-blocked county", () => {
    expect(retiredRecordAtServe("48209:84629", { recordRetirement: retirement })).toEqual(
      retirement,
    );
    // The vintage travels with the claim, so the serve can declare WHEN.
    expect(
      retiredRecordAtServe("48209:84629", { recordRetirement: retirement })?.asOf,
    ).toBe("2026-09-14T03:31:56Z");
  });

  it("negative control: a non-blocked county is untouched", () => {
    expect(retiredRecordAtServe("48055:1", { recordRetirement: retirement })).toBeNull();
    expect(retiredRecordAtServe("48021:34137", { recordRetirement: retirement })).toBeNull();
  });

  it("negative control: a live node, an absent marker and a non-object payload are all null", () => {
    expect(retiredRecordAtServe("48209:97658", { recordRetirement: null })).toBeNull();
    expect(retiredRecordAtServe("48209:97658", {})).toBeNull();
    expect(retiredRecordAtServe("48209:84629", null)).toBeNull();
    expect(retiredRecordAtServe("48209:84629", "retired")).toBeNull();
  });

  it("negative control: a half-built retirement object buys nothing", () => {
    expect(
      retiredRecordAtServe("48209:84629", { recordRetirement: { status: "retired" } }),
    ).toBeNull();
    expect(
      retiredRecordAtServe("48209:84629", {
        recordRetirement: { ...retirement, verdict: "probably" },
      }),
    ).toBeNull();
    expect(
      retiredRecordAtServe("48209:84629", {
        recordRetirement: { ...retirement, asOf: "  " },
      }),
    ).toBeNull();
  });

  it("DIVERGENCE: the record and the boolean never disagree, in either direction", () => {
    const cases: Array<[string, unknown, ReadonlySet<string>?]> = [
      ["48209:84629", { recordRetirement: retirement }],
      ["48491:1", { recordRetirement: retirement }],
      ["48055:1", { recordRetirement: retirement }],
      ["48209:97658", { recordRetirement: null }],
      ["48209:84629", { recordRetirement: { status: "retired" } }],
      ["48209:84629", null],
      ["48999:1", { recordRetirement: retirement }, new Set(["48999"])],
    ];
    for (const [node, payload, fips] of cases) {
      const record = fips
        ? retiredRecordAtServe(node, payload, fips)
        : retiredRecordAtServe(node, payload);
      const bool = fips
        ? shouldDeclineRetiredRecordAtServe(node, payload, fips)
        : shouldDeclineRetiredRecordAtServe(node, payload);
      expect(bool).toBe(record !== null);
    }
  });
});
