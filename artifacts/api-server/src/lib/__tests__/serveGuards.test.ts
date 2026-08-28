import { describe, expect, it } from "vitest";
import { assertAccessPair, assertF06BakeAccessPair, assertSitusNotPunctuationOnly } from "../serveGuards";

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

  it("accepts F-06 legacy bake access pair", () => {
    expect(
      assertF06BakeAccessPair({ discoverability: "public", entitlement: "anonymous" }),
    ).toEqual({
      discoverability: "public",
      entitlement: "anonymous",
    });
  });
});
