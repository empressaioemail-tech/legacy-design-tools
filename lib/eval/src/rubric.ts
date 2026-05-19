/**
 * Rubric scoring functions for the plan-review engine eval harness.
 *
 * **Durable asset.** Every function in this file is pure: it takes
 * engine output + fixture ground-truth (or runner-captured samples)
 * and returns a `ComponentScore`. No DB, no LLM, no IO. This is the
 * file that ports to `hauska-engine` first when ADR-008 closes —
 * keep it that way.
 *
 * Each scorer corresponds to one `RubricComponentKey` in `types.ts`.
 * The catalog at the bottom of this file (`RUBRIC_COMPONENTS`) maps
 * keys → scorer functions so the runner can iterate without hard-
 * coding each call site.
 *
 * Score conventions per component (see types.ts `ScoreUnit`):
 *   - `fraction` components return a value in [0, 1] where higher is
 *     better unless explicitly noted.
 *   - `ms` and `usd` components return absolute values; the baseline
 *     comparator inverts the comparison (lower is better).
 *   - `count` components return integer counts; baseline comparison is
 *     component-specific (handled by the aggregator, not here).
 */

import type {
  AnthropicCallRecord,
  ComponentScore,
  EngineFinding,
  ExpectedFinding,
  RetrievalQuery,
  RubricComponentKey,
} from "./types";

// ───────────────────────────────────────────────────────────────────
// Citation rubric
// ───────────────────────────────────────────────────────────────────

/**
 * `citation-validity`: of all citation tokens the engine emitted, what
 * fraction resolved against the input's known atom set. Drawn from the
 * `invalidCitations` array on `GenerateFindingsResult` plus the
 * surviving `citations` arrays on each finding.
 *
 * 1.0 = no invalid citations emitted.
 * 0.0 = every citation was invalid.
 *
 * Edge case: if the engine emitted zero citations across zero
 * findings, we return 1.0 — a finding-less run is not a citation
 * problem. The recall scorer handles the "no findings at all" failure
 * mode.
 */
export function scoreCitationValidity(
  findings: ReadonlyArray<EngineFinding>,
  invalidCitations: ReadonlyArray<string>,
): ComponentScore {
  const survivingCitations = findings.reduce(
    (sum, f) => sum + f.citations.length,
    0,
  );
  const totalEmitted = survivingCitations + invalidCitations.length;
  if (totalEmitted === 0) {
    return {
      componentKey: "citation-validity",
      score: 1,
      scoreUnit: "fraction",
      details: { survivingCitations: 0, invalidCitations: 0 },
    };
  }
  return {
    componentKey: "citation-validity",
    score: survivingCitations / totalEmitted,
    scoreUnit: "fraction",
    details: {
      survivingCitations,
      invalidCitations: invalidCitations.length,
      invalidTokens: invalidCitations,
    },
  };
}

/**
 * `citation-accuracy`: harder than validity — does the citation
 * actually *support* the finding's claim? v1 is LLM-graded (the eval
 * runner posts each (finding, citation) pair to Claude Sonnet 4.5 and
 * asks "does this section support this claim? yes/no"). The scorer
 * here just averages the pre-computed per-finding accuracy values.
 *
 * Marked `requiresHumanReview: true` in fixtures for high-stakes
 * findings so the operator can spot-check the LLM judge.
 */
export function scoreCitationAccuracy(
  perFindingAccuracy: ReadonlyArray<number>,
): ComponentScore {
  if (perFindingAccuracy.length === 0) {
    return {
      componentKey: "citation-accuracy",
      score: 1,
      scoreUnit: "fraction",
      details: { graded: 0 },
    };
  }
  const avg =
    perFindingAccuracy.reduce((a, b) => a + b, 0) / perFindingAccuracy.length;
  return {
    componentKey: "citation-accuracy",
    score: avg,
    scoreUnit: "fraction",
    details: { graded: perFindingAccuracy.length, perFinding: perFindingAccuracy },
  };
}

// ───────────────────────────────────────────────────────────────────
// Finding rubric (recall + precision)
// ───────────────────────────────────────────────────────────────────

