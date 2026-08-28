import { describe, expect, it } from "vitest";
import { assertAccessPair, assertF06BakeAccessPair, assertSitusNotPunctuationOnly, normalizeAccessPair, refusePayloadAtServe } from "../serveGuards";

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

  it("normalizes the legacy F-06 pair to the canonical pair and declares it", () => {
    expect(normalizeAccessPair({ discoverability: "public", entitlement: "anonymous" })).toEqual({
      access: { discoverability: "catalog-listed", entitlement: "anyone-free" },
      normalizedFrom: "public/anonymous",
    });
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

  it("refusePayloadAtServe rewrites a legacy pair on the served payload and marks it (the 2026-08-28 Bastrop 422)", () => {
    const payload: Record<string, unknown> = {
      shapeSource: "conformant-v1",
      access: { discoverability: "public", entitlement: "anonymous" },
      facets: { base: { situsAddress: "908 PINE , BASTROP, TX 78602" } },
    };
    refusePayloadAtServe(payload);
    expect(payload.access).toEqual({ discoverability: "catalog-listed", entitlement: "anyone-free" });
    expect(payload.accessNormalizedFrom).toBe("public/anonymous");
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
