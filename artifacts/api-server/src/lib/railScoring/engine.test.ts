/**
 * ENGINE TESTS — every one of these is a gate proven able to FIRE.
 *
 * DEV_PROCESS 2.2: a gating indicator is tested for its ability to fire
 * before it is trusted; a test that cannot fail for the right reason is a
 * defect, not a test. Each block below is a rule the engine centralises
 * BECAUSE a per-rail scorer got it wrong somewhere in the live ledger.
 */

import { describe, it, expect } from "vitest";
import {
  railCellChanged,
  resolveAbsence,
  scoreRailCell,
  type RailCellMeasurement,
  type RailLedgerValues,
} from "./engine";
import { classifyFacet } from "../countyCoverageClassification";
import type {
  AtomCountRule,
  RailScoringRule,
  UnspecifiedRule,
} from "./registry";

const atomRule: AtomCountRule = {
  railKey: "flood",
  kind: "atom-count-over-parcel-features",
  entityType: "flood-hazard-fact",
  instrument: "countyRailScoreCli.ts:flood",
  verificationMethod: "sweep",
  denominator: {
    kind: "txgio-parcel-distinct-feature-index",
    basis: "count(DISTINCT feature_index) in txgio_parcel for the county",
  },
};

const absenceCapableRule: AtomCountRule = {
  ...atomRule,
  railKey: "mud",
  absenceProbe: {
    kind: "source-table-zero-rows",
    table: "tx_special_district",
    fipsColumn: "county_fips",
    basis: "tceq-tx_special_district-statewide-zero-districts-for-fips",
    reach: { kind: "statewide" },
  },
};

const harrisOnlyRule: AtomCountRule = {
  ...atomRule,
  railKey: "rrc-wells",
  absenceProbe: {
    kind: "source-table-zero-rows",
    table: "rrc_wells",
    fipsColumn: "county_fips",
    basis: "rrc-wells-zero-for-fips",
    reach: { kind: "enumerated-counties", counties: ["48201"] },
  },
};

const unspecifiedRule: UnspecifiedRule = {
  railKey: "footprint",
  kind: "unspecified",
  instrument: "countyRailScoreCli.ts:footprint",
  verificationMethod: "sweep",
  denominator: { kind: "none", basis: "no measurement spec yet" },
  unspecifiedReason: "no spec",
  specOwner: "SS-W14",
};

function measurement(over: Partial<RailCellMeasurement> = {}): RailCellMeasurement {
  return {
    countyFips: "48021",
    numerator: 900,
    denominator: 1000,
    sourcePresent: true,
    source: "flood-hazard-fact-atom-count",
    ...over,
  };
}

describe("no clamping (SF-25)", () => {
  it("an OVERCOUNT fails closed to not-yet and keeps the honest ratio above 100", () => {
    // score_cad_rails_fast.mjs used Math.min(100, ...), which turns duplicate
    // or stale atoms into a satisfied cell at exactly 100%. 762 live
    // owner/landuse/cad rows were written that way.
    const score = scoreRailCell(atomRule, 95, measurement({ numerator: 1200, denominator: 1000 }));
    expect(score.overcount).toBe(true);
    expect(score.railState).toBe("not-yet");
    expect(score.honestCoveragePct).toBeCloseTo(120, 5);
    expect(score.honestCoveragePct).toBeGreaterThan(100);
  });

  it("an exactly-at-denominator count is NOT an overcount and can satisfy", () => {
    // The negative case: proves the overcount branch discriminates rather
    // than firing on everything near the boundary.
    const score = scoreRailCell(atomRule, 95, measurement({ numerator: 1000, denominator: 1000 }));
    expect(score.overcount).toBe(false);
    expect(score.railState).toBe("satisfied-present");
    expect(score.honestCoveragePct).toBe(100);
  });
});