/**
 * Match an engine-surfaced finding against an expected finding.
 *
 * Two-tier matcher: (1) if the expected finding has
 * `expectedCitationAtomId`, the engine finding must cite that atom in
 * its `citations` array AND share the category. (2) otherwise fall
 * back to category match + a fuzzy text-similarity gate (Jaccard over
 * lowercased ≥3-char tokens, threshold 0.15).
 *
 * Exported so tests can pin the matcher behavior independently of the
 * recall/precision wrappers.
 */
export function findingMatchesExpected(
  engineFinding: EngineFinding,
  expected: ExpectedFinding,
): boolean {
  if (engineFinding.category !== expected.category) return false;

  if (expected.expectedCitationAtomId) {
    return engineFinding.citations.some(
      (c) =>
        c.kind === "code-section" &&
        c.atomId === expected.expectedCitationAtomId,
    );
  }

  return jaccardSimilarity(engineFinding.text, expected.text) >= 0.15;
}

/**
 * `finding-recall`: (engine-surfaced ∩ ground-truth) / |ground-truth|.
 * Optional ground-truth findings (`optional: true`) are excluded from
 * the denominator — they neither help nor hurt the score.
 *
 * Empty ground-truth array: returns 1.0 with a `notApplicable: true`
 * detail so the aggregator can suppress the component in scorecards
 * rather than reporting a meaningless 1.0.
 */
export function scoreFindingRecall(
  findings: ReadonlyArray<EngineFinding>,
  expected: ReadonlyArray<ExpectedFinding>,
): ComponentScore {
  const required = expected.filter((e) => !e.optional);
  if (required.length === 0) {
    return {
      componentKey: "finding-recall",
      score: 1,
      scoreUnit: "fraction",
      details: { notApplicable: true, reason: "no required ground-truth findings" },
    };
  }
  const surfaced = required.filter((e) =>
    findings.some((f) => findingMatchesExpected(f, e)),
  );
  const missed = required.filter(
    (e) => !findings.some((f) => findingMatchesExpected(f, e)),
  );
  return {
    componentKey: "finding-recall",
    score: surfaced.length / required.length,
    scoreUnit: "fraction",
    details: {
      requiredTotal: required.length,
      surfacedCount: surfaced.length,
      missedIds: missed.map((m) => m.id),
    },
  };
}

/**
 * `finding-precision`: surfaced findings NOT in the ground-truth set.
 *
 * **v1 does not auto-score this.** The dispatch is explicit: without
 * a human-zero reviewer cycle in CI, we can't tell a true false
 * positive from a legitimate new finding the reviewer missed. We
 * return the count and surface the sample for human review; the
 * baseline comparator skips this component.
 *
 * `scoreUnit: "count"` rather than "fraction" so the aggregator
 * renders it as a raw number, not a percentage.
 */
export function scoreFindingPrecisionSample(
  findings: ReadonlyArray<EngineFinding>,
  expected: ReadonlyArray<ExpectedFinding>,
): ComponentScore {
  const unmatched = findings.filter(
    (f) => !expected.some((e) => findingMatchesExpected(f, e)),
  );
  return {
    componentKey: "finding-precision",
    score: unmatched.length,
    scoreUnit: "count",
    details: {
      candidateFalsePositives: unmatched.map((f) => ({
        atomId: f.atomId,
        severity: f.severity,
        category: f.category,
        textPreview: f.text.slice(0, 120),
      })),
      note:
        "v1 does not auto-judge precision — human-zero reviewer cycle required.",
    },
  };
}

// ───────────────────────────────────────────────────────────────────
// Retrieval rubric (per 49 §B.4)
// ───────────────────────────────────────────────────────────────────

export interface RetrievalSample {
  query: RetrievalQuery;
  /** Top-K atom ids returned by retrieveAtomsForQuestion, in rank order. */
  returnedAtomIds: ReadonlyArray<string>;
  /** Section numbers parallel to `returnedAtomIds`. Null where absent. */
  returnedSectionNumbers: ReadonlyArray<string | null>;
}

/**
 * `retrieval-top3`: fraction of queries with `expectedTop3AtomId`
 * whose top-3 returned ids contain that atom. Per 49 §B.4 target: 90%.
 */
