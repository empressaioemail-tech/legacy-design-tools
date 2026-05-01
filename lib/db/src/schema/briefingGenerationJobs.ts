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
import { engagements } from "./engagements";
import { parcelBriefings } from "./parcelBriefings";

/**
 * A *briefing generation job* records one run (or attempted run) of the
 * briefing engine for an engagement (DA-PI-3 kickoff path).
 *
 * Why a real table instead of an in-process Map? The
 * `GET /briefing/status` endpoint must surface the most recent generation's
 * true outcome even after the api-server restarts mid-flight, and a
 * multi-instance deployment needs a coherent view across processes —
 * neither is possible if the job state is process-local.
 *
 * Identity: the row's `id` IS the `generationId` returned to the client on
 * kickoff. There is no separate column — using the PK as the public id
 * keeps the wire shape one round trip lighter and means a stale poll
 * with the old generationId can still find its row after subsequent runs.
 *
 * Single-flight: at most one row per `engagement_id` may be in `pending`
 * at any time. Enforced by the partial unique index
 * `briefing_generation_jobs_pending_per_engagement_uniq` so concurrent
 * kickoffs cannot both win — the loser sees a unique-violation and the
 * route maps that to a 409 with the in-flight job's id.
 *
 * History: terminal rows (`completed` / `failed`) are kept so a later
 * status poll always returns the most recent run's outcome (ordered by
 * `started_at DESC`). The table grows one row per generation request,
 * which is bounded by the architect-driven kickoff cadence; if it ever
 * needs reaping a future task can prune by age.
 *
 * `briefing_id` is a back-pointer to the parcel briefing row the run
 * targets. It is nullable strictly to satisfy the FK during the brief
 * window where a kickoff might race a briefing deletion (cascade is
 * `set null` so a deletion does not leave dangling jobs); the route
 * always supplies it on insert.
 */
export const briefingGenerationJobs = pgTable(
  "briefing_generation_jobs",
  {
    /**
     * The job's id IS the public `generationId` the kickoff route
     * returns and the status endpoint echoes back.
     */
    id: uuid("id").defaultRandom().primaryKey(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" }),
    briefingId: uuid("briefing_id").references(() => parcelBriefings.id, {
      onDelete: "set null",
    }),
    /**
     * `pending` (kickoff inserted, engine still running) → `completed`
     * (engine settled successfully) | `failed` (engine threw). Stored
     * as text to match the rest of this codebase's conversion-status
     * style; the route narrows it to the closed wire union.
     */
    state: text("state").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** Null while pending; stamped on the terminal transition. */
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Verbatim engine-failure message (truncated by the route if long). */
    error: text("error"),
    /**
     * Mirrors the engine's `invalidCitations.length` so the UI's status
     * banner can warn "the model emitted N unresolved citations" without
     * loading the full briefing payload. Null until the run completes.
     */
    invalidCitationCount: integer("invalid_citation_count"),
  },
  (t) => ({
    /**
     * Status polls and single-flight checks both look up by
     * `engagement_id` and want the most recent row first.
     */
    engagementStartedIdx: index(
      "briefing_generation_jobs_engagement_started_idx",
    ).on(t.engagementId, t.startedAt),
    /**
     * Single-flight guard — at most one row per engagement may be in
     * `pending` at any time. The route relies on this index to map a
     * concurrent kickoff into a 409 instead of running the engine twice.
     */
    pendingPerEngagementUniq: uniqueIndex(
      "briefing_generation_jobs_pending_per_engagement_uniq",
    )
      .on(t.engagementId)
      .where(sql`${t.state} = 'pending'`),
  }),
);

export const briefingGenerationJobsRelations = relations(
  briefingGenerationJobs,
  ({ one }) => ({
    engagement: one(engagements, {
      fields: [briefingGenerationJobs.engagementId],
      references: [engagements.id],
    }),
    briefing: one(parcelBriefings, {
      fields: [briefingGenerationJobs.briefingId],
      references: [parcelBriefings.id],
    }),
  }),
);

export type BriefingGenerationJob =
  typeof briefingGenerationJobs.$inferSelect;
export type NewBriefingGenerationJob =
  typeof briefingGenerationJobs.$inferInsert;
