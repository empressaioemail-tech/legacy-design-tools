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
 * land. The downstream briefing engine (DA-PI-3) hangs the section
 * narrative columns directly off this same row (`section_a` … `section_g`)
 * so the briefing is the atom — no separate narrative table.
 *
 * Per-engagement scoping: today an engagement has at most one parcel
 * briefing — the upload-on-first-upload pattern in
 * `routes/parcelBriefings.ts` ensures a single row per engagement. A
 * future sprint may relax this when intent-driven briefings (one per
 * design intent) land; for now the engagementId column is the
 * uniqueness key.
 *
 * DA-PI-3 — narrative columns:
 *   - `section_a` … `section_g`: the seven A–G section narrative bodies
 *     produced by the briefing engine. Free-form text containing inline
 *     atom-reference tokens (`{{atom|briefing-source|<id>|<label>}}` and
 *     `[[CODE:<atomId>]]`) — the renderer resolves those at read time.
 *     Null while the briefing has never been generated; the section is
 *     populated atomically (all seven columns + `generated_at` flip in
 *     a single transaction) so a partial generation never leaks.
 *   - `generated_at` / `generated_by`: when + by whom the current
 *     narrative was synthesized. `generated_by` carries the actor id
 *     (e.g. user uuid or `system:briefing-engine` for unattended runs).
 *   - `prior_*`: backup of the previous generation's columns, captured
 *     in the same transaction that overwrites the current narrative on
 *     re-generation. Lets the audit timeline reconstruct the prior
 *     version without loading the event chain. Null until the second
 *     generation runs (first generation has no prior).
 */
export const parcelBriefings = pgTable(
  "parcel_briefings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" })
      .unique(),
    sectionA: text("section_a"),
    sectionB: text("section_b"),
    sectionC: text("section_c"),
    sectionD: text("section_d"),
    sectionE: text("section_e"),
    sectionF: text("section_f"),
    sectionG: text("section_g"),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    generatedBy: text("generated_by"),
    priorSectionA: text("prior_section_a"),
    priorSectionB: text("prior_section_b"),
    priorSectionC: text("prior_section_c"),
    priorSectionD: text("prior_section_d"),
    priorSectionE: text("prior_section_e"),
    priorSectionF: text("prior_section_f"),
    priorSectionG: text("prior_section_g"),
    priorGeneratedAt: timestamp("prior_generated_at", { withTimezone: true }),
    priorGeneratedBy: text("prior_generated_by"),
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
