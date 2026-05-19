/**
 * Unit tests for `rubric.ts`. These are the load-bearing tests for the
 * eval harness's durable asset — every scorer that ports to
 * hauska-engine must continue to pass these.
 *
 * Pure-function tests only. No DB, no LLM, no IO.
 */

import { describe, expect, it } from "vitest";
import {
  findingMatchesExpected,
  percentiles,
  RUBRIC_CATALOG,
  scoreCitationAccuracy,
  scoreCitationValidity,
  scoreCostPerFindingRun,
  scoreCostPerJurisdiction,
  scoreFindingPrecisionSample,
  scoreFindingRecall,
  scoreLatency,
  scoreRetrievalCrossRef,
  scoreRetrievalSectionNumber,
  scoreRetrievalTop3,
  type RetrievalSample,
} from "../rubric";
import type {
  AnthropicCallRecord,
  EngineFinding,
  ExpectedFinding,
  RetrievalQuery,
  RubricComponentKey,
} from "../types";
import { RUBRIC_COMPONENT_KEYS } from "../types";

const makeFinding = (
  overrides: Partial<EngineFinding> = {},
): EngineFinding => ({
  atomId: "finding:sub-1:abc",
  submissionId: "sub-1",
  severity: "concern",
  category: "setback",
  text: "Setback may not meet § 5.4 — verify the south yard dimension.",
  citations: [{ kind: "code-section", atomId: "code-grand-5-4" }],
  confidence: 0.8,
  lowConfidence: false,
  elementRef: null,
  sourceRef: null,
  aiGeneratedAt: new Date(),
  ...overrides,
});

const makeExpected = (
  overrides: Partial<ExpectedFinding> = {},
): ExpectedFinding => ({
  id: "exp-01",
  category: "setback",
  severity: "concern",
  text: "South-yard setback does not meet § 5.4 minimum",
  ...overrides,
});

describe("scoreCitationValidity", () => {
  it("returns 1.0 when no citations were emitted at all", () => {
    const score = scoreCitationValidity([], []);
    expect(score.componentKey).toBe("citation-validity");
    expect(score.score).toBe(1);
    expect(score.scoreUnit).toBe("fraction");
  });

  it("returns surviving / total when both populated", () => {
    const findings = [
      makeFinding({
        citations: [
          { kind: "code-section", atomId: "code-1" },
          { kind: "code-section", atomId: "code-2" },
        ],
      }),
    ];
    const score = scoreCitationValidity(findings, ["[[CODE:bogus]]"]);
    expect(score.score).toBeCloseTo(2 / 3, 5);
  });

  it("returns 0.0 when every citation was invalid", () => {
    const score = scoreCitationValidity([], ["[[CODE:a]]", "[[CODE:b]]"]);
    expect(score.score).toBe(0);
  });

  it("packs invalid token list into details for the auditor", () => {
    const score = scoreCitationValidity([], ["[[CODE:fake]]"]);
    expect(score.details).toMatchObject({
      invalidTokens: ["[[CODE:fake]]"],
      invalidCitations: 1,
    });
  });
});

describe("scoreCitationAccuracy", () => {
  it("returns 1.0 when nothing was graded (no findings to judge)", () => {
    expect(scoreCitationAccuracy([]).score).toBe(1);
  });

  it("averages per-finding values", () => {
    const score = scoreCitationAccuracy([1, 0.5, 0]);
    expect(score.score).toBeCloseTo(0.5, 5);
  });
});

describe("findingMatchesExpected", () => {
  it("requires matching category", () => {
    const finding = makeFinding({ category: "setback" });
    const expected = makeExpected({ category: "height" });
    expect(findingMatchesExpected(finding, expected)).toBe(false);
  });

  it("matches when expected citation atom id is cited", () => {
    const finding = makeFinding({
      citations: [{ kind: "code-section", atomId: "code-x" }],
    });
    const expected = makeExpected({ expectedCitationAtomId: "code-x" });
    expect(findingMatchesExpected(finding, expected)).toBe(true);
  });

  it("rejects when expected atom id is not in citations", () => {
    const finding = makeFinding({
      citations: [{ kind: "code-section", atomId: "code-y" }],
    });
    const expected = makeExpected({ expectedCitationAtomId: "code-x" });
    expect(findingMatchesExpected(finding, expected)).toBe(false);
  });

  it("falls back to text similarity when no citation id pinned", () => {
    const finding = makeFinding({
      text: "South yard setback fails the 5.4 minimum",
    });
    const expected = makeExpected({
      text: "South-yard setback does not meet § 5.4 minimum",
    });
    expect(findingMatchesExpected(finding, expected)).toBe(true);
  });

  it("returns false when text differs sharply and no citation id is pinned", () => {
    const finding = makeFinding({ text: "Wall height exceeds limit" });
    const expected = makeExpected({
      text: "South-yard setback does not meet § 5.4 minimum",
    });
    expect(findingMatchesExpected(finding, expected)).toBe(false);
  });
});

