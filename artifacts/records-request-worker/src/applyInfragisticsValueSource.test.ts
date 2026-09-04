import { describe, expect, it } from "vitest";
import { applyInfragisticsValueSource } from "./applyInfragisticsValueSource.js";

describe("applyInfragisticsValueSource", () => {
  it("is a string IIFE and does not mention __name", () => {
    const src = applyInfragisticsValueSource("#cphNoMargin_f_txtGrantor", "PALMS PROPERTIES LLC");
    expect(src.startsWith("(() =>")).toBe(true);
    expect(src).not.toContain("__name");
    expect(typeof src).toBe("string");
  });

  it("fails when the input is missing", () => {
    const src = applyInfragisticsValueSource("#missing", "PALMS");
    const result = new Function(
      "window",
      "document",
      `return ${src}`,
    )({ $find: undefined }, { querySelector: () => null });
    expect(result).toEqual({ ok: false, read: null, reason: "missing" });
  });

  it("reads back after $find set_value", () => {
    const input = { id: "cphNoMargin_f_txtGrantor", value: "" };
    const src = applyInfragisticsValueSource("#cphNoMargin_f_txtGrantor", "PALMS PROPERTIES LLC");
    const result = new Function(
      "window",
      "document",
      `return ${src}`,
    )(
      {
        $find: (id: string) =>
          id === "cphNoMargin_f_txtGrantor"
            ? {
                set_value: (val: string) => {
                  input.value = val;
                },
              }
            : null,
      },
      { querySelector: () => input },
    );
    expect(result).toEqual({ ok: true, read: "PALMS PROPERTIES LLC" });
  });

  it("fails when Playwright fill left the watermark empty and $find is absent", () => {
    const input = { id: "cphNoMargin_f_txtGrantor", value: "" };
    const src = applyInfragisticsValueSource("#cphNoMargin_f_txtGrantor", "PALMS PROPERTIES LLC");
    const result = new Function(
      "window",
      "document",
      `return ${src}`,
    )({ $find: undefined }, { querySelector: () => input });
    expect(result.ok).toBe(false);
    expect(result.read).toBe("");
  });
});
