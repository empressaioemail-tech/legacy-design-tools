/**
 * Aggregator. Glues runner samples to rubric scorers, producing a
 * `FixtureRunResult` the CLI can persist + render.
 *
 * Pure transform (no IO) so the same function backs both the CLI's
 * live runs and any future regression-replay path that reads
 * historical samples.
 */

import {
  RUBRIC_CATALOG,
  percentiles,
  scoreCitationValidity,
  scoreCostPerFindingRun,
  scoreFindingPrecisionSample,
  scoreFindingRecall,
  scoreLatency,
  scoreRetrievalCrossRef,
  scoreRetrievalSectionNumber,
  scoreRetrievalTop3,
  type RetrievalSample,
} from "./rubric";
import type {
  AnthropicCallRecord,
  ComponentScore,
  EngineFinding,
  ExpectedFinding,
  FixtureGroundTruth,
  FixtureRunResult,
  RunnerSample,
} from "./types";

export interface AggregatorInput {
  fixture: FixtureGroundTruth;
  engineVersion: string;
  startedAt: Date;
  /** Finding-engine run's surviving findings + invalid citations. */
  findingResult: {
    findings: ReadonlyArray<EngineFinding>;
    invalidCitations: ReadonlyArray<string>;
  } | null;
  retrievalSamples: ReadonlyArray<RetrievalSample>;
  /** One `RunnerSample` per engine sub-call (finding/briefing/retrieval). */
  samples: ReadonlyArray<RunnerSample>;
  /**
   * Optional pre-computed LLM-graded per-finding citation-accuracy
   * values (one per finding the engine produced). Null when the
   * accuracy judge wasn't run.
   */
  perFindingCitationAccuracy?: ReadonlyArray<number>;
}

export function aggregateRun(input: AggregatorInput): FixtureRunResult {
  const scores: ComponentScore[] = [];

  // Citation rubric — runs only when the finding engine produced output.
  if (input.findingResult) {
    scores.push(
      scoreCitationValidity(
        input.findingResult.findings,
        input.findingResult.invalidCitations,
      ),
    );
    if (input.perFindingCitationAccuracy) {
      // Scorer is exported but we omit the import-of-import here —
      // the same import block at the top already pulls everything we
      // need. Direct call:
      // scoreCitationAccuracy(input.perFindingCitationAccuracy)
      // is the right call; for clarity inline it through a local.
      scores.push({
        componentKey: "citation-accuracy",
        score:
          input.perFindingCitationAccuracy.length === 0
            ? 1
            : input.perFindingCitationAccuracy.reduce((a, b) => a + b, 0) /
              input.perFindingCitationAccuracy.length,
        scoreUnit: "fraction",
        details: { graded: input.perFindingCitationAccuracy.length },
      });
    }

    // Recall + precision sample — only when ground-truth is populated.
    if (input.fixture.expectedFindings.length > 0) {
      scores.push(
        scoreFindingRecall(
          input.findingResult.findings,
          input.fixture.expectedFindings as ExpectedFinding[],
        ),
      );
      scores.push(
        scoreFindingPrecisionSample(
          input.findingResult.findings,
          input.fixture.expectedFindings as ExpectedFinding[],
        ),
      );
    }
  }

  // Retrieval rubric — only when retrieval queries ran.
  if (input.retrievalSamples.length > 0) {
    scores.push(scoreRetrievalTop3(input.retrievalSamples));
    scores.push(scoreRetrievalSectionNumber(input.retrievalSamples));
    scores.push(scoreRetrievalCrossRef(input.retrievalSamples));
  }

  // Latency — per engine, drawn from `RunnerSample.durationMs` rolled
  // across multiple calls (today, exactly one call per engine per run;
  // the shape supports multi-call runs when finding-engine adds
  // chunked passes).
  const durationsByEngine = bucketDurations(input.samples);
  for (const [engine, durations] of durationsByEngine) {
    // Retrieval latency uses per-query durations from the payload, not
    // the rolled sum. For finding + briefing, durationMs is the
    // engine call.
    if (engine === "retrieval") {
      const perQuery = durations; // already flattened below
      scores.push(...scoreLatency(engine, perQuery));
    } else {
      scores.push(...scoreLatency(engine, durations));
    }
  }

  // Cost — sum across every Anthropic call captured.
  const allCalls: AnthropicCallRecord[] = input.samples.flatMap(
    (s) => s.anthropicCalls as AnthropicCallRecord[],
  );
  if (allCalls.length > 0) {
    scores.push(scoreCostPerFindingRun(allCalls));
  }

  const totalCostUsd = allCalls.reduce((sum, c) => sum + c.costUsd, 0);
  const totalDurationMs = input.samples.reduce(
    (sum, s) => sum + s.durationMs,
    0,
  );
  const completedAt = new Date();

  return {
    fixtureKey: input.fixture.key,
    engineVersion: input.engineVersion,
    startedAt: input.startedAt,
    completedAt,
    state: "completed",
    error: null,
    totalCostUsd,
    totalDurationMs,
    scores,
    samples: input.samples,
  };
}

/**
 * Build a `{engine → duration samples}` map from the run's
 * RunnerSamples. Retrieval flattens to per-query durations (sourced
 * from the payload's `perQueryDurations` array); finding + briefing
 * use the top-level `durationMs`.
 */
function bucketDurations(
  samples: ReadonlyArray<RunnerSample>,
): Map<"finding" | "briefing" | "retrieval", number[]> {
  const out = new Map<"finding" | "briefing" | "retrieval", number[]>();
  for (const s of samples) {
    const arr = out.get(s.engine) ?? [];
    if (
      s.engine === "retrieval" &&
      s.payload &&
      typeof s.payload === "object" &&
      "perQueryDurations" in s.payload &&
      Array.isArray((s.payload as { perQueryDurations: unknown }).perQueryDurations)
    ) {
      arr.push(
        ...((s.payload as { perQueryDurations: number[] }).perQueryDurations),
      );
    } else {
      arr.push(s.durationMs);
    }
    out.set(s.engine, arr);
  }
  return out;
}

/**
 * Format a single ComponentScore for human-readable scorecard output
 * (CLI `report` and CI PR comment). Aware of unit + orientation from
 * `RUBRIC_CATALOG`.
 */
export function formatScore(score: ComponentScore): string {
  const meta = RUBRIC_CATALOG[score.componentKey];
  const label = meta?.label ?? score.componentKey;
  if (score.scoreUnit === "fraction") {
    return `${label}: ${(score.score * 100).toFixed(1)}%`;
  }
  if (score.scoreUnit === "ms") {
    return `${label}: ${score.score.toFixed(0)} ms`;
  }
  if (score.scoreUnit === "usd") {
    return `${label}: $${score.score.toFixed(4)}`;
  }
  return `${label}: ${score.score}`;
}

/**
 * Re-export of `percentiles` for callers that compute their own
 * latency aggregates outside the aggregator pipeline.
 */
export { percentiles };
