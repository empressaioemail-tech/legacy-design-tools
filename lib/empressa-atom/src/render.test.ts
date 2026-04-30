import { describe, it, expect } from "vitest";
import { resolveMode, FALLBACK_ORDER } from "./render";

describe("resolveMode", () => {
  it("returns the requested mode when supported", () => {
    const supported = ["card", "compact", "expanded"] as const;
    expect(resolveMode(supported, "card", "compact")).toBe("compact");
  });

  it("falls back through card → compact → expanded → inline → focus", () => {
    expect(resolveMode(["expanded", "inline"] as const, "expanded", "card"))
      .toBe("expanded");
    expect(resolveMode(["inline", "focus"] as const, "inline", "card"))
      .toBe("inline");
    expect(resolveMode(["focus"] as const, "focus", "card")).toBe("focus");
  });

  it("uses the fallback chain when no mode is requested", () => {
    expect(resolveMode(["compact", "inline"] as const, "inline")).toBe(
      "compact",
    );
  });

  it("FALLBACK_ORDER is the canonical chain", () => {
    expect(FALLBACK_ORDER).toEqual([
      "card",
      "compact",
      "expanded",
      "inline",
      "focus",
    ]);
  });
});
