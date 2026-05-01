import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { engagements } from "./engagements";

/**
 * A *parcel briefing* is the model-readable bundle of parcel facts +
 * cited code sections + sourced overlays that the briefing engine will
 * resolve for an engagement (Spec 51 §5 / Spec 51a §2.10). Identity is
 * eventually content-addressed (`parcel-briefing:{parcelId}:{intentHash}`),
 * but DA-PI-1B ships the row-level container that holds the cited
 * `briefing_sources` so the manual-QGIS upload path has somewhere to
 * land. The downstream briefing engine (DA-PI-3) will hang the parcel
 * facts and code-section citations off this same row.
 *
 * Per-engagement scoping: today an engagement has at most one parcel
 * briefing — the upload-on-first-upload pattern in
 * `routes/parcelBriefings.ts` ensures a single row per engagement. A
 * future sprint may relax this when intent-driven briefings (one per
 * design intent) land; for now the engagementId column is the
 * uniqueness key.
 */
export const parcelBriefings = pgTable(
  "parcel_briefings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" })
      .unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    engagementIdx: index("parcel_briefings_engagement_idx").on(t.engagementId),
  }),
);

export const parcelBriefingsRelations = relations(
  parcelBriefings,
  ({ one }) => ({
    engagement: one(engagements, {
      fields: [parcelBriefings.engagementId],
      references: [engagements.id],
    }),
  }),
);

export type ParcelBriefing = typeof parcelBriefings.$inferSelect;
export type NewParcelBriefing = typeof parcelBriefings.$inferInsert;