export function scoreRetrievalTop3(
  samples: ReadonlyArray<RetrievalSample>,
): ComponentScore {
  const eligible = samples.filter((s) => s.query.expectedTop3AtomId);
  if (eligible.length === 0) {
    return {
      componentKey: "retrieval-top3",
      score: 1,
      scoreUnit: "fraction",
      details: { notApplicable: true },
    };
  }
  const hits = eligible.filter((s) =>
    s.returnedAtomIds
      .slice(0, 3)
      .includes(s.query.expectedTop3AtomId as string),
  );
  return {
    componentKey: "retrieval-top3",
    score: hits.length / eligible.length,
    scoreUnit: "fraction",
    details: {
      eligibleQueries: eligible.length,
      hits: hits.length,
      missedQueryIds: eligible
        .filter(
          (s) =>
            !s.returnedAtomIds
              .slice(0, 3)
              .includes(s.query.expectedTop3AtomId as string),
        )
        .map((s) => s.query.id),
    },
  };
}

/**
 * `retrieval-section-number`: section-number lookups must land 1-for-1.
 * Per 49 §B.4 target: 100%.
 */
export function scoreRetrievalSectionNumber(
  samples: ReadonlyArray<RetrievalSample>,
): ComponentScore {
  const eligible = samples.filter((s) => s.query.expectedSectionNumber);
  if (eligible.length === 0) {
    return {
      componentKey: "retrieval-section-number",
      score: 1,
      scoreUnit: "fraction",
      details: { notApplicable: true },
    };
  }
  const hits = eligible.filter((s) =>
    s.returnedSectionNumbers.some(
      (sn) => sn === s.query.expectedSectionNumber,
    ),
  );
  return {
    componentKey: "retrieval-section-number",
    score: hits.length / eligible.length,
    scoreUnit: "fraction",
    details: {
      eligibleQueries: eligible.length,
      hits: hits.length,
    },
  };
}

/**
 * `retrieval-cross-ref`: cross-reference resolution. Per 49 §B.4
 * target: 95%. **Expected to score low** — the legacy engine has no
 * graph traversal of `code-cross-reference` edges. The component
 * exists to quantify the gap; the design-fresh fix lives in
 * hauska-engine.
 */
export function scoreRetrievalCrossRef(
  samples: ReadonlyArray<RetrievalSample>,
): ComponentScore {
  const eligible = samples.filter((s) => s.query.expectedCrossRefAtomId);
  if (eligible.length === 0) {
    return {
      componentKey: "retrieval-cross-ref",
      score: 1,
      scoreUnit: "fraction",
      details: { notApplicable: true },
    };
  }
  const hits = eligible.filter((s) =>
    s.returnedAtomIds.includes(s.query.expectedCrossRefAtomId as string),
  );
  return {
    componentKey: "retrieval-cross-ref",
    score: hits.length / eligible.length,
    scoreUnit: "fraction",
    details: {
      eligibleQueries: eligible.length,
      hits: hits.length,
      gapNote:
        "Legacy engine has no graph traversal of code-cross-reference edges. Low score is expected.",
    },
  };
}

// ───────────────────────────────────────────────────────────────────
// Latency rubric
// ───────────────────────────────────────────────────────────────────

/**
 * Compute p50/p95/p99 from a duration sample list. Linear interpolation
 * between adjacent points; sample length zero returns zero for all
 * percentiles.
 *
 * Exported because the test suite pins percentile arithmetic directly.
 */
export function percentiles(
  samplesMs: ReadonlyArray<number>,
): { p50: number; p95: number; p99: number } {
  if (samplesMs.length === 0) return { p50: 0, p95: 0, p99: 0 };
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const pick = (p: number): number => {
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  };
  return { p50: pick(0.5), p95: pick(0.95), p99: pick(0.99) };
}

/**
 * Emit three latency components (`p50/p95/p99`) for one engine
 * (`finding` | `briefing` | `retrieval`).
 */
