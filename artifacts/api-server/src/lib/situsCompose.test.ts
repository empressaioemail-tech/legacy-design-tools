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

/**
 * P-270 ADDRESS HALF (2026-09-18). `composeSmartSiteStub` passes BOTH a composed
 * street line and the components behind it. Before this, the `composed`
 * short-circuit made every component after the street dead code, so the MCP's
 * label was the bare street line even when the payload held a city and a ZIP.
 */
describe("composeSitusLabel — P-270 address half", () => {
  it("carries the city, state and ZIP a composed street line would otherwise drop", () => {
    expect(
      composeSitusLabel({
        parcelNodeId: "48453:445501",
        composed: "21404 GRAND NATIONAL AVE",
        parts: ["21404 GRAND NATIONAL AVE", "Pflugerville", "TX", "78660"],
        components: { city: "Pflugerville", state: "TX", zip: "78660" },
      }),
    ).toEqual({ label: "21404 GRAND NATIONAL AVE, Pflugerville, TX 78660", situs: "present" });
  });

  it("is byte-identical for a composed line that already reads in full", () => {
    const spelledOut = "1109 Pecan St, Bastrop, TX 78602";
    expect(
      composeSitusLabel({
        parcelNodeId: "48021:34049",
        composed: spelledOut,
        parts: [spelledOut, "Bastrop", "TX", "78602"],
        components: { city: "Bastrop", state: "TX", zip: "78602" },
      }),
    ).toEqual({ label: spelledOut, situs: "present" });
  });

  it("adds only a ZIP the line lacks, as a space suffix on its existing state", () => {
    expect(
      composeSitusLabel({
        parcelNodeId: "48453:1",
        composed: "21404 GRAND NATIONAL AVE, PFLUGERVILLE, TX",
        components: { city: "Pflugerville", state: "TX", zip: "78660" },
      }).label,
    ).toBe("21404 GRAND NATIONAL AVE, PFLUGERVILLE, TX 78660");
  });

  it("does not read a street name as a state: '1 TX AVE' still gets its state and ZIP", () => {
    expect(
      composeSitusLabel({
        parcelNodeId: "48453:2",
        composed: "1 TX AVE",
        components: { state: "TX", zip: "78660" },
      }).label,
    ).toBe("1 TX AVE, TX 78660");
  });

  it("is UNCHANGED for the callers whose composed value IS the whole line (A3 draw label, saved-property label)", () => {
    expect(firstPresentSitusLabel("48021:34137", ["908 PINE", "908 PINE ST"]).label).toBe("908 PINE");
    expect(projectSavedPropertyLabel("48021:34137", "908 PINE").label).toBe("908 PINE");
    expect(
      composeSitusLabel({ parcelNodeId: "48021:34137", composed: "908 PINE" }).label,
    ).toBe("908 PINE");
  });

  it("still falls back to the parts (and then the node id) when there is no composed line", () => {
    expect(
      composeSitusLabel({
        parcelNodeId: "48021:34137",
        composed: null,
        parts: ["908 PINE", "BASTROP", "TX", "78602"],
      }).label,
    ).toBe("908 PINE, BASTROP, TX, 78602");
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
