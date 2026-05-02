import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { submissions } from "./submissions";

/**
 * AIR-1 finding-generation run. One row per kickoff of the AI compliance
 * checker against a submission. Mirrors `briefing_generation_jobs`
 * (lib/db/src/schema/briefingGenerationJobs.ts) verbatim, swapping
 * `engagement_id` → `submission_id` so the run is scoped to the
 * artifact the architect handed in for review.
 *
 * Why a real table (not an in-process Map): the
 * `GET /submissions/:id/findings/status` poll must surface the most
 * recent run's true outcome even after the api-server restarts mid-
 * flight, and a multi-instance deployment needs a coherent view across
 * processes. Mirrors `briefingGenerationJobs.ts` reasoning.
 *
 * Identity: the row's `id` IS the `generationId` returned to the client
 * on kickoff (no separate column). Stale polls with the old generationId
 * still find their row after subsequent runs.
 *
 * Single-flight: at most one row per `submission_id` may be in
 * `pending` at any time. Enforced by the partial unique index
 * `finding_runs_pending_per_submission_uniq` so concurrent kickoffs
 * cannot both win — the loser sees a unique-violation and the route
 * maps that to a 409 with the in-flight job's id.
 *
 * History: terminal rows (`completed` / `failed`) accumulate. The
 * sweep (`artifacts/api-server/src/lib/findingRunsSweep.ts`, ships
 * with this sprint) keeps the most-recent-N rows per submission;
 * default N = 5, override via `FINDING_RUNS_KEEP_PER_SUBMISSION`.
 *
 * Tracked counters (recon §1, locked decision):
 *   - `invalid_citation_count` — sum of citation tokens stripped by
 *     the validator across surviving findings.
 *   - `invalid_citations` — verbatim string array of those tokens
 *     so the auditor can see what was referenced but stripped
 *     (mirror of briefingGenerationJobs.invalidCitations / Task #176).
 *   - `discarded_finding_count` — count of findings the engine
 *     produced that were dropped entirely (every citation invalid
 *     AND no surviving anchor — see lib/finding-engine `engine.ts`'s
 *     discard rule). Distinct dimension from invalidCitations
 *     because a single finding can have one stripped token without
 *     being discarded.
 */
export const findingRuns = pgTable(
  "finding_runs",
  {
    /**
     * The run's id IS the public `generationId` the kickoff route
     * returns and the status endpoint echoes back.
     */
    id: uuid("id").defaultRandom().primaryKey(),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    /**
     * `pending` (kickoff inserted, engine still running) → `completed`
     * (engine settled successfully) | `failed` (engine threw). Stored
     * as text matching briefingGenerationJobs convention; the route
     * narrows it to the closed wire union.
     */
    state: text("state").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** Null while pending; stamped on the terminal transition. */
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Verbatim engine-failure message (route truncates if long). */
    error: text("error"),
    /**
     * Sum of citation tokens stripped across surviving findings —
     * lets the UI's status banner warn "the model emitted N
     * unresolved citations" without loading the full findings list.
     * Null while pending.
     */
    invalidCitationCount: integer("invalid_citation_count"),
    /**
     * Verbatim citation tokens stripped because their ids did not
     * resolve to a known atom (parallel of
     * briefingGenerationJobs.invalidCitations). The UI renders each
     * one as a "broken" pill in the run-detail panel. Length always
     * equals `invalidCitationCount` when both are set. Null while
     * pending and on the failed branch.
     */
    invalidCitations: text("invalid_citations").array(),
    /**
     * Count of findings the engine produced that were dropped
     * entirely (no valid citations + no elementRef + body too short
     * — see lib/finding-engine engine's discard rule using
     * FINDING_MIN_TEXT_LENGTH). Distinct from invalidCitationCount:
     * a finding with one stripped token can still survive if its
     * other tokens or its elementRef anchor it. Null while pending.
     */
    discardedFindingCount: integer("discarded_finding_count"),
  },
  (t) => ({
    /**
     * Status polls and single-flight checks both look up by
     * `submission_id` and want the most recent row first.
     */
    submissionStartedIdx: index(
      "finding_runs_submission_started_idx",
    ).on(t.submissionId, t.startedAt),
    /**
     * Single-flight guard — at most one row per submission may be in
     * `pending` at any time. Concurrent kickoffs map to HTTP 409 via
     * the route's PG 23505 catch.
     */
    pendingPerSubmissionUniq: uniqueIndex(
      "finding_runs_pending_per_submission_uniq",
    )
      .on(t.submissionId)
      .where(sql`${t.state} = 'pending'`),
  }),
);

export const findingRunsRelations = relations(findingRuns, ({ one }) => ({
  submission: one(submissions, {
    fields: [findingRuns.submissionId],
    references: [submissions.id],
  }),
}));

export type FindingRun = typeof findingRuns.$inferSelect;
export type NewFindingRun = typeof findingRuns.$inferInsert;