export function scoreLatency(
  engine: "finding" | "briefing" | "retrieval",
  durationsMs: ReadonlyArray<number>,
): ComponentScore[] {
  const { p50, p95, p99 } = percentiles(durationsMs);
  const prefix = `latency-${engine}` as const;
  return [
    {
      componentKey: `${prefix}-p50` as RubricComponentKey,
      score: p50,
      scoreUnit: "ms",
      details: { samples: durationsMs.length },
    },
    {
      componentKey: `${prefix}-p95` as RubricComponentKey,
      score: p95,
      scoreUnit: "ms",
      details: { samples: durationsMs.length },
    },
    {
      componentKey: `${prefix}-p99` as RubricComponentKey,
      score: p99,
      scoreUnit: "ms",
      details: { samples: durationsMs.length },
    },
  ];
}

// ───────────────────────────────────────────────────────────────────
// Cost rubric (structural-commitment-#3 enforcement)
// ───────────────────────────────────────────────────────────────────

/**
 * `cost-per-finding-run`: sum of Anthropic spend for one finding-engine
 * run. The instrumented client pre-computes `costUsd` per call; we
 * just sum.
 */
export function scoreCostPerFindingRun(
  calls: ReadonlyArray<AnthropicCallRecord>,
): ComponentScore {
  const total = calls.reduce((sum, c) => sum + c.costUsd, 0);
  return {
    componentKey: "cost-per-finding-run",
    score: total,
    scoreUnit: "usd",
    details: {
      calls: calls.length,
      totalInputTokens: calls.reduce((s, c) => s + c.inputTokens, 0),
      totalOutputTokens: calls.reduce((s, c) => s + c.outputTokens, 0),
    },
  };
}

/**
 * `cost-per-jurisdiction`: aggregator-fed total across every eval run
 * scoped to a jurisdiction. The CLI's `report --by-jurisdiction` view
 * is the primary consumer; this scorer just sums the supplied
 * per-run totals.
 *
 * Per CLAUDE.md structural commitment #3: target is under $200 per
 * jurisdiction onboarded. The eval signal is a leading indicator —
 * if per-fixture cost trends upward, jurisdiction onboarding cost will
 * follow.
 */
export function scoreCostPerJurisdiction(
  perRunCostsUsd: ReadonlyArray<number>,
): ComponentScore {
  const total = perRunCostsUsd.reduce((a, b) => a + b, 0);
  return {
    componentKey: "cost-per-jurisdiction",
    score: total,
    scoreUnit: "usd",
    details: { runs: perRunCostsUsd.length },
  };
}

// ───────────────────────────────────────────────────────────────────
// Component catalog (registry → scorer fn signatures)
// ───────────────────────────────────────────────────────────────────

/**
 * Metadata about each rubric component: human label, score
 * orientation (`higher_is_better` vs `lower_is_better`), and a
 * one-line description. Used by the CLI's `report` to render scorecards
 * and by the CI workflow to render PR comments.
 *
 * Adding a new component is: (1) add the key to
 * `RUBRIC_COMPONENT_KEYS` in types.ts, (2) implement a scorer above,
 * (3) add an entry here. No migration; the DB stores free text.
 */
export const RUBRIC_CATALOG: Record<
  RubricComponentKey,
  {
    label: string;
    orientation: "higher_is_better" | "lower_is_better";
    description: string;
    /**
     * Recommended regression-threshold default (fraction of baseline).
     * Operators may override per-fixture in `eval_baselines`.
     */
    defaultRegressionThreshold: number;
  }
