import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { engagements } from "./engagements";

export type RecordsRequestJobStatus =
  | "queued"
  | "running"
  | "complete"
  | "failed"
  | "needs-human"
  | "awaiting-purchase-approval";

/** P-85 WDLL item 4 — Records Request async jobs (terrainJobWorker pattern). */
export const recordsRequestJobs = pgTable(
  "records_request_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" }),
    placeKey: text("place_key"),
    userId: text("user_id").notNull(),
    userEmail: text("user_email"),
    parcelKey: text("parcel_key").notNull(),
    countyFips: text("county_fips").notNull(),
    status: text("status").notNull().$type<RecordsRequestJobStatus>(),
    requestPayload: jsonb("request_payload"),
    scopeSearched: jsonb("scope_searched"),
    /** Item 2-3: live GIS query audit (layer urls, counts, feature ids). No landing. */
    liveInstantGis: jsonb("live_instant_gis"),
    runCost: jsonb("run_cost"),
    recipeVersion: text("recipe_version"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    engagementCreatedIdx: index(
      "records_request_jobs_engagement_created_idx",
    ).on(t.engagementId, t.createdAt),
    placeKeyIdx: index("records_request_jobs_place_key_idx").on(t.placeKey),
    statusIdx: index("records_request_jobs_status_idx").on(t.status),
    activePerEngagementUserUniq: uniqueIndex(
      "records_request_jobs_active_per_engagement_user_uniq",
    )
      .on(t.engagementId, t.userId)
      .where(
        sql`${t.status} in ('queued', 'running', 'awaiting-purchase-approval')`,
      ),
  }),
);

export const recordsRequestJobsRelations = relations(
  recordsRequestJobs,
  ({ one }) => ({
    engagement: one(engagements, {
      fields: [recordsRequestJobs.engagementId],
      references: [engagements.id],
    }),
  }),
);

export type RecordsRequestJob = typeof recordsRequestJobs.$inferSelect;
export type NewRecordsRequestJob = typeof recordsRequestJobs.$inferInsert;
