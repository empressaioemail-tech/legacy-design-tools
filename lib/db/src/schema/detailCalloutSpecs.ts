import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { engagements } from "./engagements";

/**
 * L4 — `detail-callout-spec` atom persistence (Cortex Lane C.4 / C.4.4).
 *
 * One row per detail-callout spec: a structured spec for a Revit detail
 * callout the Revit Connector pushes via APS Design Automation.
 *
 * The `spec` JSONB column carries the discriminated-union payload keyed
 * on `detailType` (`door-schedule` / `wall-section` / `wall-type` /
 * `room-finish`). The route validates it against the engine
 * `DETAIL_CALLOUT_SPEC_PAYLOAD_SCHEMA` before persisting.
 *
 * Push lifecycle (`push_state`): `pending → pushed → applied |
 * rejected-by-user`; `applied` is terminal; `rejected-by-user →
 * pending` is allowed (revise + re-push). The engine
 * `isLegalPushTransition()` helper is the source of truth.
 *
 * Endpoint contract:
 * `doc_repo/_research/2026-05-19_l_surface_endpoint_contracts_cc-agent-M.md`
 * §L4. Atom shape: `DETAIL_CALLOUT_SPEC_SCHEMA` in
 * `@workspace/atoms-l-surface`.
 */

export const DETAIL_CALLOUT_PUSH_STATE_VALUES = [
  "pending",
  "pushed",
  "applied",
  "rejected-by-user",
] as const;
export type DetailCalloutPushStateValue =
  (typeof DETAIL_CALLOUT_PUSH_STATE_VALUES)[number];

export const detailCalloutSpecs = pgTable(
  "detail_callout_specs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" }),
    /** Discriminated spec payload (`{ detailType, ...type-specific }`). */
    spec: jsonb("spec").notNull(),
    /** Push lifecycle state. */
    pushState: text("push_state").notNull().default("pending"),
    /**
     * APS Design Automation work-item ref. Opaque; the Revit Connector
     * populates it once `push_state` reaches `pushed`. Null while pending.
     */
    apsTaskRef: text("aps_task_ref"),
    /** Source finding entityId. Null if not finding-driven. */
    findingId: text("finding_id"),
    /** Source response-task entityId. Null if not task-driven. */
    responseTaskId: text("response_task_id"),
    /** Architect / staff member who authored the callout spec (ADR-015). */
    actorId: text("actor_id"),
    /** Actor accountable; may differ from `actorId` for delegation. */
    principalActorId: text("principal_actor_id"),
    /** Timestamp the spec entered `pushed`. Null otherwise. */
    pushedAt: timestamp("pushed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    engagementCreatedIdx: index("detail_callout_specs_engagement_created_idx").on(
      t.engagementId,
      t.createdAt,
    ),
    /**
     * Closed-set enforcement at the DB layer. Kept literal — the
     * drizzle CHECK builder cannot interpolate a TS array; keep in
     * lock-step with `DETAIL_CALLOUT_PUSH_STATE_VALUES`.
     */
    pushStateCheck: check(
      "detail_callout_specs_push_state_check",
      sql`${t.pushState} IN ('pending', 'pushed', 'applied', 'rejected-by-user')`,
    ),
  }),
);

export type DetailCalloutSpec = typeof detailCalloutSpecs.$inferSelect;
export type NewDetailCalloutSpec = typeof detailCalloutSpecs.$inferInsert;
