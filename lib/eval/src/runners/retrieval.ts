/**
 * Retrieval runner. For each `RetrievalQuery` in the fixture, calls
 * `retrieveAtomsForQuestion` and returns the per-query top-K with
 * section-numbers extracted so the retrieval rubric scorers can match
 * against expected atom ids + section numbers.
 *
 * No Anthropic calls happen in this runner — retrieval is pure
 * vector/lexical against Postgres. The returned `RunnerSample` has an
 * empty `anthropicCalls` array; the cost rubric ignores retrieval-only
 * runs.
 */

import { retrieveAtomsForQuestion } from "@workspace/codes";
import type { RetrievalSample } from "../rubric";
import type {
  FixtureGroundTruth,
  RetrievalQuery,
  RunnerSample,
} from "../types";

export interface RetrievalRunOutput {
  sample: RunnerSample;
  /** Per-query retrieval samples — fed directly to retrieval rubric scorers. */
  retrievalSamples: RetrievalSample[];
}

export async function runRetrieval(
  fixture: FixtureGroundTruth,
): Promise<RetrievalRunOutput> {
  if (fixture.placeholder || fixture.retrievalQueries.length === 0) {
    return {
      sample: {
        engine: "retrieval",
        durationMs: 0,
        anthropicCalls: [],
        payload: { skipped: true, fixtureKey: fixture.key },
      },
      retrievalSamples: [],
    };
  }

  const retrievalSamples: RetrievalSample[] = [];
  const perQueryDurations: number[] = [];

  for (const q of fixture.retrievalQueries) {
    const t0 = Date.now();
    const atoms = await retrieveAtomsForQuestion({
      jurisdictionKey: q.jurisdictionKey,
      question: q.question,
      // Limit 8 — same default the chat path uses, and large enough to
      // give cross-reference / section-number lookups a fair shot
      // (top-3 scoring filters down to the first 3 itself).
      limit: 8,
    });
    perQueryDurations.push(Date.now() - t0);

    retrievalSamples.push({
      query: q as RetrievalQuery,
      returnedAtomIds: atoms.map((a) => a.id),
      returnedSectionNumbers: atoms.map((a) => a.sectionNumber),
    });
  }

  // The latency rubric for retrieval is computed from per-query
  // durations, not the sum. We pass the array through on the sample
  // payload so the aggregator can read it back.
  const totalDurationMs = perQueryDurations.reduce((a, b) => a + b, 0);

  return {
    sample: {
      engine: "retrieval",
      durationMs: totalDurationMs,
      anthropicCalls: [],
      payload: { perQueryDurations, retrievalSamples },
    },
    retrievalSamples,
  };
}
