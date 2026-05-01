import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { bimModels } from "./bimModels";
import { materializableElements } from "./materializableElements";
import { parcelBriefings } from "./parcelBriefings";

/**
 * The reason buckets the C# Revit add-in is allowed to record when
 * the architect modifies a locked element. Mirrors Spec 51a §2.2:
 * `unpinned` (the architect literally unpinned the element to move
 * it), `geometry-edited` (a vertex was nudged inside the locked
 * mass), `deleted` (the element was removed from the model), and
 * `other` (catch-all for engine-side detections we have not
 * categorized).
 */
export const BRIEFING_DIVERGENCE_REASONS = [
  "unpinned",
  "geometry-edited",
  "deleted",
  "other",
] as const;

export type BriefingDivergenceReason =
  (typeof BRIEFING_DIVERGENCE_REASONS)[number];

/**
 * A *briefing-divergence* (DA-PI-5 / Spec 51a §2.2) is the audit-
 * trail row produced when an architect modifies a locked
 * materializable element in Revit. The C# add-in calls
 * `POST /api/bim-models/:id/divergence` whenever its element-watcher
 * detects an unpin / geometry edit / deletion against a locked
 * element; this table is what design-tools reads back when surfacing
 * "the architect overrode the briefing here" badges.
 *
 * Compositionally a divergence is owned by the bim-model, points at
 * the materializable-element it diverged from, and references the
 * briefing version it was diverging against. All three are required:
 * a divergence with no anchor would be untraceable, defeating the
 * audit-trail point.
 *
 * The row is append-only — there is no update path. A subsequent
 * "the architect re-pinned the element" signal lands as a separate
 * row (with the matching reason bucket) so the chain preserves the
 * full back-and-forth.
 */
export const briefingDivergences = pgTable(
  "briefing_divergences",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    bimModelId: uuid("bim_model_id")
      .notNull()
      .references(() => bimModels.id, { onDelete: "cascade" }),
    materializableElementId: uuid("materializable_element_id")
      .notNull()
      .references(() => materializableElements.id, { onDelete: "cascade" }),
    /**
     * The briefing the divergence is being measured against. Captured
     * explicitly (rather than walked through bim-model) so the row
     * stays meaningful after a re-materialization swaps the bim-
     * model's `activeBriefingId`.
     */
    briefingId: uuid("briefing_id")
      .notNull()
      .references(() => parcelBriefings.id, { onDelete: "cascade" }),
    /**
     * One of {@link BRIEFING_DIVERGENCE_REASONS}. The route layer
     * validates against the closed tuple before insert.
     */
    reason: text("reason").notNull(),
    /**
     * Optional architect-supplied note explaining the divergence
     * (e.g. "moved property line to match surveyor's mark-up").
     */
    note: text("note"),
    /**
     * Free-form bag the C# side may attach to the divergence —
     * before/after geometry digests, the Revit element id that
     * fired the trigger, etc. Defaults to `{}` so a minimal divergence
     * (just the reason bucket) is valid.
     */
    detail: jsonb("detail").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    bimModelIdx: index("briefing_divergences_bim_model_idx").on(t.bimModelId),
    elementIdx: index("briefing_divergences_element_idx").on(
      t.materializableElementId,
    ),
    briefingIdx: index("briefing_divergences_briefing_idx").on(t.briefingId),
  }),
);

export const briefingDivergencesRelations = relations(
  briefingDivergences,
  ({ one }) => ({
    bimModel: one(bimModels, {
      fields: [briefingDivergences.bimModelId],
      references: [bimModels.id],
    }),
    materializableElement: one(materializableElements, {
      fields: [briefingDivergences.materializableElementId],
      references: [materializableElements.id],
    }),
    briefing: one(parcelBriefings, {
      fields: [briefingDivergences.briefingId],
      references: [parcelBriefings.id],
    }),
  }),
);

export type BriefingDivergence = typeof briefingDivergences.$inferSelect;
export type NewBriefingDivergence = typeof briefingDivergences.$inferInsert;