describe("scoreFindingRecall", () => {
  it("treats empty ground-truth as notApplicable", () => {
    const score = scoreFindingRecall([makeFinding()], []);
    expect(score.score).toBe(1);
    expect(score.details).toMatchObject({ notApplicable: true });
  });

  it("scores 1.0 when every required ground-truth is matched", () => {
    const expected = [
      makeExpected({ id: "a", expectedCitationAtomId: "code-1" }),
      makeExpected({ id: "b", expectedCitationAtomId: "code-2" }),
    ];
    const findings = [
      makeFinding({
        citations: [{ kind: "code-section", atomId: "code-1" }],
      }),
      makeFinding({
        atomId: "finding:sub-1:def",
        citations: [{ kind: "code-section", atomId: "code-2" }],
      }),
    ];
    expect(scoreFindingRecall(findings, expected).score).toBe(1);
  });

  it("scores 0.5 when half the required ground-truth is missed", () => {
    const expected = [
      makeExpected({ id: "a", expectedCitationAtomId: "code-1" }),
      makeExpected({ id: "b", expectedCitationAtomId: "code-missing" }),
    ];
    const findings = [
      makeFinding({
        citations: [{ kind: "code-section", atomId: "code-1" }],
      }),
    ];
    const score = scoreFindingRecall(findings, expected);
    expect(score.score).toBe(0.5);
    expect(score.details).toMatchObject({ missedIds: ["b"] });
  });

  it("excludes optional ground-truth from the denominator", () => {
    const expected = [
      makeExpected({ id: "a", expectedCitationAtomId: "code-1" }),
      makeExpected({
        id: "b",
        expectedCitationAtomId: "code-missing",
        optional: true,
      }),
    ];
    const findings = [
      makeFinding({
        citations: [{ kind: "code-section", atomId: "code-1" }],
      }),
    ];
    expect(scoreFindingRecall(findings, expected).score).toBe(1);
  });
});

describe("scoreFindingPrecisionSample", () => {
  it("returns a count, not a fraction", () => {
    const findings = [makeFinding(), makeFinding({ atomId: "finding:sub-1:two" })];
    const score = scoreFindingPrecisionSample(findings, []);
    expect(score.scoreUnit).toBe("count");
    expect(score.score).toBe(2);
  });

  it("includes a sample of unmatched findings for human review", () => {
    const findings = [
      makeFinding({ text: "x".repeat(200) }),
      makeFinding({ atomId: "finding:sub-1:two" }),
    ];
    const score = scoreFindingPrecisionSample(findings, []);
    expect(score.details).toMatchObject({
      candidateFalsePositives: [
        expect.objectContaining({ atomId: "finding:sub-1:abc" }),
        expect.objectContaining({ atomId: "finding:sub-1:two" }),
      ],
    });
  });
});

