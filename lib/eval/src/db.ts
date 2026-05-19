/**
 * Eval-side DB helpers. Wraps `@workspace/db` with the
 * insert/select queries the CLI uses, so call sites don't repeat
 * drizzle column lists.
 *
 * Re-exports the upstream `db` handle so the CLI imports one symbol.
 */

import { db, evalRuns, evalScores, evalBaselines } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import type { ComponentScore, RubricComponentKey } from "./types";

export { db, evalRuns, evalScores, evalBaselines };

export interface CreateEvalRunInput {
  engagementId: string | null;
  fixtureKey: string;
  engineVersion: string;
  triggerSource: "manual" | "ci" | "scheduled";
}

export async function createEvalRun(
  input: CreateEvalRunInput,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(evalRuns)
    .values({
      engagementId: input.engagementId ?? undefined,
      fixtureKey: input.fixtureKey,
      engineVersion: input.engineVersion,
      triggerSource: input.triggerSource,
      state: "running",
    })
    .returning({ id: evalRuns.id });
  return { id: row.id };
}

export interface CompleteEvalRunInput {
  id: string;
  state: "completed" | "failed";
  error?: string | null;
  totalCostUsd?: number;
  totalDurationMs?: number;
}

export async function completeEvalRun(input: CompleteEvalRunInput): Promise<void> {
  await db
    .update(evalRuns)
    .set({
      state: input.state,
      error: input.error ?? null,
      completedAt: new Date(),
      totalCostUsd:
        input.totalCostUsd !== undefined ? String(input.totalCostUsd) : null,
      totalDurationMs: input.totalDurationMs ?? null,
    })
    .where(eq(evalRuns.id, input.id));
}

export async function insertScores(
  evalRunId: string,
  scores: ReadonlyArray<ComponentScore>,
  baselines: ReadonlyMap<string, { score: number; threshold: number }>,
): Promise<void> {
  if (scores.length === 0) return;
  await db.insert(evalScores).values(
    scores.map((s) => {
      const baseline = baselines.get(s.componentKey);
      const passedThreshold =
        baseline === undefined
          ? null
          : passesRegressionThreshold(s, baseline.score, baseline.threshold);
      return {
        evalRunId,
        componentKey: s.componentKey,
        score: String(s.score),
        scoreUnit: s.scoreUnit,
        passedThreshold,
        details: s.details ?? null,
      };
    }),
  );
}

/**
 * Has this score regressed against its baseline beyond the allowed
 * threshold? Higher-is-better components fail when score drops > N%
 * below baseline; lower-is-better when score rises > N% above
 * baseline. The rubric catalog carries the orientation; the aggregator
 * is responsible for passing the right interpretation through.
 *
 * Defaulting to "passed" on equal scores so the very first run against
 * a freshly-set baseline doesn't false-flag.
 */
function passesRegressionThreshold(
  score: ComponentScore,
  baselineScore: number,
  thresholdFraction: number,
): boolean {
  if (baselineScore === 0) return true;
  const delta = (score.score - baselineScore) / baselineScore;
  if (score.scoreUnit === "fraction") {
    // Higher is better — regression is a drop beyond -threshold.
    return delta >= -thresholdFraction;
  }
  if (score.scoreUnit === "ms" || score.scoreUnit === "usd") {
    // Lower is better — regression is a rise beyond +threshold.
    return delta <= thresholdFraction;
  }
  // `count` (precision sample) is not auto-graded.
  return true;
}

export async function loadBaselinesFor(
  fixtureKey: string,
): Promise<ReadonlyMap<string, { score: number; threshold: number }>> {
  const rows = await db
    .select()
    .from(evalBaselines)
    .where(eq(evalBaselines.fixtureKey, fixtureKey));
  return new Map(
    rows.map((r) => [
      r.componentKey,
      { score: Number(r.baselineScore), threshold: Number(r.regressionThreshold) },
    ]),
  );
}

export interface UpsertBaselineInput {
  fixtureKey: string;
  componentKey: RubricComponentKey;
  baselineScore: number;
  regressionThreshold: number;
  commitHash: string;
}

export async function upsertBaseline(input: UpsertBaselineInput): Promise<void> {
  // Drizzle's `onConflictDoUpdate` requires the unique-index target.
  await db
    .insert(evalBaselines)
    .values({
      fixtureKey: input.fixtureKey,
      componentKey: input.componentKey,
      baselineScore: String(input.baselineScore),
      regressionThreshold: String(input.regressionThreshold),
      commitHash: input.commitHash,
    })
    .onConflictDoUpdate({
      target: [evalBaselines.fixtureKey, evalBaselines.componentKey],
      set: {
        baselineScore: String(input.baselineScore),
        regressionThreshold: String(input.regressionThreshold),
        commitHash: input.commitHash,
        lastUpdated: new Date(),
      },
    });
}

export async function loadEvalRun(id: string): Promise<{
  run: typeof evalRuns.$inferSelect | null;
  scores: ReadonlyArray<typeof evalScores.$inferSelect>;
}> {
  const [run] = await db.select().from(evalRuns).where(eq(evalRuns.id, id));
  if (!run) return { run: null, scores: [] };
  const scores = await db
    .select()
    .from(evalScores)
    .where(eq(evalScores.evalRunId, id));
  return { run, scores };
}

export async function loadLatestEvalRun(
  fixtureKey: string,
): Promise<typeof evalRuns.$inferSelect | null> {
  const [run] = await db
    .select()
    .from(evalRuns)
    .where(
      and(
        eq(evalRuns.fixtureKey, fixtureKey),
        eq(evalRuns.state, "completed"),
      ),
    )
    .orderBy(desc(evalRuns.startedAt))
    .limit(1);
  return run ?? null;
}
