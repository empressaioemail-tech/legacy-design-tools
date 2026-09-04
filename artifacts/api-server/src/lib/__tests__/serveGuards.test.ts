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
