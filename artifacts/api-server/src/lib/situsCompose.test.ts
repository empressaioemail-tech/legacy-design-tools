import { describe, expect, it } from "vitest";
import {
  composeSitusLabel,
  firstPresentSitusLabel,
  isPunctuationOnlySitus,
  projectSavedPropertyLabel,
} from "./situsCompose";

describe("isPunctuationOnlySitus", () => {
  it("flags the live 48021:25420 sentinel", () => {
    expect(isPunctuationOnlySitus(", ,")).toBe(true);
  });

  it("flags empty and whitespace", () => {
    expect(isPunctuationOnlySitus("")).toBe(true);
    expect(isPunctuationOnlySitus("   ")).toBe(true);
    expect(isPunctuationOnlySitus(null)).toBe(true);
    expect(isPunctuationOnlySitus(undefined)).toBe(true);
  });

  it("accepts a real street line", () => {
    expect(isPunctuationOnlySitus("908 PINE, BASTROP, TX 78602")).toBe(false);
  });
});

describe("composeSitusLabel", () => {
  it("falls back to node id and situs unknown when components are empty", () => {
    expect(
      composeSitusLabel({
        parcelNodeId: "48021:25420",
        parts: ["", null, "  ", ","],
      }),
    ).toEqual({ label: "48021:25420", situs: "unknown" });
  });

  it("never returns a punctuation string from a composed sentinel", () => {
    const row = composeSitusLabel({
      parcelNodeId: "48021:25420",
      composed: ", ,",
    });
    expect(row.label).toBe("48021:25420");
    expect(row.situs).toBe("unknown");
    expect(row.label).not.toMatch(/^[\s,.\-;:'"`]+$/);
  });

  it("joins real components", () => {
    expect(
      composeSitusLabel({
        parcelNodeId: "48021:34137",
        parts: ["908 PINE", "BASTROP", "TX", "78602"],
      }),
    ).toEqual({
      label: "908 PINE, BASTROP, TX, 78602",
      situs: "present",
    });
  });

  it("drops separator-only parts and keeps the rest", () => {
    expect(
      composeSitusLabel({
        parcelNodeId: "48021:34137",
        parts: ["908 PINE", ", ,", "BASTROP"],
      }),
    ).toEqual({ label: "908 PINE, BASTROP", situs: "present" });
  });
});

describe("projectSavedPropertyLabel", () => {
  it("rewrites a stored punctuation label to the node id", () => {
    expect(projectSavedPropertyLabel("48021:25420", ", ,")).toEqual({
      label: "48021:25420",
      situs: "unknown",
    });
  });

  it("keeps a stored street label", () => {
    expect(projectSavedPropertyLabel("48021:34137", "908 PINE")).toEqual({
      label: "908 PINE",
      situs: "present",
    });
  });
});

describe("firstPresentSitusLabel", () => {
  it("does not join later address fields onto the first (A3)", () => {
    expect(
      firstPresentSitusLabel("48021:34137", [
        "908 PINE , BASTROP, TX 78602",
        "908 PINE ST",
        "908 PINE , BASTROP, TX 78602",
        "908 Pine",
      ]),
    ).toEqual({
      label: "908 PINE , BASTROP, TX 78602",
      situs: "present",
    });
  });

  it("falls back to the node id when every candidate is punctuation", () => {
    expect(firstPresentSitusLabel("48021:25420", [", ,", "", null])).toEqual({
      label: "48021:25420",
      situs: "unknown",
    });
  });
});
