import { describe, expect, it } from "vitest";
import { assertAccessPair, assertSitusNotPunctuationOnly } from "../serveGuards";

describe("serveGuards", () => {
  it("refuses access without both fields", () => {
    expect(() => assertAccessPair({ entitlement: "anonymous" })).toThrow(
      expect.objectContaining({ code: "ACCESS_NOT_DEFAULTED" }),
    );
  });

  it("refuses punctuation-only situs", () => {
    expect(() => assertSitusNotPunctuationOnly(", ,")).toThrow(
      expect.objectContaining({ code: "SITUS_PUNCTUATION_ONLY" }),
    );
  });

  it("accepts valid access pair", () => {
    expect(assertAccessPair({ discoverability: "public", entitlement: "anonymous" })).toEqual({
      discoverability: "public",
      entitlement: "anonymous",
    });
  });
});
