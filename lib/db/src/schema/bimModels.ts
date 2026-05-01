import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { engagements } from "./engagements";
import { parcelBriefings } from "./parcelBriefings";

/**
 * A *bim-model* (DA-PI-5 / Spec 51a §2.1, Spec 53 §3) is the
 * design-tools-side record of the C# Revit add-in's view of an
 * engagement: which parcel briefing was last materialized into the
 * architect's active Revit model, when, and at what briefing version.
 *
 * Identity: one row per engagement (the C# side calls
 * `POST /api/engagements/:id/bim-model` idempotently — re-pushing a
 * briefing updates the existing row's `activeBriefingId` /
 * `materializedAt` / `briefingVersion` rather than inserting a new
 * one). The unique constraint on `engagement_id` enforces this at
 * the DB level so a race between two architects (or a retry burst)
 * cannot produce two competing rows.
 *
 * Mirrors the `parcel_briefings` shape: just enough columns to track
 * the materialization handshake plus an updated_at marker. The
 * connector-side binding tables (`revit_element_binding`) live in
 * the legacy-revit-sensor sprint and reference this row by id.
 *
 * `briefingVersion` is a monotonically-increasing integer the briefing
 * engine bumps every time it regenerates the briefing. The `refresh`
 * endpoint compares this against the current parcel-briefing's
 * `briefingVersion` (DA-PI-3) to decide whether the architect's model
 * is "Materialized at <ts> against briefing v<n>" (current) or
 * "Briefing has changed since last materialization" (stale). When the
 * row does not exist for an engagement, the UI shows "Not yet pushed
 * to Revit".
 */
export const bimModels = pgTable(
  "bim_models",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" })
      .unique(),
    /**
     * The parcel briefing that was materialized into the architect's
     * Revit model on the most recent push. Nullable because the C#
     * add-in may register a bim-model row for an engagement that has
     * no current briefing yet (the architect can ack the binding
     * before the briefing engine has produced a briefing).
     */
    activeBriefingId: uuid("active_briefing_id").references(
      () => parcelBriefings.id,
      { onDelete: "set null" },
    ),
    /**
     * Monotonic version stamp of the briefing at materialization time.
     * Compared to the parcel-briefing's current version on
     * `GET /api/bim-models/:id/refresh` to decide whether the
     * architect's model is current or stale. Defaults to 0 so a
     * never-pushed row is always considered stale once a briefing
     * has been generated (briefings start at version 1).
     */
    briefingVersion: integer("briefing_version").notNull().default(0),
    /**
     * Timestamp of the most recent successful push to Revit. Null
     * before the first push lands. Distinct from `updated_at` so the
     * refresh diff can render "Materialized at <ts>" without the
     * housekeeping write that bumps `updated_at`.
     */
    materializedAt: timestamp("materialized_at", { withTimezone: true }),
    /**
     * Free-text identifier of the Revit document the architect bound
     * to this bim-model. Captured for operator visibility — the
     * connector-binding atoms own the structured pointer.
     */
    revitDocumentPath: text("revit_document_path"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    engagementIdx: index("bim_models_engagement_idx").on(t.engagementId),
    activeBriefingIdx: index("bim_models_active_briefing_idx").on(
      t.activeBriefingId,
    ),
  }),
);

export const bimModelsRelations = relations(bimModels, ({ one }) => ({
  engagement: one(engagements, {
    fields: [bimModels.engagementId],
    references: [engagements.id],
  }),
  activeBriefing: one(parcelBriefings, {
    fields: [bimModels.activeBriefingId],
    references: [parcelBriefings.id],
  }),
}));

export type BimModel = typeof bimModels.$inferSelect;
export type NewBimModel = typeof bimModels.$inferInsert;