> = {
  "citation-validity": {
    label: "Citation validity",
    orientation: "higher_is_better",
    description:
      "Fraction of emitted citation tokens that resolved against the input's known atom set.",
    defaultRegressionThreshold: 0.02,
  },
  "citation-accuracy": {
    label: "Citation accuracy",
    orientation: "higher_is_better",
    description:
      "LLM-graded: does each emitted citation actually support the finding's claim?",
    defaultRegressionThreshold: 0.05,
  },
  "finding-recall": {
    label: "Finding recall",
    orientation: "higher_is_better",
    description:
      "Fraction of ground-truth findings the engine surfaced.",
    defaultRegressionThreshold: 0.05,
  },
  "finding-precision": {
    label: "Finding precision (sample)",
    orientation: "higher_is_better",
    description:
      "v1 surfaces a sample of unmatched engine findings for human review; no auto-score.",
    defaultRegressionThreshold: 0,
  },
  "retrieval-top3": {
    label: "Retrieval top-3",
    orientation: "higher_is_better",
    description:
      "Per 49 §B.4: query returns expected atom in top-3. Target 0.90.",
    defaultRegressionThreshold: 0.05,
  },
  "retrieval-section-number": {
    label: "Retrieval section-number lookup",
    orientation: "higher_is_better",
    description:
      "Per 49 §B.4: section-number → atom resolves 1-for-1. Target 1.00.",
    defaultRegressionThreshold: 0.02,
  },
  "retrieval-cross-ref": {
    label: "Retrieval cross-reference",
    orientation: "higher_is_better",
    description:
      "Per 49 §B.4: cross-reference resolution. Target 0.95. Legacy engine has no graph traversal — score expected to be low.",
    defaultRegressionThreshold: 0.1,
  },
  "latency-finding-p50": {
    label: "Finding-engine latency (p50)",
    orientation: "lower_is_better",
    description: "Median wall-clock per finding-engine call.",
    defaultRegressionThreshold: 0.2,
  },
  "latency-finding-p95": {
    label: "Finding-engine latency (p95)",
    orientation: "lower_is_better",
    description: "95th-percentile wall-clock per finding-engine call.",
    defaultRegressionThreshold: 0.2,
  },
  "latency-finding-p99": {
    label: "Finding-engine latency (p99)",
    orientation: "lower_is_better",
    description: "99th-percentile wall-clock per finding-engine call.",
    defaultRegressionThreshold: 0.25,
  },
  "latency-briefing-p50": {
    label: "Briefing-engine latency (p50)",
    orientation: "lower_is_better",
    description: "Median wall-clock per briefing-engine call.",
    defaultRegressionThreshold: 0.2,
  },
  "latency-briefing-p95": {
    label: "Briefing-engine latency (p95)",
    orientation: "lower_is_better",
    description: "95th-percentile wall-clock per briefing-engine call.",
    defaultRegressionThreshold: 0.2,
  },
  "latency-briefing-p99": {
    label: "Briefing-engine latency (p99)",
    orientation: "lower_is_better",
    description: "99th-percentile wall-clock per briefing-engine call.",
    defaultRegressionThreshold: 0.25,
  },
  "latency-retrieval-p50": {
    label: "Retrieval latency (p50)",
    orientation: "lower_is_better",
    description: "Median wall-clock per retrieval call.",
    defaultRegressionThreshold: 0.2,
  },
  "latency-retrieval-p95": {
    label: "Retrieval latency (p95)",
    orientation: "lower_is_better",
    description: "95th-percentile wall-clock per retrieval call.",
    defaultRegressionThreshold: 0.2,
  },
  "latency-retrieval-p99": {
    label: "Retrieval latency (p99)",
    orientation: "lower_is_better",
    description: "99th-percentile wall-clock per retrieval call.",
    defaultRegressionThreshold: 0.25,
  },
  "cost-per-finding-run": {
    label: "Cost per finding-engine run (USD)",
    orientation: "lower_is_better",
    description:
      "Sum of Anthropic spend across all messages.create calls in one finding-engine run.",
    defaultRegressionThreshold: 0.15,
  },
  "cost-per-jurisdiction": {
    label: "Cost per jurisdiction (USD)",
    orientation: "lower_is_better",
    description:
      "Aggregate Anthropic spend across all eval runs scoped to one jurisdiction. Tracks structural-commitment-#3 ($200 onboarding budget).",
    defaultRegressionThreshold: 0.15,
  },
};

// ───────────────────────────────────────────────────────────────────
// Internal helpers
// ───────────────────────────────────────────────────────────────────

/**
 * Jaccard similarity over the set of lowercased ≥3-char tokens. Cheap,
 * symmetric, no embedding required — sufficient for the recall
 * matcher's text-fuzzy fallback.
 */
function jaccardSimilarity(a: string, b: string): number {
  const tok = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3),
    );
  const A = tok(a);
  const B = tok(b);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}
