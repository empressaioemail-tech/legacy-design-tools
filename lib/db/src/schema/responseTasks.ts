import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { engagements } from "./engagements";

/**
 * L1 — `response-task` atom persistence (Cortex Lane C.4 / C.4.1).
 *
 * One row per response-task: the persistent task state for the
 * client-comment response flow. An architect receives client comments
 * on an engagement, opens response-tasks to track the work, and moves
 * them through `open → in-progress → done` (or `cancelled`) across
 * sessions.
 *
 * The row is the single source of truth for current state; the audit
 * chain (`response-task.opened` / `.progressed` / `.completed` /
 * `.cancelled`) lives on the `atom_events` table via the
 * `EventAnchoringService`, mirroring the rows-over-events convention
 * the `submission_classifications` table documents.
 *
 * The endpoint contract that consumes this table is
 * `doc_repo/_research/2026-05-19_l_surface_endpoint_contracts_cc-agent-M.md`
 * §L1; the atom shape is `RESPONSE_TASK_SCHEMA` in
 * `@workspace/atoms-l-surface`. The Base-atom fields
 * (`sourceAdapter` / `sourceUrl` / `contentHash` / `fetchedAt` /
 * `jurisdictionTenant`) are not stored — they are derived at read time
 * by the route's row→atom mapper (single-tenant; `contentHash` is a
 * deterministic hash of the domain fields).
 *
 * Linking columns are plain `text` (no FK): `finding_id` and
 * `source_client_comment_id` are cross-product atom entityIds, not
 * necessarily rows in this database, so referential integrity is not
 * enforced here — consistent with the atom's `string | null` typing.
 */

export const RESPONSE_TASK_STATE_VALUES = [
  "open",
  "in-progress",
  "done",
  "cancelled",
] as const;
export type ResponseTaskStateValue =
  (typeof RESPONSE_TASK_STATE_VALUES)[number];

export const responseTasks = pgTable(
  "response_tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /**
     * Engagement this task lives within. FK with `ON DELETE CASCADE` —
     * a deleted engagement takes its response-tasks with it. The atom
     * shape allows `engagementId: null` for rare standalone tasks, but
     * every task created through the contract route carries one (the
     * id is in the route path).
     */
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" }),
    /** Short human title displayed in lists + chips. */
    title: text("title").notNull(),
    /** Long-form description (may be empty for trivial tasks). */
    description: text("description").notNull().default(""),
    /** Current lifecycle state. Audit history lives on `atom_events`. */
    state: text("state").notNull().default("open"),
    /** ISO-8601 deadline. Null when no deadline is set. */
    dueAt: timestamp("due_at", { withTimezone: true }),
    /** Timestamp the task entered `done`. Cleared on any other state. */
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Linked client-comment atom entityId. Null for architect-authored. */
    sourceClientCommentId: text("source_client_comment_id"),
    /** Linked finding entityId. Null when not scoped to a finding. */
    findingId: text("finding_id"),
    /** Actor assigned execution (ADR-015). */
    actorId: text("actor_id"),
    /** Actor accountable; may differ from `actorId` for delegation. */
    principalActorId: text("principal_actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    /**
     * Drives the `GET /api/engagements/:id/response-tasks` listing
     * (filter by engagement, order by createdAt). Composite because
     * every list call filters by engagementId and orders by createdAt.
     */
    engagementCreatedIdx: index("response_tasks_engagement_created_idx").on(
      t.engagementId,
      t.createdAt,
    ),
    /**
     * Closed-set enforcement at the DB layer. Kept literal — the
     * drizzle CHECK builder cannot interpolate a TS array; keep in
     * lock-step with `RESPONSE_TASK_STATE_VALUES`.
     */
    stateCheck: check(
      "response_tasks_state_check",
      sql`${t.state} IN ('open', 'in-progress', 'done', 'cancelled')`,
    ),
  }),
);

export type ResponseTask = typeof responseTasks.$inferSelect;
export type NewResponseTask = typeof responseTasks.$inferInsert;
