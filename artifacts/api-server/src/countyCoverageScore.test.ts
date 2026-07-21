/**
 * County coverage scorer — classification unit tests (pure, offline, no DB).
 *
 * Covers `classifyFacet`: given raw coverage + gate verdict + source presence,
 * the ledger records the correct classification and honest coverage.
 */

import { describe, it, expect } from "vitest";
import { classifyFacet } from "./countyCoverageScoreCli";

describe("classifyFacet", () => {
  it("a gate-BLOCKED land-use join -> fabricated-blocked, honest coverage 0", () => {
    // Williamson/Hays: the join produced high RAW coverage (fabricated), but
    // the owner-match gate blocked it. The ledger must record 0 honest
    // coverage and the fabricated-blocked classification, NEVER the stamp rate.
    const r = classifyFacet({
      facet: "land-use",
      rawCoveragePct: 91.6, // the fabricated stamp rate
      sourcePresent: true,
      verdict: "block",
      ownerMatchRate: 0.0,
      source: "cad-roll",
      sourceVintage: "2026-certified",
      sampled: 2000,
    });
    expect(r.classification).toBe("fabricated-blocked");
    expect(r.honestCoveragePct).toBe(0);
    expect(r.integrityVerdict).toBe("block");
  });

  it("no source at all (e.g. Comal, no CAD roll) -> true-source-gap, coverage 0", () => {
    const r = classifyFacet({
      facet: "land-use",
      rawCoveragePct: 0,
      sourcePresent: false,
      verdict: "insufficient-sample", // empty sample -> insufficient
      ownerMatchRate: null,
      source: null,
      sourceVintage: null,
      sampled: 0,
    });
    expect(r.classification).toBe("true-source-gap");
    expect(r.honestCoveragePct).toBe(0);
  });

  it("a real, passing join -> real-at-ceiling, honest = raw coverage", () => {
    // Bexar/Bastrop: owners agree ~100%, the join is real.
    const r = classifyFacet({
      facet: "land-use",
      rawCoveragePct: 99.1,
      sourcePresent: true,
      verdict: "pass",
      ownerMatchRate: 0.991,
      source: "cad-roll",
      sourceVintage: "2026-certified",
      sampled: 2000,
    });
    expect(r.classification).toBe("real-at-ceiling");
    expect(r.honestCoveragePct).toBeCloseTo(99.1, 5);
    expect(r.integrityVerdict).toBe("pass");
  });

  it("source present but sample too thin to prove -> needs-crosswalk, honest 0", () => {
    // A roll exists and produced some raw coverage, but the owner sample was
    // insufficient to prove the join — an external crosswalk is the unblock.
    const r = classifyFacet({
      facet: "land-use",
      rawCoveragePct: 40,
      sourcePresent: true,
      verdict: "insufficient-sample",
      ownerMatchRate: 0.0,
      source: "cad-roll",
      sourceVintage: "2026-certified",
      sampled: 12,
    });
    expect(r.classification).toBe("needs-crosswalk");
    // The raw coverage is not proven real, so honest coverage stays 0 until a
    // crosswalk lifts it.
    expect(r.honestCoveragePct).toBe(0);
  });

  it("an n/a-oracle facet (zoning) with real coverage -> real-at-ceiling, verdict n/a", () => {
    const r = classifyFacet({
      facet: "zoning",
      rawCoveragePct: 62.5,
      sourcePresent: true,
      verdict: null, // no owner oracle
      ownerMatchRate: null,
      source: "zoning-stamp",
      sourceVintage: null,
      sampled: 0,
    });
    expect(r.classification).toBe("real-at-ceiling");
    expect(r.integrityVerdict).toBe("n/a");
    expect(r.honestCoveragePct).toBeCloseTo(62.5, 5);
    expect(r.ownerMatchRate).toBeNull();
  });

  it("an n/a-oracle facet with zero coverage -> true-source-gap", () => {
    const r = classifyFacet({
      facet: "zoning",
      rawCoveragePct: 0,
      sourcePresent: false,
      verdict: null,
      ownerMatchRate: null,
      source: null,
      sourceVintage: null,
      sampled: 0,
    });
    expect(r.classification).toBe("true-source-gap");
    expect(r.honestCoveragePct).toBe(0);
  });

  it("block takes priority over source-presence (a fabrication is never a source gap)", () => {
    const r = classifyFacet({
      facet: "land-use",
      rawCoveragePct: 88,
      sourcePresent: true,
      verdict: "block",
      ownerMatchRate: 0.011,
      source: "cad-roll",
      sourceVintage: "2026",
      sampled: 2000,
    });
    expect(r.classification).toBe("fabricated-blocked");
  });
});