describe("threshold comes from the rail dimension, not the scorer", () => {
  it("the SAME measurement satisfies at threshold 90 and does not at 95", () => {
    const m = measurement({ numerator: 920, denominator: 1000 });
    expect(scoreRailCell(atomRule, 90, m).railState).toBe("satisfied-present");
    expect(scoreRailCell(atomRule, 95, m).railState).toBe("not-yet");
  });

  it("a below-threshold cell keeps its REAL coverage rather than being zeroed", () => {
    const score = scoreRailCell(atomRule, 95, measurement({ numerator: 500, denominator: 1000 }));
    expect(score.railState).toBe("not-yet");
    expect(score.honestCoveragePct).toBe(50);
  });
});

describe("absence is a positive finding, never an empty result", () => {
  it("REFUSES an absence for a rail that declares no probe", () => {
    const r = resolveAbsence(atomRule, "48021", { basis: "looked and saw nothing" });
    expect(r.allowed).toBe(false);
    expect(r.allowed === false && r.reason).toMatch(/declares no absence probe/);
  });

  it("REFUSES an absence for a county outside the source's reach", () => {
    // The RRC-wells incident, mechanized: a Harris-only source cannot report
    // Dallas empty.
    const r = resolveAbsence(harrisOnlyRule, "48113", { basis: "zero wells" });
    expect(r.allowed).toBe(false);
    expect(r.allowed === false && r.reason).toMatch(/does not cover this county/);
  });

  it("ALLOWS an absence inside the source's reach — the gate is not stuck closed", () => {
    const r = resolveAbsence(harrisOnlyRule, "48201", { basis: "zero wells" });
    expect(r.allowed).toBe(true);
  });

  it("REFUSES an absence with an empty basis", () => {
    const r = resolveAbsence(absenceCapableRule, "48021", { basis: "   " });
    expect(r.allowed).toBe(false);
    expect(r.allowed === false && r.reason).toMatch(/no basis/);
  });

  it("an established absence writes satisfied-absent WITH its basis and coverage 0", () => {
    const score = scoreRailCell(
      absenceCapableRule,
      90,
      measurement({
        countyFips: "48003",
        numerator: 0,
        denominator: null,
        sourcePresent: false,
        absence: { basis: "tceq-tx_special_district-statewide-zero-districts-for-fips" },
      }),
    );
    expect(score.railState).toBe("satisfied-absent");
    expect(score.absenceBasis).toBe(
      "tceq-tx_special_district-statewide-zero-districts-for-fips",
    );
    expect(score.honestCoveragePct).toBe(0);
  });

  it("a NULL denominator with no determination is not-yet, never absent", () => {
    const score = scoreRailCell(
      atomRule,
      95,
      measurement({ numerator: 0, denominator: null, sourcePresent: false }),
    );
    expect(score.railState).toBe("not-yet");
    expect(score.absenceBasis).toBeNull();
  });

  it("a refused absence is REPORTED on the cell rather than swallowed", () => {
    const score = scoreRailCell(
      harrisOnlyRule,
      90,
      measurement({
        countyFips: "48113",
        numerator: 0,
        denominator: null,
        sourcePresent: false,
        absence: { basis: "zero wells" },
      }),
    );
    expect(score.railState).toBe("not-yet");
    expect(score.absenceRefusedReason).toMatch(/does not cover this county/);
  });
});

describe("an unspecified rail is refused, never scored as zero", () => {
  it("throws, naming the rail and its spec owner", () => {
    expect(() =>
      scoreRailCell(unspecifiedRule as RailScoringRule, 90, measurement()),
    ).toThrow(/no measurement spec.*SS-W14/s);
  });
});

describe("facet equals rail key by construction", () => {
  it("takes the facet from the rule, so a hand-typed key cannot orphan a row", () => {
    // countyCoverageScoreCli.ts writes facet 'land-use' while the rail is
    // 'landuse'; the manifest grid joins facet = rail_key, so those 19 live
    // rows have never rendered a cell.
    expect(scoreRailCell(atomRule, 95, measurement()).facet).toBe(atomRule.railKey);
    expect(scoreRailCell(absenceCapableRule, 90, measurement()).facet).toBe("mud");
  });
});

