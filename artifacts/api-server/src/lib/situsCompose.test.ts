import { describe, expect, it } from "vitest";
import {
  composeSitusLabel,
  firstPresentSitusLabel,
  incorporatedCityLimitsCity,
  isPunctuationOnlySitus,
  projectSavedPropertyLabel,
  resolveSitusCity,
  rollSitusCityFromFacets,
  rollSitusCityIsDeclaredAbsent,
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

/**
 * P-270 CITY HALF (2026-09-19). The licence: which city a composed label may
 * name, and on what it is conditioned. Every branch is asserted in BOTH
 * directions — the payload that gains a city and the payload that must name
 * none — because the defect this closes was a silent drop, and a rule that
 * cannot be shown to refuse is not a rule.
 */
describe("resolveSitusCity — P-270 city half", () => {
  /** The bake's declaration, verbatim from the live `48453:445501` baseFacts.situsCity. */
  const DECLARED_ABSENT = {
    status: "absent",
    verdict: "absent-verified",
    authority: "Travis County CAD roll",
  };
  const INCORPORATED = { status: "incorporated", cityName: "Pflugerville" };

  it("THE DEFECT: a declared absent-verified roll city plus an incorporated city-limits answer names the containing city, with its basis", () => {
    expect(
      resolveSitusCity({
        rollSitusCity: DECLARED_ABSENT,
        cityLimits: INCORPORATED,
      }),
    ).toEqual({ city: "Pflugerville", basis: "city-limits" });
  });

  it("the roll's own city wins whenever the payload states one — the containing city never replaces it", () => {
    expect(
      resolveSitusCity({
        rollSitusCity: "Austin",
        cityLimits: INCORPORATED,
      }),
    ).toEqual({ city: "Austin", basis: "cad-roll" });
  });

  it("FALSIFIER: an UNINCORPORATED city-limits answer names no city", () => {
    expect(
      resolveSitusCity({
        rollSitusCity: DECLARED_ABSENT,
        cityLimits: { status: "unincorporated", cityName: "Pflugerville" },
      }),
    ).toEqual({ city: null, basis: null });
  });

  it("FALSIFIER: a rail with no absent-verified DECLARATION names no city — a bare null is not evidence the roll has none", () => {
    for (const rollSitusCity of [
      null,
      undefined,
      "",
      { status: "absent" },
      { status: "absent", verdict: "lookup-failed" },
      { status: "absent", verdict: "not-applicable" },
      { status: "refused" },
    ]) {
      expect(
        resolveSitusCity({ rollSitusCity, cityLimits: INCORPORATED }),
      ).toEqual({ city: null, basis: null });
    }
  });

  it("FALSIFIER: no determination in hand names no city, and the status word alone is not enough — the answer must NAME one", () => {
    for (const cityLimits of [
      undefined,
      null,
      { status: "unmeasured", cityName: "Pflugerville" },
      { status: "incorporated" },
      { status: "incorporated", cityName: "   " },
    ]) {
      expect(
        resolveSitusCity({ rollSitusCity: DECLARED_ABSENT, cityLimits }),
      ).toEqual({ city: null, basis: null });
    }
  });

  it("reads the declaration the way the probe reads it: verdict first, then status", () => {
    expect(
      rollSitusCityIsDeclaredAbsent({ status: "absent", verdict: "absent-verified" }),
    ).toBe(true);
    // A `lookup-failed` verdict beside an `absent` status is not a verified
    // absence, and never becomes one in transit.
    expect(
      rollSitusCityIsDeclaredAbsent({ status: "absent-verified", verdict: "lookup-failed" }),
    ).toBe(false);
    expect(rollSitusCityIsDeclaredAbsent("BASTROP")).toBe(false);
    expect(rollSitusCityIsDeclaredAbsent(null)).toBe(false);
  });

  it("reads the roll city out of the facets the way the stub does (baseFacts, never a root sibling)", () => {
    expect(
      rollSitusCityFromFacets({ baseFacts: { situsCity: DECLARED_ABSENT } }),
    ).toEqual(DECLARED_ABSENT);
    expect(rollSitusCityFromFacets({ situsCity: "Austin" })).toBeNull();
    expect(rollSitusCityFromFacets(null)).toBeNull();
    expect(rollSitusCityFromFacets("nope")).toBeNull();
  });

  it("the gate is the city NAME, not the status word", () => {
    expect(incorporatedCityLimitsCity(INCORPORATED)).toBe("Pflugerville");
    expect(incorporatedCityLimitsCity({ status: "incorporated" })).toBeNull();
    expect(incorporatedCityLimitsCity({ status: "unmeasured", cityName: "X" })).toBeNull();
  });
});