describe("scoreRetrieval{Top3,SectionNumber,CrossRef}", () => {
  const sample = (
    overrides: {
      query?: Partial<RetrievalQuery>;
      returnedAtomIds?: ReadonlyArray<string>;
      returnedSectionNumbers?: ReadonlyArray<string | null>;
    } = {},
  ): RetrievalSample => ({
    query: {
      id: "q1",
      jurisdictionKey: "grand_county_ut",
      question: "x",
      ...overrides.query,
    },
    returnedAtomIds: overrides.returnedAtomIds ?? [],
    returnedSectionNumbers: overrides.returnedSectionNumbers ?? [],
  });

  it("top-3: hits when expected atom is in first three", () => {
    const samples = [
      sample({
        query: { expectedTop3AtomId: "code-x" },
        returnedAtomIds: ["other-1", "code-x", "other-2", "other-3"],
      }),
    ];
    expect(scoreRetrievalTop3(samples).score).toBe(1);
  });

  it("top-3: miss when expected atom appears at rank 4+", () => {
    const samples = [
      sample({
        query: { expectedTop3AtomId: "code-x" },
        returnedAtomIds: ["o1", "o2", "o3", "code-x"],
      }),
    ];
    expect(scoreRetrievalTop3(samples).score).toBe(0);
  });

  it("section-number: matches any returned section number", () => {
    const samples = [
      sample({
        query: { expectedSectionNumber: "5.4" },
        returnedSectionNumbers: ["5.6", "5.4"],
      }),
    ];
    expect(scoreRetrievalSectionNumber(samples).score).toBe(1);
  });

  it("cross-ref: misses surface the gap-note in details", () => {
    const samples = [
      sample({
        query: { expectedCrossRefAtomId: "code-xref" },
        returnedAtomIds: ["other"],
      }),
    ];
    const score = scoreRetrievalCrossRef(samples);
    expect(score.score).toBe(0);
    expect(score.details).toMatchObject({
      gapNote: expect.stringContaining("Legacy engine has no graph traversal"),
    });
  });

  it("returns notApplicable when no queries target the component", () => {
    expect(scoreRetrievalTop3([sample()]).details).toMatchObject({
      notApplicable: true,
    });
  });
});

describe("percentiles + scoreLatency", () => {
  it("p50/p95/p99 on a single-element sample is that value", () => {
    expect(percentiles([42])).toEqual({ p50: 42, p95: 42, p99: 42 });
  });

  it("p50 of 1..9 is 5", () => {
    expect(percentiles([1, 2, 3, 4, 5, 6, 7, 8, 9]).p50).toBe(5);
  });

  it("p95 picks high end of distribution", () => {
    const { p95 } = percentiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 100]);
    expect(p95).toBeGreaterThan(50);
  });

  it("empty sample returns zero across the board", () => {
    expect(percentiles([])).toEqual({ p50: 0, p95: 0, p99: 0 });
  });

  it("scoreLatency emits the three keys for the named engine", () => {
    const scores = scoreLatency("finding", [100, 200, 300]);
    expect(scores.map((s) => s.componentKey)).toEqual([
      "latency-finding-p50",
      "latency-finding-p95",
      "latency-finding-p99",
    ]);
    expect(scores.every((s) => s.scoreUnit === "ms")).toBe(true);
  });
});

describe("scoreCost{PerFindingRun,PerJurisdiction}", () => {
  const call = (
    overrides: Partial<AnthropicCallRecord> = {},
  ): AnthropicCallRecord => ({
    durationMs: 100,
    inputTokens: 1000,
    outputTokens: 500,
    model: "claude-sonnet-4-5",
    costUsd: 0.01,
    ...overrides,
  });

  it("sums per-call cost into a per-run total", () => {
    const score = scoreCostPerFindingRun([
      call({ costUsd: 0.01 }),
      call({ costUsd: 0.02 }),
      call({ costUsd: 0.005 }),
    ]);
    expect(score.score).toBeCloseTo(0.035, 5);
    expect(score.scoreUnit).toBe("usd");
  });

  it("rolls per-run costs into per-jurisdiction total", () => {
    expect(scoreCostPerJurisdiction([1.5, 2.25, 0.75]).score).toBe(4.5);
  });

  it("reports zero across zero calls without throwing", () => {
    expect(scoreCostPerFindingRun([]).score).toBe(0);
  });
});

describe("RUBRIC_CATALOG covers every key", () => {
  it("has a catalog entry per RUBRIC_COMPONENT_KEYS entry", () => {
    for (const key of RUBRIC_COMPONENT_KEYS) {
      expect(RUBRIC_CATALOG[key as RubricComponentKey]).toBeDefined();
    }
  });

  it("orientation is one of two known values", () => {
    for (const key of RUBRIC_COMPONENT_KEYS) {
      expect(["higher_is_better", "lower_is_better"]).toContain(
        RUBRIC_CATALOG[key as RubricComponentKey].orientation,
      );
    }
  });
});