describe("provenance carries the denominator onto the row", () => {
  it("writes the canonical string into artifactPath, numerator and denominator included", () => {
    const score = scoreRailCell(atomRule, 95, measurement({ numerator: 900, denominator: 1000 }));
    expect(score.artifactPath).toContain("num=900");
    expect(score.artifactPath).toContain("den=1000");
    expect(score.artifactPath).toContain("denKind=txgio-parcel-distinct-feature-index");
  });
});

describe("idempotency is a VALUE diff, not a row count", () => {
  const base: RailLedgerValues = scoreRailCell(atomRule, 95, measurement());

  it("an identical re-score reports UNCHANGED", () => {
    const again = scoreRailCell(atomRule, 95, measurement());
    expect(railCellChanged(base, again)).toBe(false);
  });

  it("a moved coverage number reports CHANGED", () => {
    const moved = scoreRailCell(atomRule, 95, measurement({ numerator: 950 }));
    expect(railCellChanged(base, moved)).toBe(true);
  });

  it("a first-ever score (no prior row) reports CHANGED", () => {
    expect(railCellChanged(null, base)).toBe(true);
  });

  it("does NOT consider checked_at or last_verified_at — they are not in the value set", () => {
    // If a timestamp were part of RailLedgerValues, every run would report
    // every cell as moved and the delta would be meaningless.
    expect(Object.keys(base)).not.toContain("checkedAt");
    expect(Object.keys(base)).not.toContain("lastVerifiedAt");
  });

  it("a changed rail_state at the SAME coverage still reports CHANGED", () => {
    // Threshold moves are real ledger movement even when the percentage is
    // identical; a naive "did the number change" diff would miss it.
    const at90 = scoreRailCell(atomRule, 90, measurement({ numerator: 920 }));
    const at95 = scoreRailCell(atomRule, 95, measurement({ numerator: 920 }));
    expect(at90.honestCoveragePct).toBe(at95.honestCoveragePct);
    expect(railCellChanged(at90, at95)).toBe(true);
  });
});

describe("PINNED classifier behaviour (cross-lane drift detector)", () => {
  // classifyFacet lives in lib/countyCoverageClassification.ts, a pure leaf
  // module shared with the three scorer CLIs. This engine imports it rather
  // than duplicating it (DEV_PROCESS 6.2), so these assertions exist to make a
  // change over there fail HERE, loudly, instead of silently altering what
  // this engine writes. It used to live in countyCoverageScoreCli.ts; lane
  // SS-W18 moved it on 2026-08-19 because importing a CLI put the CLI in the
  // server boot graph and a canary deploy of 5688aa31 exited before Express
  // listened.
  it("sourcePresent=false yields true-source-gap at coverage 0", () => {
    const r = classifyFacet({
      facet: "flood",
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

  it("sourcePresent=true with no verdict yields real-at-ceiling and PASSES coverage through unclamped", () => {
    const r = classifyFacet({
      facet: "flood",
      rawCoveragePct: 137.5,
      sourcePresent: true,
      verdict: null,
      ownerMatchRate: null,
      source: "flood-hazard-fact-atom-count",
      sourceVintage: null,
      sampled: 0,
    });
    expect(r.classification).toBe("real-at-ceiling");
    expect(r.honestCoveragePct).toBe(137.5);
  });

  it("a verdict of block zeroes coverage — the engine relies on this for gated rails", () => {
    const r = classifyFacet({
      facet: "land-use",
      rawCoveragePct: 91.6,
      sourcePresent: true,
      verdict: "block",
      ownerMatchRate: 0,
      source: "cad-roll",
      sourceVintage: null,
      sampled: 2000,
    });
    expect(r.classification).toBe("fabricated-blocked");
    expect(r.honestCoveragePct).toBe(0);
  });
});
